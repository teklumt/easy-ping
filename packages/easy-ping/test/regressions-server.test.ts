import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { NotificationDefinitions } from "../src/core/definition";
import { easyPing } from "../src/core/instance";
import type { Recipient } from "../src/core/types";
import { createTestDatabase, postgresReachable, type TestDatabase } from "./helpers/pg";

const definitions = {
  ping: { channels: ["inApp"] },
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

const build = (mode: "inline" | "cron", userId = "u1") =>
  easyPing({
    database: db.adapter,
    secret: "test-signing-secret-0123456789",
    cron: { secret: "test-cron-secret-0123456789" },
    session: { getUserId: async () => userId },
    getRecipients: async (ids) => ids.map(recipient),
    notifications: definitions,
    channels: { inApp: { enabled: true } },
    delivery: { mode, batchSize: 5 },
    logger: silent,
  });

describe.skipIf(!available)("suspected defects", () => {
  beforeAll(async () => {
    db = await createTestDatabase("bugprobe");
  });
  afterAll(async () => {
    await db.end();
  });
  beforeEach(async () => {
    await db.truncate();
  });

  it("BUG A: inline send must not deliver unrelated queued work", async () => {
    // Someone else's backlog, sitting in the queue.
    const cronSide = build("cron", "other");
    await cronSide.send("ping", {
      to: Array.from({ length: 30 }, (_, i) => `bg${i}`),
      payload: {},
    });

    let delivered = 0;
    const counting = {
      ...db.adapter,
      claimPendingDeliveries: async (
        args: Parameters<typeof db.adapter.claimPendingDeliveries>[0],
      ) => {
        const rows = await db.adapter.claimPendingDeliveries(args);
        delivered += rows.length;
        return rows;
      },
    };

    const inline = easyPing({
      database: counting,
      secret: "test-signing-secret-0123456789",
      cron: { secret: "test-cron-secret-0123456789" },
      session: { getUserId: async () => "u1" },
      getRecipients: async (ids) => ids.map(recipient),
      notifications: definitions,
      channels: { inApp: { enabled: true } },
      delivery: { mode: "inline", batchSize: 5 },
      logger: silent,
    });

    await inline.send("ping", { to: "u1", payload: {} });

    // One recipient was sent; a request handler must not pay to flush 30 others.
    expect(delivered).toBe(1);
  });

  it("BUG B: marking an already-read notification is idempotent, not 404", async () => {
    const notify = build("cron");
    const sent = await notify.send("ping", { to: "u1", payload: {} });
    const id = sent.notifications[0]?.id;

    const request = () =>
      new Request("https://app.dev/api/notifications/read", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids: [id] }),
      });

    expect((await notify.handler.POST(request())).status).toBe(200);
    // A double click must not 404 and make the client roll back to unread.
    expect((await notify.handler.POST(request())).status).toBe(200);
  });

  it("BUG C: the claim token reaches releaseDeliveries", async () => {
    const notify = build("cron");
    await notify.send("ping", { to: "u1", payload: {} });

    let seenToken: string | undefined;
    const spy = {
      ...db.adapter,
      releaseDeliveries: async (releases: Parameters<typeof db.adapter.releaseDeliveries>[0]) => {
        seenToken = releases[0]?.claimToken;
        return db.adapter.releaseDeliveries(releases);
      },
    };

    const notify2 = easyPing({
      database: spy,
      secret: "test-signing-secret-0123456789",
      cron: { secret: "test-cron-secret-0123456789" },
      session: { getUserId: async () => "u1" },
      getRecipients: async (ids) => ids.map(recipient),
      notifications: definitions,
      channels: { inApp: { enabled: true } },
      delivery: { mode: "cron" },
      logger: silent,
    });

    await notify2.handler.POST(
      new Request("https://app.dev/api/notifications/cron", {
        method: "POST",
        headers: { authorization: "Bearer test-cron-secret-0123456789" },
      }),
    );

    // Empty means stale-lease detection can never be built on top of it.
    expect(seenToken).toBeTruthy();
  });

  describe("BUG I: an unimplemented channel must not fail silently", () => {
    const withChannels = (channels: readonly ("inApp" | "email" | "push")[], warnings: string[]) =>
      easyPing({
        database: db.adapter,
        secret: "test-signing-secret-0123456789",
        cron: { secret: "test-cron-secret-0123456789" },
        session: { getUserId: async () => "u1" },
        getRecipients: async (ids) => ids.map(recipient),
        notifications: { thing: { channels } },
        channels: { inApp: { enabled: true } },
        delivery: { mode: "cron" },
        logger: { warn: (m) => void warnings.push(m), error: () => {} },
      });

    it("warns at startup that a push-only type can never be delivered", () => {
      const warnings: string[] = [];
      withChannels(["push"], warnings);

      expect(warnings.some((w) => w.includes("can never be delivered"))).toBe(true);
    });

    it("warns that an unusable channel is skipped when others remain", () => {
      const warnings: string[] = [];
      withChannels(["push", "inApp"], warnings);

      expect(warnings.some((w) => w.includes("will be skipped"))).toBe(true);
      expect(warnings.some((w) => w.includes("can never be delivered"))).toBe(false);
    });

    it("reports channel-unavailable, not no-channels, so it is distinguishable from an opt-out", async () => {
      const result = await withChannels(["push"], []).send("thing", { to: "u1", payload: {} });

      expect(result.skipped).toEqual([{ userId: "u1", reason: "channel-unavailable" }]);
    });

    it("stays silent when every declared channel has a provider", () => {
      const warnings: string[] = [];
      withChannels(["inApp"], warnings);

      expect(warnings).toEqual([]);
    });
  });

  it("BUG H: markSeen does not clear notifications that arrived after the last poll", async () => {
    const notify = build("cron");
    await notify.send("ping", { to: "u1", payload: {} });

    // What the client has actually rendered.
    const page = await db.adapter.listNotifications({ userId: "u1", limit: 10 });
    const newest = page.notifications[0]?.createdAt.toISOString();

    // Arrives after that render, before the user clicks the bell.
    await new Promise((resolve) => setTimeout(resolve, 10));
    await notify.send("ping", { to: "u1", payload: {} });

    await notify.handler.POST(
      new Request("https://app.dev/api/notifications/seen", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ before: newest }),
      }),
    );

    // The later one must still raise a badge rather than being silently missed.
    expect(await db.adapter.countUnseen("u1")).toBe(1);
  });

  it("BUG D: a fan-out larger than batchSize still fully delivers in one sweep call", async () => {
    const notify = build("cron");
    await notify.send("ping", { to: Array.from({ length: 12 }, (_, i) => `f${i}`), payload: {} });

    // batchSize is 5; the cron endpoint drains, so all 12 should land.
    const response = await notify.handler.POST(
      new Request("https://app.dev/api/notifications/cron", {
        method: "POST",
        headers: { authorization: "Bearer test-cron-secret-0123456789" },
      }),
    );

    expect(await response.json()).toMatchObject({ claimed: 12, sent: 12 });
  });
});
