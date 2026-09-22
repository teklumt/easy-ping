import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { EasyPingConfig } from "../src/core/config";
import type { NotificationDefinitions } from "../src/core/definition";
import { ConfigError } from "../src/core/errors";
import { easyPing } from "../src/core/instance";
import type { AnyPlugin } from "../src/core/plugin";
import type { Recipient } from "../src/core/types";
import { createTestDatabase, postgresReachable, type TestDatabase } from "./helpers/pg";

const BASE = "/api/notifications";
const CRON_SECRET = "cron-secret-value";

const definitions = {
  inAppOnly: { channels: ["inApp"] },
} satisfies NotificationDefinitions;

const recipient = (userId: string): Recipient => ({
  userId,
  email: `${userId}@x.dev`,
  timezone: "UTC",
  locale: "en",
});

const silent = { warn: () => {}, error: () => {} };

let db: TestDatabase;
const available = await postgresReachable();

function build(overrides: Partial<EasyPingConfig<typeof definitions>> = {}) {
  return easyPing({
    database: db.adapter,
    secret: "test-signing-secret-0123456789",
    cron: { secret: CRON_SECRET },
    session: { getUserId: async () => "u1" },
    getRecipients: async (ids) => ids.map(recipient),
    notifications: definitions,
    channels: { inApp: { enabled: true } },
    delivery: { mode: "cron" },
    logger: silent,
    ...overrides,
  });
}

const get = (path: string) => new Request(`https://app.dev${BASE}${path}`);
const post = (path: string, body?: unknown, headers?: Record<string, string>) =>
  new Request(`https://app.dev${BASE}${path}`, {
    method: "POST",
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    headers: { "content-type": "application/json", ...headers },
  });

describe.skipIf(!available)("route handler", () => {
  beforeAll(async () => {
    db = await createTestDatabase("handler");
  });

  afterAll(async () => {
    await db.end();
  });

  beforeEach(async () => {
    await db.truncate();
  });

  it("401s when the session resolves to null", async () => {
    const notify = build({ session: { getUserId: async () => null } });
    expect((await notify.handler.GET(get("/"))).status).toBe(401);
  });

  it("500s — not 401 — when the session resolver throws", async () => {
    const notify = build({
      session: {
        getUserId: () => {
          throw new Error("session store down");
        },
      },
    });
    // A broken lookup and an absent session are different bugs; conflating
    // them makes an outage look like a mass logout.
    expect((await notify.handler.GET(get("/"))).status).toBe(500);
  });

  it("serves only the caller's notifications", async () => {
    const notify = build();
    await notify.send("inAppOnly", { to: ["u1", "u2"], payload: {} });

    const response = await notify.handler.GET(get("/"));
    const body = (await response.json()) as { notifications: { userId: string }[] };

    expect(body.notifications).toHaveLength(1);
    expect(body.notifications[0]?.userId).toBe("u1");
  });

  it("carries unseenCount on the first page so a poll costs one request", async () => {
    const notify = build();
    await notify.send("inAppOnly", { to: "u1", payload: {} });

    const body = (await (await notify.handler.GET(get("/"))).json()) as {
      notifications: unknown[];
      unseenCount?: number;
    };

    expect(body.unseenCount).toBe(1);
  });

  it("omits unseenCount when paginating, because that is scrollback not a poll", async () => {
    const notify = build();
    await notify.send("inAppOnly", { to: "u1", payload: {} });
    await notify.send("inAppOnly", { to: "u1", payload: {} });

    const first = (await (await notify.handler.GET(get("/?limit=1"))).json()) as {
      nextCursor: string | null;
      unseenCount?: number;
    };
    expect(first.unseenCount).toBe(2);
    expect(first.nextCursor).not.toBeNull();

    const second = (await (
      await notify.handler.GET(
        get(`/?limit=1&cursor=${encodeURIComponent(first.nextCursor ?? "")}`),
      )
    ).json()) as { unseenCount?: number };

    expect(second.unseenCount).toBeUndefined();
  });

  it("counts unseen and clears it via /seen", async () => {
    const notify = build();
    await notify.send("inAppOnly", { to: "u1", payload: {} });

    expect(await (await notify.handler.GET(get("/count"))).json()).toEqual({ unseen: 1 });

    await notify.handler.POST(post("/seen"));
    expect(await (await notify.handler.GET(get("/count"))).json()).toEqual({ unseen: 0 });
  });

  it("404s when marking another user's notification read", async () => {
    const notify = build();
    const sent = await notify.send("inAppOnly", { to: "u2", payload: {} });
    const foreignId = sent.notifications[0]?.id;

    // 404 rather than 403 — a 403 confirms the row exists and belongs to
    // someone else. RFC 0002 §2.
    const response = await notify.handler.POST(post("/read", { ids: [foreignId] }));
    expect(response.status).toBe(404);
  });

  it("marks the caller's own notification read", async () => {
    const notify = build();
    const sent = await notify.send("inAppOnly", { to: "u1", payload: {} });

    const response = await notify.handler.POST(post("/read", { ids: [sent.notifications[0]?.id] }));
    expect(await response.json()).toEqual({ updated: 1 });
  });

  it("rejects an empty ids array", async () => {
    expect((await build().handler.POST(post("/read", { ids: [] }))).status).toBe(400);
  });

  it("marks all read", async () => {
    const notify = build();
    await notify.send("inAppOnly", { to: "u1", payload: {} });
    await notify.send("inAppOnly", { to: "u1", payload: {} });

    expect(await (await notify.handler.POST(post("/read-all"))).json()).toEqual({ updated: 2 });
  });

  describe("cron endpoint", () => {
    it("401s with no credentials", async () => {
      expect((await build().handler.POST(post("/cron"))).status).toBe(401);
    });

    it("401s with the wrong secret", async () => {
      const response = await build().handler.POST(
        post("/cron", undefined, { authorization: "Bearer nope" }),
      );
      expect(response.status).toBe(401);
    });

    it("drains with the right secret, without needing a session", async () => {
      const notify = build({
        session: {
          getUserId: () => {
            throw new Error("must not be consulted for a machine route");
          },
        },
      });
      await build().send("inAppOnly", { to: "u1", payload: {} });

      const response = await notify.handler.POST(
        post("/cron", undefined, { authorization: `Bearer ${CRON_SECRET}` }),
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ claimed: 1, sent: 1 });
    });

    it("405s on GET", async () => {
      expect((await build().handler.GET(get("/cron"))).status).toBe(405);
    });
  });

  describe("config validation", () => {
    const base = {
      database: undefined as never,
      secret: "test-signing-secret-0123456789",
      cron: { secret: "test-cron-secret-0123456789" },
      session: { getUserId: async () => "u1" },
      getRecipients: async () => [],
      notifications: definitions,
      channels: {},
      logger: silent,
    };

    it("rejects a missing session resolver", () => {
      expect(() =>
        easyPing({ ...base, database: db.adapter, session: undefined as never }),
      ).toThrow(ConfigError);
    });

    it("rejects a missing secret", () => {
      expect(() => easyPing({ ...base, database: db.adapter, secret: "" })).toThrow(ConfigError);
    });

    it("rejects cron mode without a cron secret", () => {
      expect(() =>
        easyPing({
          ...base,
          database: db.adapter,
          cron: undefined as never,
          delivery: { mode: "cron" },
        }),
      ).toThrow(/cron.secret/);
    });

    it("rejects duplicate plugin ids", () => {
      const plugin: AnyPlugin = { id: "dupe" };
      expect(() =>
        easyPing({ ...base, database: db.adapter, plugins: [plugin, { ...plugin }] }),
      ).toThrow(/duplicate plugin id/);
    });

    it("rejects an unmet plugin dependency", () => {
      expect(() =>
        easyPing({
          ...base,
          database: db.adapter,
          plugins: [{ id: "digests", dependsOn: ["preferences"] }],
        }),
      ).toThrow(/requires "preferences"/);
    });

    it("warns when the provider timeout crowds the lease", async () => {
      const warnings: string[] = [];
      const notify = easyPing({
        ...base,
        database: db.adapter,
        logger: { warn: (m) => void warnings.push(m), error: () => {} },
        channels: {
          email: {
            provider: {
              name: "slow",
              timeoutMs: 55_000,
              send: async () => ({}),
              isRetryable: () => true,
            },
          },
        },
        delivery: { mode: "cron", leaseMs: 60_000 },
      });

      expect(warnings.some((w) => w.includes("systematic"))).toBe(true);
      expect((await notify.healthCheck()).warnings).toHaveLength(1);
    });
  });
});
