import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { NotificationDefinitions } from "../src/core/definition";
import { ConfigError } from "../src/core/errors";
import { easyPing } from "../src/core/instance";
import { expiresIn, signToken, verifyToken } from "../src/core/tokens";
import type { Recipient } from "../src/core/types";
import { buildUnsubscribeToken, preferences } from "../src/plugins/preferences";
import { createTestDatabase, postgresReachable, type TestDatabase } from "./helpers/pg";

const BASE = "/api/notifications";
const SECRET = "signing-secret";

const definitions = {
  commentReply: {
    channels: ["inApp", "email"],
    email: { subject: () => "s", template: () => "<p>h</p>" },
  },
  securityAlert: {
    channels: ["inApp", "email"],
    email: { subject: () => "s", template: () => "x" },
  },
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

function build(pluginOptions: Partial<Parameters<typeof preferences>[0]> = {}, userId = "u1") {
  return easyPing({
    database: db.adapter,
    secret: SECRET,
    cron: { secret: "cron" },
    session: { getUserId: async () => userId },
    getRecipients: async (ids) => ids.map(recipient),
    notifications: definitions,
    channels: {
      inApp: { enabled: true },
      email: { provider: { name: "fake", send: async () => ({}), isRetryable: () => false } },
    },
    delivery: { mode: "cron" },
    logger: silent,
    plugins: [preferences(pluginOptions)],
  });
}

const post = (path: string, body?: unknown) =>
  new Request(`https://app.dev${BASE}${path}`, {
    method: "POST",
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    headers: { "content-type": "application/json" },
  });

describe("token signer", () => {
  it("round-trips claims", async () => {
    const token = await signToken(SECRET, { uid: "u1", purpose: "test", exp: expiresIn(60) });
    expect(await verifyToken(SECRET, token, "test")).toMatchObject({ uid: "u1" });
  });

  it("rejects a token signed with a different secret", async () => {
    const token = await signToken("other-secret", {
      uid: "u1",
      purpose: "test",
      exp: expiresIn(60),
    });
    expect(await verifyToken(SECRET, token, "test")).toBeNull();
  });

  it("rejects a tampered payload", async () => {
    const token = await signToken(SECRET, { uid: "u1", purpose: "test", exp: expiresIn(60) });
    const [body, signature] = token.split(".");
    const forged = `${btoa('{"uid":"attacker","purpose":"test","exp":9999999999}')
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "")}.${signature}`;

    expect(body).toBeTruthy();
    expect(await verifyToken(SECRET, forged, "test")).toBeNull();
  });

  it("rejects a token replayed against a different purpose", async () => {
    const token = await signToken(SECRET, {
      uid: "u1",
      purpose: "unsubscribe",
      exp: expiresIn(60),
    });
    expect(await verifyToken(SECRET, token, "password-reset")).toBeNull();
  });

  it("rejects an expired token", async () => {
    const token = await signToken(SECRET, { uid: "u1", purpose: "test", exp: expiresIn(-1) });
    expect(await verifyToken(SECRET, token, "test")).toBeNull();
  });

  it("rejects garbage without throwing", async () => {
    expect(await verifyToken(SECRET, "not-a-token", "test")).toBeNull();
    expect(await verifyToken(SECRET, "", "test")).toBeNull();
  });
});

describe.skipIf(!available)("preferences plugin", () => {
  beforeAll(async () => {
    db = await createTestDatabase("preferences");
  });

  afterAll(async () => {
    await db.end();
  });

  beforeEach(async () => {
    await db.truncate();
  });

  it("sends on every channel when no preference row exists", async () => {
    const result = await build().send("commentReply", { to: "u1", payload: {} });
    expect(result.notifications[0]?.deliveries.map((d) => d.channel).sort()).toEqual([
      "email",
      "inApp",
    ]);
  });

  it("skips a channel the user disabled", async () => {
    await db.preferences.upsert(
      "notification_preference",
      [{ userId: "u1", type: "commentReply", channel: "email", enabled: false, frequency: "off" }],
      { onConflict: ["userId", "type", "channel"] },
    );

    const result = await build().send("commentReply", { to: "u1", payload: {} });
    expect(result.notifications[0]?.deliveries.map((d) => d.channel)).toEqual(["inApp"]);
  });

  it("treats frequency off as disabled even when enabled is true", async () => {
    await db.preferences.upsert(
      "notification_preference",
      [{ userId: "u1", type: "commentReply", channel: "email", enabled: true, frequency: "off" }],
      { onConflict: ["userId", "type", "channel"] },
    );

    const result = await build().send("commentReply", { to: "u1", payload: {} });
    expect(result.notifications[0]?.deliveries.map((d) => d.channel)).toEqual(["inApp"]);
  });

  it("skips everything when defaultEnabled is false and nothing is opted in", async () => {
    const result = await build({ defaultEnabled: false }).send("commentReply", {
      to: "u1",
      payload: {},
    });
    expect(result.notifications).toHaveLength(0);
    expect(result.skipped).toEqual([{ userId: "u1", reason: "no-channels" }]);
  });

  it("ignores preferences for alwaysSend types", async () => {
    await db.preferences.upsert(
      "notification_preference",
      [{ userId: "u1", type: "securityAlert", channel: "email", enabled: false, frequency: "off" }],
      { onConflict: ["userId", "type", "channel"] },
    );

    const result = await build({ alwaysSend: ["securityAlert"] }).send("securityAlert", {
      to: "u1",
      payload: {},
    });
    expect(result.notifications[0]?.deliveries.map((d) => d.channel).sort()).toEqual([
      "email",
      "inApp",
    ]);
  });

  it("loads preferences once for a fan-out, not once per recipient", async () => {
    let calls = 0;
    const counting = {
      ...db.adapter,
      queryTable: async (...args: Parameters<typeof db.adapter.queryTable>) => {
        calls += 1;
        return db.adapter.queryTable(...args);
      },
    };

    const notify = easyPing({
      database: counting,
      secret: SECRET,
      cron: { secret: "cron" },
      session: { getUserId: async () => "u1" },
      getRecipients: async (ids) => ids.map(recipient),
      notifications: definitions,
      channels: { inApp: { enabled: true } },
      delivery: { mode: "cron" },
      logger: silent,
      plugins: [preferences()],
    });

    await notify.send("commentReply", { to: ["a", "b", "c", "d", "e"], payload: {} });
    expect(calls).toBe(1);
  });

  it("fails closed when the preference load throws", async () => {
    const broken = {
      ...db.adapter,
      queryTable: async () => {
        throw new Error("database unreachable");
      },
    };

    const notify = easyPing({
      database: broken,
      secret: SECRET,
      cron: { secret: "cron" },
      session: { getUserId: async () => "u1" },
      getRecipients: async (ids) => ids.map(recipient),
      notifications: definitions,
      channels: { inApp: { enabled: true } },
      delivery: { mode: "cron" },
      logger: silent,
      plugins: [preferences()],
    });

    // The whole point of the fail-closed policy: an unreachable preference
    // store must not fall back to "send to everyone", which would email
    // people who opted out. RFC 0004 §5.
    const result = await notify.send("commentReply", { to: "u1", payload: {} });
    expect(result.notifications).toHaveLength(0);
    expect(result.skipped).toEqual([{ userId: "u1", reason: "no-channels" }]);
  });

  describe("routes", () => {
    it("returns the caller's preference matrix", async () => {
      await db.preferences.upsert(
        "notification_preference",
        [
          {
            userId: "u1",
            type: "commentReply",
            channel: "email",
            enabled: false,
            frequency: "off",
          },
        ],
        { onConflict: ["userId", "type", "channel"] },
      );

      const response = await build().handler.GET(new Request(`https://app.dev${BASE}/preferences`));
      const body = (await response.json()) as { preferences: unknown[] };
      expect(body.preferences).toHaveLength(1);
    });

    it("updates a preference scoped to the session user", async () => {
      const notify = build({}, "u1");
      // userId is taken from the session, so a forged body cannot target u2.
      await notify.handler.POST(
        post("/preferences", {
          userId: "u2",
          type: "commentReply",
          channel: "email",
          enabled: false,
        }),
      );

      expect(await db.preferences.find("notification_preference", { userId: "u2" })).toHaveLength(
        0,
      );
      expect(await db.preferences.find("notification_preference", { userId: "u1" })).toHaveLength(
        1,
      );
    });

    it("rejects an update missing type or channel", async () => {
      expect((await build().handler.POST(post("/preferences", { enabled: false }))).status).toBe(
        400,
      );
    });
  });

  describe("one-click unsubscribe", () => {
    const unsubscribe = (token: string) =>
      new Request(`https://app.dev${BASE}/unsubscribe?token=${encodeURIComponent(token)}`, {
        method: "POST",
      });

    it("unsubscribes with no session and no confirmation step", async () => {
      const token = await buildUnsubscribeToken(SECRET, "u9", "commentReply", "email");

      const notify = easyPing({
        database: db.adapter,
        secret: SECRET,
        cron: { secret: "cron" },
        // Must never be consulted: the user is in their mail client.
        session: {
          getUserId: () => {
            throw new Error("session must not be required for unsubscribe");
          },
        },
        getRecipients: async (ids) => ids.map(recipient),
        notifications: definitions,
        channels: { inApp: { enabled: true } },
        delivery: { mode: "cron" },
        logger: silent,
        plugins: [preferences()],
      });

      const response = await notify.handler.POST(unsubscribe(token));
      expect(response.status).toBe(200);

      const rows = await db.preferences.find("notification_preference", { userId: "u9" });
      expect(rows[0]).toMatchObject({ channel: "email", enabled: false, frequency: "off" });
    });

    it("400s on a forged token and changes nothing", async () => {
      const forged = await signToken("wrong-secret", {
        uid: "u9",
        purpose: "unsubscribe",
        exp: expiresIn(60),
        data: { type: "commentReply", channel: "email" },
      });

      expect((await build().handler.POST(unsubscribe(forged))).status).toBe(400);
      expect(await db.preferences.find("notification_preference", { userId: "u9" })).toHaveLength(
        0,
      );
    });

    it("400s on a token minted for a different purpose", async () => {
      const wrongPurpose = await signToken(SECRET, {
        uid: "u9",
        purpose: "password-reset",
        exp: expiresIn(60),
        data: { type: "commentReply", channel: "email" },
      });

      expect((await build().handler.POST(unsubscribe(wrongPurpose))).status).toBe(400);
    });

    it("stops delivery on the unsubscribed channel end to end", async () => {
      const token = await buildUnsubscribeToken(SECRET, "u1", "commentReply", "email");
      await build().handler.POST(unsubscribe(token));

      const result = await build().send("commentReply", { to: "u1", payload: {} });
      expect(result.notifications[0]?.deliveries.map((d) => d.channel)).toEqual(["inApp"]);
    });
  });

  it("rejects two plugins claiming the same route", () => {
    const first = preferences();
    expect(() =>
      easyPing({
        database: db.adapter,
        secret: SECRET,
        cron: { secret: "cron" },
        session: { getUserId: async () => "u1" },
        getRecipients: async () => [],
        notifications: definitions,
        channels: {},
        delivery: { mode: "cron" },
        logger: silent,
        plugins: [first, { ...first, id: "preferences-copy" }],
      }),
    ).toThrow(ConfigError);
  });
});
