import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { NotificationDefinitions } from "../src/core/definition";
import { easyPing } from "../src/core/instance";
import type { Recipient } from "../src/core/types";
import { type PushMessage, type PushSendResult, push } from "../src/plugins/push";
import { renderPostgresDdl } from "../src/schema/render-sql";
import { createTestDatabase, postgresReachable, type TestDatabase } from "./helpers/pg";

const CRON = "cron-secret";
const BASE = "/api/notifications";

const definitions = {
  ping: { channels: ["push"] },
  both: { channels: ["inApp", "push"] },
} satisfies NotificationDefinitions;

const recipient = (userId: string): Recipient => ({
  userId,
  email: `${userId}@x.dev`,
  timezone: "UTC",
  locale: "en",
});

let db: TestDatabase;
const available = await postgresReachable();

let outbox: PushMessage[] = [];
let behaviour: (message: PushMessage) => PushSendResult = () => ({});
let warnings: string[] = [];

const provider = {
  name: "fake-push",
  send: async (message: PushMessage) => {
    outbox.push(message);
    return behaviour(message);
  },
};

function build() {
  return easyPing({
    database: db.adapter,
    secret: "s",
    cron: { secret: CRON },
    session: { getUserId: async (request) => request.headers.get("x-user") },
    getRecipients: async (ids) => ids.map(recipient),
    notifications: definitions,
    channels: { inApp: { enabled: true } },
    delivery: { mode: "cron" },
    logger: { warn: (m) => void warnings.push(m), error: () => {} },
    plugins: [
      push({
        provider,
        render: ({ type }) => ({ title: "New", body: `a ${type}` }),
      }),
    ],
  });
}

const post = (path: string, body: unknown, userId = "u1") =>
  new Request(`https://app.dev${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-user": userId },
    body: JSON.stringify(body),
  });

const subscription = (endpoint: string) => ({
  endpoint,
  keys: { p256dh: "key-p256", auth: "key-auth" },
});

const runCron = (notify: ReturnType<typeof build>) =>
  notify.handler.POST(
    new Request(`https://app.dev${BASE}/cron`, {
      method: "POST",
      headers: { authorization: `Bearer ${CRON}` },
    }),
  );

const devices = () => db.client.unsafe("SELECT * FROM notification_push_device");

describe.skipIf(!available)("push plugin", () => {
  beforeAll(async () => {
    db = await createTestDatabase("push");
    const plugin = push({ provider, render: () => ({ title: "", body: "" }) });
    for (const statement of renderPostgresDdl(plugin.schema ?? {})) {
      await db.client.unsafe(statement);
    }
  });

  afterAll(async () => {
    await db.end();
  });

  beforeEach(async () => {
    await db.truncate();
    await db.client.unsafe("TRUNCATE notification_push_device");
    outbox = [];
    warnings = [];
    behaviour = () => ({});
  });

  describe("channel availability", () => {
    it("makes push usable, so no startup warning fires", () => {
      build();
      // Without a plugin claiming the channel this warns "can never be delivered".
      expect(warnings).toEqual([]);
    });

    it("creates a push delivery row", async () => {
      const notify = build();
      await notify.handler.POST(post("/push/devices", subscription("https://push.example/a")));

      const result = await notify.send("ping", { to: "u1", payload: {} });
      expect(result.notifications[0]?.deliveries.map((d) => d.channel)).toEqual(["push"]);
    });
  });

  describe("registration", () => {
    it("registers a device against the session user", async () => {
      const notify = build();
      const response = await notify.handler.POST(
        post("/push/devices", subscription("https://push.example/a")),
      );

      expect(response.status).toBe(200);
      const rows = await devices();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.user_id).toBe("u1");
    });

    it("re-registering the same endpoint updates rather than duplicating", async () => {
      const notify = build();
      await notify.handler.POST(post("/push/devices", subscription("https://push.example/a")));
      await notify.handler.POST(post("/push/devices", subscription("https://push.example/a")));

      // A duplicate row would push the same device twice per notification.
      expect(await devices()).toHaveLength(1);
    });

    it("rejects a subscription missing its keys", async () => {
      const response = await build().handler.POST(
        post("/push/devices", { endpoint: "https://push.example/a" }),
      );
      expect(response.status).toBe(400);
    });

    it("will not let one user unregister another's device", async () => {
      const notify = build();
      await notify.handler.POST(post("/push/devices", subscription("https://push.example/a")));

      // An endpoint string is not a secret.
      const response = await notify.handler.POST(
        post("/push/devices/remove", { endpoint: "https://push.example/a" }, "attacker"),
      );

      expect(response.status).toBe(404);
      expect(await devices()).toHaveLength(1);
    });

    it("lets the owner unregister", async () => {
      const notify = build();
      await notify.handler.POST(post("/push/devices", subscription("https://push.example/a")));
      await notify.handler.POST(
        post("/push/devices/remove", { endpoint: "https://push.example/a" }),
      );

      expect(await devices()).toHaveLength(0);
    });
  });

  describe("delivery", () => {
    const register = async (notify: ReturnType<typeof build>, ...endpoints: string[]) => {
      for (const endpoint of endpoints) {
        await notify.handler.POST(post("/push/devices", subscription(endpoint)));
      }
    };

    it("fans out to every device the user has", async () => {
      const notify = build();
      await register(notify, "https://push.example/a", "https://push.example/b");

      await notify.send("ping", { to: "u1", payload: {} });
      expect(await (await runCron(notify)).json()).toMatchObject({ sent: 1 });

      expect(outbox.map((m) => m.subscription.endpoint).sort()).toEqual([
        "https://push.example/a",
        "https://push.example/b",
      ]);
    });

    it("succeeds when any one device accepts", async () => {
      const notify = build();
      await register(notify, "https://push.example/a", "https://push.example/b");
      behaviour = (m) =>
        m.subscription.endpoint.endsWith("/a") ? { expired: true } : ({} as PushSendResult);

      await notify.send("ping", { to: "u1", payload: {} });
      expect(await (await runCron(notify)).json()).toMatchObject({ sent: 1, failed: 0 });
    });

    it("prunes an endpoint the provider reports as gone", async () => {
      const notify = build();
      await register(notify, "https://push.example/a", "https://push.example/b");
      behaviour = (m) => (m.subscription.endpoint.endsWith("/a") ? { expired: true } : {});

      await notify.send("ping", { to: "u1", payload: {} });
      await runCron(notify);

      // An unpruned registry accumulates dead subscriptions forever.
      const rows = await devices();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.endpoint).toBe("https://push.example/b");
    });

    it("fails without retrying when every device is gone", async () => {
      const notify = build();
      await register(notify, "https://push.example/a");
      behaviour = () => ({ expired: true });

      await notify.send("ping", { to: "u1", payload: {} });
      expect(await (await runCron(notify)).json()).toMatchObject({ sent: 0, failed: 1 });

      const failed = await db.adapter.getFailedDeliveries({
        since: new Date(Date.now() - 60_000),
        limit: 10,
      });
      // Retrying a deleted subscription cannot succeed.
      expect(failed[0]?.lastError).toContain("expired");
      expect(failed[0]?.attempts).toBe(1);
    });

    it("fails without retrying when the user has no devices", async () => {
      const notify = build();
      await notify.send("ping", { to: "u1", payload: {} });
      await runCron(notify);

      const failed = await db.adapter.getFailedDeliveries({
        since: new Date(Date.now() - 60_000),
        limit: 10,
      });
      expect(failed[0]?.lastError).toContain("no registered devices");
    });

    it("carries the rendered content and the notification id", async () => {
      const notify = build();
      await register(notify, "https://push.example/a");

      const sent = await notify.send("ping", { to: "u1", payload: { x: 1 } });
      await runCron(notify);

      expect(outbox[0]).toMatchObject({ title: "New", body: "a ping" });
      expect(outbox[0]?.data).toMatchObject({ notificationId: sent.notifications[0]?.id });
    });

    it("does not hold up in-app delivery when push fails", async () => {
      const notify = build();
      behaviour = () => {
        throw new Error("provider down");
      };

      await notify.send("both", { to: "u1", payload: {} });
      const result = (await (await runCron(notify)).json()) as { sent: number; failed: number };

      // inApp lands; push is retried independently.
      expect(result.sent).toBe(1);
      expect(result.failed).toBe(1);
      expect(await db.adapter.countUnseen("u1")).toBe(1);
    });
  });

  describe("pruning", () => {
    it("removes devices unseen past the cutoff", async () => {
      const notify = build();
      await notify.handler.POST(post("/push/devices", subscription("https://push.example/old")));
      await db.client.unsafe(
        "UPDATE notification_push_device SET last_seen_at = now() - interval '400 days'",
      );

      const response = await notify.handler.POST(
        new Request(`https://app.dev${BASE}/push/prune`, {
          method: "POST",
          headers: { authorization: `Bearer ${CRON}` },
        }),
      );

      expect(await response.json()).toEqual({ removed: 1 });
      expect(await devices()).toHaveLength(0);
    });

    it("refuses the prune route without the machine secret", async () => {
      const response = await build().handler.POST(
        new Request(`https://app.dev${BASE}/push/prune`, { method: "POST" }),
      );
      expect(response.status).toBe(401);
    });
  });
});
