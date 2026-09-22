import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { encodeBase64Url } from "../src/core/base64url";
import type { EasyPingConfig } from "../src/core/config";
import type { NotificationDefinitions } from "../src/core/definition";
import { ConfigError } from "../src/core/errors";
import { escapeHtml } from "../src/core/html";
import { easyPing } from "../src/core/instance";
import type { SchemaDeclaration } from "../src/core/plugin";
import { redactErrorMessage } from "../src/core/runner";
import { createPluginStore } from "../src/core/store";
import { expiresIn, MAX_TOKEN_TTL_SECONDS, signToken, verifyToken } from "../src/core/tokens";
import type { Recipient } from "../src/core/types";
import { toNodeHandler } from "../src/node";
import { preferences } from "../src/plugins/preferences";
import {
  type PushMessage,
  type PushOptions,
  type PushSendResult,
  push,
  pushSchema,
} from "../src/plugins/push";
import { renderPostgresDdl } from "../src/schema/render-sql";
import { createTestDatabase, postgresReachable, type TestDatabase } from "./helpers/pg";

const BASE = "/api/notifications";
const SECRET = "test-signing-secret-0123456789";
const CRON = "test-cron-secret-0123456789";

const definitions = {
  ping: { channels: ["inApp"] },
  alert: { channels: ["inApp", "push"] },
} satisfies NotificationDefinitions;

const recipient = (userId: string): Recipient => ({
  userId,
  email: `${userId}@x.dev`,
  timezone: "UTC",
  locale: "en",
});

let db: TestDatabase;
const available = await postgresReachable();

let errors: unknown[] = [];
const logger = {
  warn: () => {},
  error: (message: string, meta?: unknown) => void errors.push({ message, meta }),
};

let outbox: PushMessage[] = [];
let behaviour: (message: PushMessage) => PushSendResult = () => ({});
const provider = {
  name: "fake-push",
  send: async (message: PushMessage) => {
    outbox.push(message);
    return behaviour(message);
  },
};

const validKeys = {
  p256dh: encodeBase64Url(new Uint8Array([0x04, ...new Uint8Array(64).fill(7)])),
  auth: encodeBase64Url(new Uint8Array(16).fill(9)),
};

const subscription = (endpoint: string, keys: unknown = validKeys) => ({ endpoint, keys });

type Overrides = Partial<EasyPingConfig<typeof definitions>> & {
  pushOptions?: Partial<PushOptions>;
};

function build({ pushOptions, ...overrides }: Overrides = {}) {
  return easyPing({
    database: db.adapter,
    secret: SECRET,
    cron: { secret: CRON },
    session: { getUserId: async (request) => request.headers.get("x-user") ?? "u1" },
    getRecipients: async (ids) => ids.map(recipient),
    notifications: definitions,
    channels: { inApp: { enabled: true } },
    delivery: { mode: "cron" },
    logger,
    plugins: [
      preferences(),
      push({ provider, render: ({ type }) => ({ title: "New", body: type }), ...pushOptions }),
    ],
    ...overrides,
  });
}

const request = (path: string, init: RequestInit & { headers?: Record<string, string> } = {}) =>
  new Request(`https://app.dev${BASE}${path}`, init);

const post = (path: string, body?: unknown, headers: Record<string, string> = {}) =>
  request(path, {
    method: "POST",
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
    headers: { "content-type": "application/json", ...headers },
  });

const devices = () =>
  db.client.unsafe("SELECT * FROM notification_push_device ORDER BY created_at");

const cron = (notify: ReturnType<typeof build>) =>
  notify.handler.POST(post("/cron", undefined, { authorization: `Bearer ${CRON}` }));

describe.skipIf(!available)("security hardening", () => {
  beforeAll(async () => {
    db = await createTestDatabase("security");
    for (const schema of [pushSchema, preferences().schema ?? {}]) {
      for (const statement of renderPostgresDdl(schema)) await db.client.unsafe(statement);
    }
  });

  afterAll(async () => {
    await db.end();
  });

  beforeEach(async () => {
    await db.truncate();
    await db.client.unsafe("TRUNCATE notification_push_device, notification_preference");
    errors = [];
    outbox = [];
    behaviour = () => ({});
  });

  describe("secret strength", () => {
    it("refuses a short signing secret", () => {
      expect(() => build({ secret: "short" })).toThrow(ConfigError);
    });

    it("refuses a placeholder even when it is long enough", () => {
      expect(() => build({ secret: "demo-signing-secret" })).toThrow(/placeholder/);
    });

    it("refuses a short cron secret", () => {
      expect(() => build({ cron: { secret: "c" } })).toThrow(/cron.secret/);
    });
  });

  describe("CSRF", () => {
    it("415s a POST that is not application/json", async () => {
      const notify = build();
      const response = await notify.handler.POST(
        request("/read-all", { method: "POST", headers: { "content-type": "text/plain" } }),
      );
      expect(response.status).toBe(415);
    });

    it("415s a POST with no content type at all", async () => {
      expect((await build().handler.POST(request("/read-all", { method: "POST" }))).status).toBe(
        415,
      );
    });

    it("403s a cross-origin POST", async () => {
      const response = await build().handler.POST(
        post("/read-all", undefined, { origin: "https://evil.example" }),
      );
      expect(response.status).toBe(403);
    });

    it("403s an opaque origin", async () => {
      expect(
        (await build().handler.POST(post("/read-all", undefined, { origin: "null" }))).status,
      ).toBe(403);
    });

    it("accepts the request's own origin", async () => {
      const response = await build().handler.POST(
        post("/read-all", undefined, { origin: "https://app.dev" }),
      );
      expect(response.status).toBe(200);
    });

    it("accepts a trusted origin, exact or wildcard", async () => {
      const notify = build({ trustedOrigins: ["https://admin.example", "*.acme.dev"] });
      for (const origin of ["https://admin.example", "https://app.acme.dev"]) {
        expect((await notify.handler.POST(post("/read-all", undefined, { origin }))).status).toBe(
          200,
        );
      }
      expect(
        (
          await notify.handler.POST(
            post("/read-all", undefined, { origin: "https://acme.dev.evil" }),
          )
        ).status,
      ).toBe(403);
    });

    it("guards plugin POST routes the same way", async () => {
      const notify = build();
      const forged = request("/push/devices", {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: JSON.stringify(subscription("https://push.example/a")),
      });
      expect((await notify.handler.POST(forged)).status).toBe(415);
      expect(await devices()).toHaveLength(0);
    });

    it("leaves the signed unsubscribe route form-tolerant", async () => {
      const notify = build();
      const token = await signToken(SECRET, {
        uid: "u1",
        purpose: "unsubscribe",
        exp: expiresIn(60),
        data: { type: "ping", channel: "email" },
      });
      const response = await notify.handler.POST(
        request(`/unsubscribe?token=${encodeURIComponent(token)}`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: "List-Unsubscribe=One-Click",
        }),
      );
      expect(response.status).toBe(200);
    });
  });

  describe("request handling", () => {
    it("anchors basePath at a segment boundary", async () => {
      const notify = build();
      for (const url of [
        "https://app.dev/other/api/notifications/count",
        "https://app.dev/api/notificationsx/count",
      ]) {
        expect((await notify.handler.GET(new Request(url))).status).toBe(404);
      }
      expect((await notify.handler.GET(request("/count"))).status).toBe(200);
    });

    it("turns a throwing adapter into a logged 500, not an exception", async () => {
      const notify = build({
        database: {
          ...db.adapter,
          countUnseen: async () => {
            throw new Error("db down");
          },
        },
      });
      const response = await notify.handler.GET(request("/count"));
      expect(response.status).toBe(500);
      expect(await response.text()).toBe("");
      expect(errors).toHaveLength(1);
    });

    it("413s a body over the cap before parsing it", async () => {
      const notify = build({ maxBodyBytes: 64 });
      const response = await notify.handler.POST(
        post("/read", { ids: Array.from({ length: 50 }, (_, i) => `id-${i}`) }),
      );
      expect(response.status).toBe(413);
    });

    it("400s malformed JSON instead of treating it as empty", async () => {
      expect((await build().handler.POST(post("/read", "{not json"))).status).toBe(400);
    });

    it("marks every response private and unsniffable, plugin routes included", async () => {
      const notify = build();
      for (const response of [
        await notify.handler.GET(request("/count")),
        await notify.handler.GET(request("/preferences")),
        await notify.handler.POST(post("/read-all")),
      ]) {
        expect(response.headers.get("cache-control")).toBe("private, no-store");
        expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      }
    });

    it("lets onRequest short-circuit before routing", async () => {
      const notify = build({
        onRequest: () => new Response(null, { status: 429 }),
      });
      expect((await notify.handler.GET(request("/count"))).status).toBe(429);
      expect((await cron(notify)).status).toBe(429);
    });
  });

  describe("preferences validation", () => {
    const cases: readonly [string, unknown][] = [
      ["an unknown type", { type: "invented", channel: "email" }],
      ["a bad channel", { type: "ping", channel: "carrier-pigeon" }],
      ["a string for enabled", { type: "ping", channel: "email", enabled: "false" }],
      ["a bad frequency", { type: "ping", channel: "email", frequency: "hourly" }],
      ["an operator for type", { type: { in: ["ping"] }, channel: "email" }],
    ];

    it.each(cases)("400s %s", async (_, body) => {
      const response = await build().handler.POST(post("/preferences", body));
      expect(response.status).toBe(400);
      expect(await db.client.unsafe("SELECT * FROM notification_preference")).toHaveLength(0);
    });

    it("stores a valid preference", async () => {
      const response = await build().handler.POST(
        post("/preferences", { type: "ping", channel: "email", enabled: false }),
      );
      expect(response.status).toBe(200);
    });
  });

  describe("push device registration", () => {
    it("refuses to re-home another account's endpoint", async () => {
      const notify = build();
      await notify.handler.POST(post("/push/devices", subscription("https://push.example/v")));

      const response = await notify.handler.POST(
        post("/push/devices", subscription("https://push.example/v"), { "x-user": "attacker" }),
      );

      expect(response.status).toBe(409);
      const rows = await devices();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.user_id).toBe("u1");
      expect(rows[0]?.p256dh).toBe(validKeys.p256dh);
    });

    it("still lets the owner refresh their own keys", async () => {
      const notify = build();
      await notify.handler.POST(post("/push/devices", subscription("https://push.example/v")));
      const fresh = { ...validKeys, auth: encodeBase64Url(new Uint8Array(16).fill(1)) };
      const response = await notify.handler.POST(
        post("/push/devices", subscription("https://push.example/v", fresh)),
      );
      expect(response.status).toBe(200);
      const rows = await devices();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.auth).toBe(fresh.auth);
    });

    it.each<[string, string]>([
      ["http", "http://push.example/a"],
      ["localhost", "https://localhost/a"],
      ["a private address", "https://10.0.0.5/a"],
      ["link-local metadata", "https://169.254.169.254/latest"],
      ["loopback v6", "https://[::1]/a"],
      ["credentials in the URL", "https://user:pw@push.example/a"],
      ["not a URL", "push.example"],
    ])("rejects %s as an endpoint", async (_, endpoint) => {
      const response = await build().handler.POST(post("/push/devices", subscription(endpoint)));
      expect(response.status).toBe(400);
      expect(await devices()).toHaveLength(0);
    });

    it.each<[string, unknown]>([
      ["a short p256dh", { p256dh: encodeBase64Url(new Uint8Array(32)), auth: validKeys.auth }],
      [
        "a compressed point",
        { p256dh: encodeBase64Url(new Uint8Array(65).fill(2)), auth: validKeys.auth },
      ],
      ["a short auth", { p256dh: validKeys.p256dh, auth: encodeBase64Url(new Uint8Array(8)) }],
      ["non-string keys", { p256dh: 123, auth: validKeys.auth }],
    ])("rejects %s", async (_, keys) => {
      const response = await build().handler.POST(
        post("/push/devices", subscription("https://push.example/a", keys)),
      );
      expect(response.status).toBe(400);
    });

    it("pins endpoints to allowed hosts when asked", async () => {
      const notify = build({
        pushOptions: { allowedEndpointHosts: ["fcm.googleapis.com", "*.notify.windows.com"] },
      });
      expect(
        (await notify.handler.POST(post("/push/devices", subscription("https://push.example/a"))))
          .status,
      ).toBe(400);
      for (const endpoint of [
        "https://fcm.googleapis.com/fcm/send/abc",
        "https://db5p.notify.windows.com/w/?token=x",
      ]) {
        expect(
          (await notify.handler.POST(post("/push/devices", subscription(endpoint)))).status,
        ).toBe(200);
      }
    });

    it("evicts the least recently seen device past the cap", async () => {
      const notify = build({ pushOptions: { maxDevicesPerUser: 2 } });
      for (const n of [1, 2, 3]) {
        await notify.handler.POST(post("/push/devices", subscription(`https://push.example/${n}`)));
      }
      const rows = await devices();
      expect(rows.map((row) => row.endpoint).sort()).toEqual([
        "https://push.example/2",
        "https://push.example/3",
      ]);
    });
  });

  describe("push delivery", () => {
    const register = async (notify: ReturnType<typeof build>, ...endpoints: string[]) => {
      for (const endpoint of endpoints) {
        await notify.handler.POST(post("/push/devices", subscription(endpoint)));
      }
    };

    it("prunes a subscription the provider reports as invalid, without retrying", async () => {
      const notify = build();
      await register(notify, "https://push.example/bad");
      behaviour = () => ({ invalid: true });

      await notify.send("alert", { to: "u1", payload: {} });
      const result = await (await cron(notify)).json();

      expect(result).toMatchObject({ failed: 1 });
      expect(await devices()).toHaveLength(0);
      const failed = await notify.getFailedDeliveries();
      expect(failed.filter((d) => d.channel === "push")[0]?.attempts).toBe(1);
    });

    it("does not count a throttled device as delivered", async () => {
      const notify = build();
      await register(notify, "https://push.example/slow");
      behaviour = () => ({ retryable: true });

      await notify.send("alert", { to: "u1", payload: {} });
      const result = await (await cron(notify)).json();

      expect(result).toMatchObject({ sent: 1, failed: 1 });
      const rows = await db.client.unsafe(
        "SELECT status FROM notification_delivery WHERE channel = 'push'",
      );
      expect(rows[0]?.status).toBe("pending");
    });

    it("redacts addresses from a provider error before persisting it", async () => {
      const notify = build();
      await register(notify, "https://push.example/a");
      behaviour = () => {
        throw new Error("rejected recipient alice@example.com");
      };

      await notify.send("alert", { to: "u1", payload: {} });
      await cron(notify);

      const rows = await db.client.unsafe(
        "SELECT last_error FROM notification_delivery WHERE channel = 'push'",
      );
      expect(rows[0]?.last_error).toBe("rejected recipient [redacted-email]");
    });
  });

  describe("plugin store shape checks", () => {
    const schema = {
      thing: {
        tableName: "notification_push_device",
        fields: {
          id: { type: "string", required: true },
          userId: { type: "string", required: true },
          endpoint: { type: "string", required: true },
        },
        primaryKey: ["id"],
      },
    } satisfies SchemaDeclaration;

    it("refuses a Mongo-style operator object as a value", async () => {
      const store = createPluginStore("t", schema, db.adapter, "");
      await expect(
        store.find("notification_push_device", { endpoint: { $ne: null } as never }),
      ).rejects.toBeInstanceOf(ConfigError);
    });

    it("refuses a malformed recognised operator", async () => {
      const store = createPluginStore("t", schema, db.adapter, "");
      await expect(
        store.remove("notification_push_device", { id: { in: [{}] } as never }),
      ).rejects.toBeInstanceOf(ConfigError);
      await expect(
        store.remove("notification_push_device", { id: { in: ["a"], lt: 1 } as never }),
      ).rejects.toBeInstanceOf(ConfigError);
    });

    it("does not treat prototype properties as declared fields", async () => {
      const store = createPluginStore("t", schema, db.adapter, "");
      for (const field of ["constructor", "__proto__", "toString"]) {
        await expect(
          store.find("notification_push_device", { [field]: "x" }),
        ).rejects.toBeInstanceOf(ConfigError);
      }
    });

    it("refuses an object written into a scalar column", async () => {
      const store = createPluginStore("t", schema, db.adapter, "");
      await expect(
        store.insert("notification_push_device", [{ id: "1", userId: { $gt: "" }, endpoint: "e" }]),
      ).rejects.toBeInstanceOf(ConfigError);
    });
  });
});

describe("pure helpers", () => {
  it("escapeHtml neutralises markup", () => {
    expect(escapeHtml(`<a href="x">Tom & 'Jerry'</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;Tom &amp; &#39;Jerry&#39;&lt;/a&gt;",
    );
    expect(escapeHtml(null)).toBe("");
  });

  it("caps token lifetime at ninety days", () => {
    const now = new Date("2026-01-01T00:00:00Z");
    expect(expiresIn(365 * 86_400, now)).toBe(
      Math.floor(now.getTime() / 1000) + MAX_TOKEN_TTL_SECONDS,
    );
  });

  it("rejects a token whose data is not string-valued", async () => {
    const secret = "test-signing-secret-0123456789";
    const good = await signToken(secret, { uid: "u1", purpose: "p", exp: expiresIn(60) });
    expect(await verifyToken(secret, good, "p")).toMatchObject({ uid: "u1" });

    const bad = await signToken(secret, {
      uid: "u1",
      purpose: "p",
      exp: expiresIn(60),
      data: { channel: { $ne: "" } } as never,
    });
    expect(await verifyToken(secret, bad, "p")).toBeNull();
  });

  it("redacts email addresses from error text", () => {
    expect(redactErrorMessage('Invalid `to`: "bob.smith+tag@corp.example" is not verified')).toBe(
      'Invalid `to`: "[redacted-email]" is not verified',
    );
    expect(redactErrorMessage("resend responded 500")).toBe("resend responded 500");
  });
});

describe("toNodeHandler", () => {
  let server: Server;
  let origin: string;
  let unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => void unhandled.push(reason);

  beforeAll(async () => {
    process.on("unhandledRejection", onUnhandled);
    const handler = toNodeHandler(
      async (request) => {
        if (new URL(request.url).pathname === "/boom") throw new Error("boom");
        return new Response(JSON.stringify({ size: (await request.text()).length }), {
          headers: { "content-type": "application/json" },
        });
      },
      { maxBodyBytes: 32, onError: () => {} },
    );
    server = createServer((req, res) => void handler(req, res));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    process.off("unhandledRejection", onUnhandled);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    unhandled = [];
  });

  it("responds 500 and keeps the process alive when the handler throws", async () => {
    const response = await fetch(`${origin}/boom`, { method: "POST", body: "x" });
    expect(response.status).toBe(500);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(unhandled).toEqual([]);
  });

  it("413s a body over the cap", async () => {
    const response = await fetch(`${origin}/ok`, { method: "POST", body: "y".repeat(100) });
    expect(response.status).toBe(413);
    expect((await fetch(`${origin}/ok`, { method: "POST", body: "y".repeat(10) })).status).toBe(
      200,
    );
  });
});
