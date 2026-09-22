import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { EasyPingConfig } from "../src/core/config";
import type { NotificationDefinitions } from "../src/core/definition";
import { ConfigError } from "../src/core/errors";
import { easyPing } from "../src/core/instance";
import { type AnyPlugin, definePlugin, type PluginInitContext } from "../src/core/plugin";
import { expiresIn, signToken, verifyToken } from "../src/core/tokens";
import type { Recipient } from "../src/core/types";
import { buildUnsubscribeToken, preferences } from "../src/plugins/preferences";
import { renderPostgresDdl } from "../src/schema/render-sql";
import { createTestDatabase, postgresReachable, type TestDatabase } from "./helpers/pg";

const BASE = "/api/notifications";
const SECRET = "test-signing-secret-0123456789";
const CRON = "test-cron-secret-0123456789";
const MACHINE = "test-machine-secret-0123456789";

const definitions = {
  ping: { channels: ["inApp"] },
} satisfies NotificationDefinitions;

const recipient = (userId: string): Recipient => ({
  userId,
  email: `${userId}@x.dev`,
  timezone: "UTC",
  locale: "en",
});

let db: TestDatabase;
const available = await postgresReachable();

let warnings: string[] = [];
const logger = { warn: (message: string) => void warnings.push(message), error: () => {} };

/** A plugin with one route of every scope, exposing the init context it was handed. */
function probePlugin() {
  let ctx: PluginInitContext | undefined;
  const plugin = definePlugin({
    id: "probe",
    init: (context) => {
      ctx = context;
    },
    routes: [
      {
        path: "/probe/tick",
        method: "POST",
        scope: { type: "machine" },
        handler: async () => Response.json({ ticked: true }),
      },
      {
        path: "/probe/accept",
        method: "POST",
        scope: { type: "signed", purpose: "invite" },
        handler: async ({ claims }) => Response.json({ uid: claims?.uid }),
      },
      {
        path: "/probe/open",
        method: "GET",
        scope: { type: "custom", justification: "public health probe, returns no data" },
        handler: async () => new Response("ok"),
      },
    ],
  });
  return { plugin: plugin as AnyPlugin, ctx: () => ctx as PluginInitContext };
}

function build(overrides: Partial<EasyPingConfig<typeof definitions>> = {}) {
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
    plugins: [preferences()],
    ...overrides,
  });
}

const post = (path: string, headers: Record<string, string> = {}, body?: unknown) =>
  new Request(`https://app.dev${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const bearer = (secret: string) => ({ authorization: `Bearer ${secret}` });

describe.skipIf(!available)("scopes, secrets and limits", () => {
  beforeAll(async () => {
    db = await createTestDatabase("security_scopes");
    for (const statement of renderPostgresDdl(preferences().schema ?? {})) {
      await db.client.unsafe(statement);
    }
  });

  afterAll(async () => {
    await db.end();
  });

  beforeEach(async () => {
    await db.truncate();
    await db.client.unsafe("TRUNCATE notification_preference");
    warnings = [];
  });

  describe("plugin signer", () => {
    it("mints tokens only for the purposes the plugin's signed routes declare", async () => {
      const probe = probePlugin();
      const notify = build({ plugins: [preferences(), probe.plugin] });

      const token = await probe.ctx().sign({ uid: "u7", purpose: "invite" });
      expect(await verifyToken(SECRET, token, "invite")).toMatchObject({ uid: "u7" });

      const response = await notify.handler.POST(
        post(`/probe/accept?token=${encodeURIComponent(token)}`),
      );
      expect(await response.json()).toEqual({ uid: "u7" });

      // The unsubscribe purpose belongs to the preferences plugin.
      expect(() => probe.ctx().sign({ uid: "u7", purpose: "unsubscribe" })).toThrow(ConfigError);
    });

    it("never hands the plugin the master secret", () => {
      const probe = probePlugin();
      build({ plugins: [preferences(), probe.plugin] });
      expect(Object.keys(probe.ctx())).not.toContain("secret");
      expect(JSON.stringify(probe.ctx())).not.toContain(SECRET);
    });

    it("derives a different key per purpose", async () => {
      const token = await signToken(SECRET, { uid: "u1", purpose: "a", exp: expiresIn(60) });
      // Same secret, same body: only the purpose the verifier expects differs.
      expect(await verifyToken(SECRET, token, "a")).not.toBeNull();
      expect(await verifyToken(SECRET, token, "b")).toBeNull();
    });
  });

  describe("machine routes", () => {
    it("fall back to cron.secret when no machineSecret is configured", async () => {
      const probe = probePlugin();
      const notify = build({ plugins: [preferences(), probe.plugin] });
      expect((await notify.handler.POST(post("/probe/tick", bearer(CRON)))).status).toBe(200);
    });

    it("use machineSecret when set, so the scheduler credential cannot reach them", async () => {
      const probe = probePlugin();
      const notify = build({ machineSecret: MACHINE, plugins: [preferences(), probe.plugin] });

      expect((await notify.handler.POST(post("/cron", bearer(CRON)))).status).toBe(200);
      expect((await notify.handler.POST(post("/cron", bearer(MACHINE)))).status).toBe(401);

      expect((await notify.handler.POST(post("/probe/tick", bearer(CRON)))).status).toBe(401);
      expect((await notify.handler.POST(post("/probe/tick", bearer(MACHINE)))).status).toBe(200);
    });

    it("holds machineSecret to the same strength rule", () => {
      expect(() => build({ machineSecret: "weak" })).toThrow(/machineSecret/);
    });
  });

  describe("route inventory", () => {
    it("lists every mounted route with its scope and owner", () => {
      const probe = probePlugin();
      const routes = build({ plugins: [preferences(), probe.plugin] }).listRoutes();

      expect(routes).toContainEqual({
        method: "POST",
        path: "/cron",
        scope: { type: "machine" },
        owner: "core",
      });
      expect(routes).toContainEqual({
        method: "POST",
        path: "/unsubscribe",
        scope: { type: "signed", purpose: "unsubscribe" },
        owner: "preferences",
      });
      expect(routes.find((route) => route.path === "/probe/open")?.scope).toEqual({
        type: "custom",
        justification: "public health probe, returns no data",
      });
    });

    it("warns at startup about every custom-scoped route, quoting its justification", () => {
      const probe = probePlugin();
      build({ plugins: [preferences(), probe.plugin] });
      expect(warnings.some((w) => w.includes("/probe/open") && w.includes("health probe"))).toBe(
        true,
      );
    });
  });

  describe("rate limiting", () => {
    const from = (ip: string) => ({ "x-forwarded-for": ip });

    it("429s past the window's quota, per client, with Retry-After", async () => {
      const notify = build({ rateLimit: { max: 2, windowMs: 60_000 } });
      const get = (ip: string) =>
        notify.handler.GET(new Request(`https://app.dev${BASE}/count`, { headers: from(ip) }));

      expect((await get("1.1.1.1")).status).toBe(200);
      expect((await get("1.1.1.1")).status).toBe(200);
      const limited = await get("1.1.1.1");
      expect(limited.status).toBe(429);
      expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);

      expect((await get("2.2.2.2")).status).toBe(200);
    });

    it("covers the unauthenticated cron route too", async () => {
      const notify = build({ rateLimit: { max: 1, windowMs: 60_000 } });
      await notify.handler.POST(post("/cron", { ...bearer("guess"), ...from("3.3.3.3") }));
      const second = await notify.handler.POST(
        post("/cron", { ...bearer("guess"), ...from("3.3.3.3") }),
      );
      expect(second.status).toBe(429);
    });

    it("exempts a request the key function returns null for", async () => {
      const notify = build({ rateLimit: { max: 1, windowMs: 60_000, key: () => null } });
      for (let i = 0; i < 3; i += 1) {
        expect((await notify.handler.GET(new Request(`https://app.dev${BASE}/count`))).status).toBe(
          200,
        );
      }
    });

    it("rejects a nonsensical configuration at startup", () => {
      expect(() => build({ rateLimit: { max: 0, windowMs: 1000 } })).toThrow(ConfigError);
    });
  });

  describe("cron drain bound", () => {
    it("runs at most cron.maxSweeps sweeps per call", async () => {
      const notify = build({
        cron: { secret: CRON, maxSweeps: 1 },
        delivery: { mode: "cron", batchSize: 2 },
      });
      await notify.send("ping", { to: ["a", "b", "c", "d", "e"], payload: {} });

      const first = await (await notify.handler.POST(post("/cron", bearer(CRON)))).json();
      expect(first).toMatchObject({ claimed: 2 });

      const second = await (await notify.handler.POST(post("/cron", bearer(CRON)))).json();
      expect(second).toMatchObject({ claimed: 2 });
    });
  });

  describe("unsubscribe token freshness", () => {
    const unsubscribe = (notify: ReturnType<typeof build>, token: string) =>
      notify.handler.POST(
        new Request(`https://app.dev${BASE}/unsubscribe?token=${encodeURIComponent(token)}`, {
          method: "POST",
        }),
      );

    const rows = () => db.client.unsafe("SELECT * FROM notification_preference");

    it("refuses a token issued before the user's later explicit change", async () => {
      const notify = build();
      const stale = await signToken(SECRET, {
        uid: "u1",
        purpose: "unsubscribe",
        exp: expiresIn(3600),
        iat: Math.floor(Date.now() / 1000) - 3600,
        data: { type: "ping", channel: "email" },
      });

      // Logged in, an hour after that email went out, the user turns it on.
      await notify.handler.POST(
        post("/preferences", {}, { type: "ping", channel: "email", enabled: true }),
      );

      expect((await unsubscribe(notify, stale)).status).toBe(400);
      expect((await rows())[0]).toMatchObject({ enabled: true, frequency: "instant" });
    });

    it("accepts a token newer than the last change", async () => {
      const notify = build();
      await notify.handler.POST(
        post("/preferences", {}, { type: "ping", channel: "email", enabled: true }),
      );
      // Issued after the change: iat is "now", the row was written moments ago.
      const fresh = await buildUnsubscribeToken(SECRET, "u1", "ping", "email");
      expect((await unsubscribe(notify, fresh)).status).toBe(200);
      expect((await rows())[0]).toMatchObject({ enabled: false, frequency: "off" });
    });

    it("stays idempotent: a second click on the same link is still a 200", async () => {
      const notify = build();
      const token = await buildUnsubscribeToken(SECRET, "u1", "ping", "email");
      expect((await unsubscribe(notify, token)).status).toBe(200);
      expect((await unsubscribe(notify, token)).status).toBe(200);
      expect(await rows()).toHaveLength(1);
    });
  });
});
