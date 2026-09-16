import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createNotifyClient } from "../src/client";
import type { NotificationDefinitions } from "../src/core/definition";
import { easyNotify } from "../src/core/instance";
import type { Recipient } from "../src/core/types";
import { toNodeHandler } from "../src/node";
import { buildUnsubscribeToken, preferences } from "../src/plugins/preferences";
import { availableBackends, type Backend, type BackendFactory } from "./helpers/backends";
import { waitUntil } from "./helpers/wait";

/**
 * Everything except email, exercised over a real socket.
 *
 * The other suites call handler.GET(new Request(...)) in-process, which never
 * touches serialisation, header casing, status codes on the wire, or the
 * client's own fetch. This one starts a server, points the real client at it,
 * and asserts against live Postgres.
 */

const SECRET = "e2e-signing-secret";
const CRON_SECRET = "e2e-cron-secret";

const definitions = {
  commentReply: { channels: ["inApp"] },
  invoicePaid: { channels: ["inApp"] },
} satisfies NotificationDefinitions;

const recipient = (userId: string): Recipient => ({
  userId,
  email: `${userId}@x.dev`,
  timezone: "UTC",
  locale: "en",
});

const silent = { warn: () => {}, error: () => {} };

let db: Backend;
let server: Server;
let origin: string;
let notify: ReturnType<typeof build>;

function build() {
  return easyNotify({
    database: db.adapter,
    secret: SECRET,
    cron: { secret: CRON_SECRET },
    // Reads a header so the test can act as different users over real HTTP.
    session: { getUserId: async (request) => request.headers.get("x-user") },
    getRecipients: async (ids) => ids.map(recipient),
    notifications: definitions,
    channels: { inApp: { enabled: true } },
    delivery: { mode: "cron" },
    logger: silent,
    plugins: [preferences()],
  });
}

/** A client whose fetch authenticates as a given user. */
const clientFor = (userId: string) =>
  createNotifyClient({
    baseUrl: `${origin}/api/notifications`,
    pollIntervalMs: 50,
    isDocumentHidden: () => false,
    fetch: (input, init) =>
      globalThis.fetch(input, {
        ...init,
        headers: { ...(init?.headers as Record<string, string>), "x-user": userId },
      }),
  });

const call = (path: string, init?: RequestInit) =>
  globalThis.fetch(`${origin}/api/notifications${path}`, init);

describe.each(availableBackends.map((b) => [b.name, b] as const))(
  "end-to-end over real HTTP (%s)",
  (name, backend: BackendFactory) => {
    beforeAll(async () => {
      db = await backend.create(`e2e_${name}`);
      notify = build();

      const handler = toNodeHandler(notify.handler.handle);
      server = createServer((req, res) => void handler(req, res));

      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    afterAll(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await db.end();
    });

    beforeEach(async () => {
      await db.truncate();
    });

    it("rejects an unauthenticated request", async () => {
      expect((await call("/")).status).toBe(401);
    });

    it("delivers a notification the client can read back", async () => {
      await notify.send("commentReply", { to: "alice", payload: { authorName: "Dana" } });

      const client = clientFor("alice");
      const unsubscribe = client.subscribe(() => {});
      await waitUntil(() => client.getState().notifications.length === 1);

      const state = client.getState();
      expect(state.notifications).toHaveLength(1);
      expect(state.notifications[0]?.type).toBe("commentReply");
      expect(state.unseenCount).toBe(1);
      expect(state.unreadCount).toBe(1);
      unsubscribe();
    });

    it("never leaks another user's notifications across the wire", async () => {
      await notify.send("commentReply", { to: "bob", payload: {} });

      const client = clientFor("alice");
      const unsubscribe = client.subscribe(() => {});
      await waitUntil(() => client.getState().isLoading === false);

      expect(client.getState().notifications).toHaveLength(0);
      expect(client.getState().unseenCount).toBe(0);
      unsubscribe();
    });

    it("clears the badge but leaves items unread, and persists both", async () => {
      await notify.send("commentReply", { to: "alice", payload: {} });

      const client = clientFor("alice");
      const unsubscribe = client.subscribe(() => {});
      await waitUntil(() => client.getState().notifications.length === 1);

      await client.markSeen();
      expect(client.getState().unseenCount).toBe(0);
      // seen and read are separate: the badge clears, the item stays bold.
      expect(client.getState().unreadCount).toBe(1);
      expect(await db.adapter.countUnseen("alice")).toBe(0);

      const id = client.getState().notifications[0]?.id;
      if (!id) throw new Error("no notification");
      await client.markAsRead(id);

      const page = await db.adapter.listNotifications({ userId: "alice", limit: 10 });
      expect(page.notifications[0]?.readAt).not.toBeNull();
      unsubscribe();
    });

    it("404s when marking a notification belonging to someone else", async () => {
      const sent = await notify.send("commentReply", { to: "bob", payload: {} });

      const response = await call("/read", {
        method: "POST",
        headers: { "content-type": "application/json", "x-user": "alice" },
        body: JSON.stringify({ ids: [sent.notifications[0]?.id] }),
      });

      expect(response.status).toBe(404);
      const page = await db.adapter.listNotifications({ userId: "bob", limit: 10 });
      expect(page.notifications[0]?.readAt).toBeNull();
    });

    it("paginates with a real cursor across requests", async () => {
      for (let i = 0; i < 5; i += 1) {
        await notify.send("invoicePaid", { to: "alice", payload: { n: i } });
      }

      const first = await call("/?limit=2", { headers: { "x-user": "alice" } });
      const firstPage = (await first.json()) as { notifications: unknown[]; nextCursor: string };
      expect(firstPage.notifications).toHaveLength(2);
      expect(firstPage.nextCursor).toBeTruthy();

      const second = await call(`/?limit=2&cursor=${encodeURIComponent(firstPage.nextCursor)}`, {
        headers: { "x-user": "alice" },
      });
      const secondPage = (await second.json()) as { notifications: { id: string }[] };

      const firstIds = new Set((firstPage.notifications as { id: string }[]).map((n) => n.id));
      expect(secondPage.notifications.some((n) => firstIds.has(n.id))).toBe(false);
    });

    it("loadMore appends the next page through the client", async () => {
      for (let i = 0; i < 5; i += 1) {
        await notify.send("invoicePaid", { to: "alice", payload: { n: i } });
      }

      const client = createNotifyClient({
        baseUrl: `${origin}/api/notifications`,
        limit: 2,
        isDocumentHidden: () => false,
        fetch: (input, init) =>
          globalThis.fetch(input, {
            ...init,
            headers: { ...(init?.headers as Record<string, string>), "x-user": "alice" },
          }),
      });

      const unsubscribe = client.subscribe(() => {});
      await waitUntil(() => client.getState().notifications.length === 2);

      await client.loadMore();
      expect(client.getState().notifications).toHaveLength(4);
      unsubscribe();
    });

    describe("cron over the wire", () => {
      it("401s without the secret", async () => {
        expect((await call("/cron", { method: "POST" })).status).toBe(401);
      });

      it("401s with a wrong secret and delivers nothing", async () => {
        await notify.send("commentReply", { to: "alice", payload: {} });

        const response = await call("/cron", {
          method: "POST",
          headers: { authorization: "Bearer wrong" },
        });
        expect(response.status).toBe(401);
      });

      it("drains with the correct secret and no session", async () => {
        await notify.send("commentReply", { to: "alice", payload: {} });

        const response = await call("/cron", {
          method: "POST",
          headers: { authorization: `Bearer ${CRON_SECRET}` },
        });

        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ claimed: 1, sent: 1 });
      });
    });

    describe("preferences over the wire", () => {
      it("round-trips a preference and applies it to the next send", async () => {
        const update = await call("/preferences", {
          method: "POST",
          headers: { "content-type": "application/json", "x-user": "alice" },
          body: JSON.stringify({ type: "commentReply", channel: "inApp", enabled: false }),
        });
        expect(update.status).toBe(200);

        const read = await call("/preferences", { headers: { "x-user": "alice" } });
        const body = (await read.json()) as { preferences: { enabled: boolean }[] };
        expect(body.preferences[0]?.enabled).toBe(false);

        const result = await notify.send("commentReply", { to: "alice", payload: {} });
        expect(result.notifications).toHaveLength(0);
        expect(result.skipped).toEqual([{ userId: "alice", reason: "no-channels" }]);
      });

      it("one-click unsubscribes with no session header at all", async () => {
        const token = await buildUnsubscribeToken(SECRET, "alice", "commentReply", "inApp");

        // Deliberately no x-user: this is a mail client, not a logged-in browser.
        const response = await call(`/unsubscribe?token=${encodeURIComponent(token)}`, {
          method: "POST",
        });

        expect(response.status).toBe(200);
        const result = await notify.send("commentReply", { to: "alice", payload: {} });
        expect(result.notifications).toHaveLength(0);
      });

      it("400s a forged unsubscribe token and changes nothing", async () => {
        const forged = await buildUnsubscribeToken(
          "wrong-secret",
          "alice",
          "commentReply",
          "inApp",
        );

        const response = await call(`/unsubscribe?token=${encodeURIComponent(forged)}`, {
          method: "POST",
        });

        expect(response.status).toBe(400);
        const result = await notify.send("commentReply", { to: "alice", payload: {} });
        expect(result.notifications).toHaveLength(1);
      });
    });

    it("survives a fan-out and delivers every recipient exactly once", async () => {
      const users = Array.from({ length: 25 }, (_, i) => `user${i}`);
      await notify.send("invoicePaid", { to: users, payload: { amount: 100 } });

      const response = await call("/cron", {
        method: "POST",
        headers: { authorization: `Bearer ${CRON_SECRET}` },
      });
      expect(await response.json()).toMatchObject({ claimed: 25, sent: 25, failed: 0 });

      const failed = await db.adapter.getFailedDeliveries({
        since: new Date(Date.now() - 60_000),
        limit: 100,
      });
      expect(failed).toHaveLength(0);

      for (const user of users) expect(await db.adapter.countUnseen(user)).toBe(1);
    });

    it("dedupes a double-submitted send across two HTTP-visible calls", async () => {
      const args = { to: "alice", payload: {}, dedupeKey: "invoice:42" } as const;

      await notify.send("invoicePaid", args);
      const second = await notify.send("invoicePaid", args);

      expect(second.notifications).toHaveLength(0);
      expect(await db.adapter.countUnseen("alice")).toBe(1);
    });
  },
);
