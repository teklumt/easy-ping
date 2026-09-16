import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { NotificationDefinitions } from "../src/core/definition";
import { easyNotify } from "../src/core/instance";
import type { Recipient } from "../src/core/types";
import { push } from "../src/plugins/push";
import { generateVapidKeys, webPush } from "../src/providers/web-push";
import { availableBackends, type Backend, type BackendFactory } from "./helpers/backends";
import {
  createSubscriber,
  decryptAsBrowser,
  type Subscriber,
  verifyVapidHeader,
} from "./helpers/web-push";

/**
 * Push through the whole stack: send() to runner to plugin to provider to a
 * real HTTP POST, decrypted by the receiver.
 *
 * The unit tests cover each link. This covers the joins, which is where
 * plumbing errors live: a header dropped by the runner, a body mangled between
 * provider and socket, an endpoint the plugin stored wrong.
 *
 * Run against every reachable backend: the device registry goes through the
 * plugin store, which is where the SQL and document dialects diverge.
 *
 * Left unproven: a real FCM or autopush endpoint, which needs a browser.
 */

type Received = {
  path: string;
  headers: Record<string, string>;
  body: Uint8Array<ArrayBuffer>;
};

const definitions = { alert: { channels: ["push"] } } satisfies NotificationDefinitions;

const recipient = (userId: string): Recipient => ({
  userId,
  email: `${userId}@x.dev`,
  timezone: "UTC",
  locale: "en",
});

let db: Backend;
let service: Server;
let origin: string;
let received: Received[] = [];
let responseStatus = 201;

describe.each(availableBackends.map((b) => [b.name, b] as const))(
  "push end to end (%s)",
  (name, backend: BackendFactory) => {
    beforeAll(async () => {
      db = await backend.create(`pushe2e_${name}`);

      const schema = push({
        provider: { name: "x", send: async () => ({}) },
        render: () => ({ title: "", body: "" }),
      }).schema;

      await db.applySchema(schema ?? {});

      // Stands in for FCM: accepts the POST and keeps it for inspection.
      service = createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
          received.push({
            path: req.url ?? "/",
            headers: Object.fromEntries(
              Object.entries(req.headers).map(([key, value]) => [key, String(value)]),
            ),
            body: new Uint8Array(Buffer.concat(chunks)),
          });
          res.writeHead(responseStatus).end();
        });
      });

      await new Promise<void>((resolve) => service.listen(0, "127.0.0.1", resolve));
      origin = `http://127.0.0.1:${(service.address() as AddressInfo).port}`;
    });

    afterAll(async () => {
      await new Promise<void>((resolve) => service.close(() => resolve()));
      await db.end();
    });

    beforeEach(async () => {
      await db.truncate();
      received = [];
      responseStatus = 201;
    });

    async function build() {
      const vapid = await generateVapidKeys();
      return easyNotify({
        database: db.adapter,
        secret: "s",
        cron: { secret: "c" },
        session: { getUserId: async (request) => request.headers.get("x-user") },
        getRecipients: async (ids) => ids.map(recipient),
        notifications: definitions,
        channels: { inApp: { enabled: false } },
        // Delivered before send() resolves, so assertions need no polling.
        delivery: { mode: "inline" },
        logger: { warn: () => {}, error: () => {} },
        plugins: [
          push({
            provider: webPush({ subject: "mailto:ops@acme.dev", vapid }),
            render: ({ payload }) => payload as { title: string; body: string },
          }),
        ],
      });
    }

    const register = (notify: Awaited<ReturnType<typeof build>>, sub: Subscriber) =>
      notify.handler.POST(
        new Request("https://app.dev/api/notifications/push/devices", {
          method: "POST",
          headers: { "content-type": "application/json", "x-user": "alice" },
          body: JSON.stringify(sub.subscription),
        }),
      );

    const devices = () => db.rows("notification_push_device");

    it("delivers an encrypted push the receiver can decrypt", async () => {
      const notify = await build();
      const subscriber = await createSubscriber(`${origin}/push/alice-device`);
      expect((await register(notify, subscriber)).status).toBe(200);

      const result = await notify.send("alert", {
        to: "alice",
        payload: { title: "Deploy finished", body: "main is live" },
      });
      expect(result.notifications).toHaveLength(1);
      expect(received).toHaveLength(1);

      const request = received[0];
      if (!request) throw new Error("the push service received nothing");

      expect(request.path).toBe("/push/alice-device");
      expect(request.headers["content-encoding"]).toBe("aes128gcm");
      expect(request.headers["content-type"]).toBe("application/octet-stream");
      expect(Number(request.headers.ttl)).toBeGreaterThan(0);

      // What the browser would hand to showNotification.
      const plaintext = JSON.parse(await decryptAsBrowser(request.body, subscriber));
      expect(plaintext).toMatchObject({ title: "Deploy finished", body: "main is live" });
      expect(plaintext.data.notificationId).toBe(result.notifications[0]?.id);
    });

    it("sends a VAPID header the push service can verify", async () => {
      const notify = await build();
      const subscriber = await createSubscriber(`${origin}/push/alice-device`);
      await register(notify, subscriber);

      await notify.send("alert", { to: "alice", payload: { title: "t", body: "b" } });

      // Throws on a bad signature or an audience that is not this origin.
      const claims = await verifyVapidHeader(received[0]?.headers.authorization ?? "", origin);
      expect(claims.sub).toBe("mailto:ops@acme.dev");
    });

    it("fans out to every registered device", async () => {
      const notify = await build();
      const first = await createSubscriber(`${origin}/push/one`);
      const second = await createSubscriber(`${origin}/push/two`);
      await register(notify, first);
      await register(notify, second);

      await notify.send("alert", { to: "alice", payload: { title: "t", body: "b" } });

      expect(received.map((entry) => entry.path).sort()).toEqual(["/push/one", "/push/two"]);

      // Each device gets a body only its own key opens.
      const forFirst = received.find((entry) => entry.path === "/push/one");
      if (!forFirst) throw new Error("no push for the first device");
      expect(JSON.parse(await decryptAsBrowser(forFirst.body, first))).toMatchObject({
        title: "t",
      });
    });

    it("prunes a device the service reports as gone", async () => {
      const notify = await build();
      await register(notify, await createSubscriber(`${origin}/push/stale`));

      responseStatus = 410;
      await notify.send("alert", { to: "alice", payload: { title: "t", body: "b" } });

      expect(await devices()).toHaveLength(0);
    });

    it("retries a throttled device without pruning it", async () => {
      const notify = await build();
      await register(notify, await createSubscriber(`${origin}/push/busy`));

      responseStatus = 429;
      await notify.send("alert", { to: "alice", payload: { title: "t", body: "b" } });

      expect(await devices()).toHaveLength(1);
      const failed = await db.adapter.getFailedDeliveries({
        since: new Date(Date.now() - 60_000),
        limit: 10,
      });
      expect(failed).toHaveLength(0);
    });

    it("produces a different ciphertext per send, even for identical content", async () => {
      const notify = await build();
      await register(notify, await createSubscriber(`${origin}/push/repeat`));

      const payload = { title: "same", body: "same" };
      await notify.send("alert", { to: "alice", payload });
      await notify.send("alert", { to: "alice", payload });

      expect(received).toHaveLength(2);

      // A repeated salt and key under AES-GCM leaks the plaintext.
      const [first, second] = received;
      if (!first || !second) throw new Error("expected two pushes");
      expect(Buffer.from(first.body).toString("hex")).not.toBe(
        Buffer.from(second.body).toString("hex"),
      );
    });
  },
);
