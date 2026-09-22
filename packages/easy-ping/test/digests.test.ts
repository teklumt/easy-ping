import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { NotificationDefinitions } from "../src/core/definition";
import { easyPing } from "../src/core/instance";
import type { Recipient } from "../src/core/types";
import { digests } from "../src/plugins/digests";
import { isDue, localMoment, periodKey } from "../src/plugins/digests/schedule";
import { preferences } from "../src/plugins/preferences";
import { renderPostgresDdl } from "../src/schema/render-sql";
import { createTestDatabase, postgresReachable, type TestDatabase } from "./helpers/pg";

const CRON = "cron-secret";
const silent = { warn: () => {}, error: () => {} };

describe("digest scheduling", () => {
  const at = (iso: string) => new Date(iso);

  it("reads the wall clock in the recipient's zone", () => {
    // 03:00 UTC is the previous evening in New York.
    const moment = localMoment("America/New_York", at("2026-03-10T03:00:00Z"));
    expect(moment.date).toBe("2026-03-09");
    expect(moment.hour).toBe(23);
  });

  it("renders midnight as hour 0, not 24", () => {
    // hour12:false yields "24" in several locales, which breaks the send-hour
    // comparison for exactly one hour a day.
    expect(localMoment("UTC", at("2026-03-10T00:30:00Z")).hour).toBe(0);
  });

  it("gives one daily period per local calendar day", () => {
    const morning = localMoment("Europe/Berlin", at("2026-06-01T07:00:00Z"));
    const evening = localMoment("Europe/Berlin", at("2026-06-01T19:00:00Z"));

    expect(periodKey("daily", morning, 1)).toBe(periodKey("daily", evening, 1));
  });

  it("gives one weekly period across the whole week", () => {
    // Monday through Sunday all resolve to the same Monday.
    const keys = [1, 2, 3, 4, 5, 6, 7].map((day) =>
      periodKey("weekly", localMoment("UTC", at(`2026-06-0${day}T12:00:00Z`)), 1),
    );
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toBe("2026-06-01");
  });

  it("changes period the moment a new week starts", () => {
    const sunday = periodKey("weekly", localMoment("UTC", at("2026-06-07T12:00:00Z")), 1);
    const monday = periodKey("weekly", localMoment("UTC", at("2026-06-08T12:00:00Z")), 1);
    expect(sunday).not.toBe(monday);
  });

  it("survives a DST transition without duplicating or skipping a day", () => {
    // US DST starts 2026-03-08. Each local day must still map to one key.
    const keys = ["07", "08", "09"].map((day) =>
      periodKey("daily", localMoment("America/New_York", at(`2026-03-${day}T17:00:00Z`)), 1),
    );
    expect(keys).toEqual(["2026-03-07", "2026-03-08", "2026-03-09"]);
  });

  it("is not due before the send hour, and is after", () => {
    const early = localMoment("UTC", at("2026-06-01T06:00:00Z"));
    const late = localMoment("UTC", at("2026-06-01T10:00:00Z"));

    expect(isDue("daily", early, 9, 1)).toBe(false);
    expect(isDue("daily", late, 9, 1)).toBe(true);
  });

  it("catches up a weekly digest when a run was missed", () => {
    // Wednesday, well past Monday 09:00 — must still fire rather than skip.
    const wednesday = localMoment("UTC", at("2026-06-03T02:00:00Z"));
    expect(isDue("weekly", wednesday, 9, 1)).toBe(true);
  });
});

const definitions = {
  commentReply: {
    channels: ["inApp", "email"],
    email: { subject: () => "reply", template: () => "<p>reply</p>" },
  },
  digest: {
    channels: ["email"],
    email: {
      subject: () => "Your digest",
      template: (p) => `<p>${(p as { items: unknown[] }).items.length} updates</p>`,
    },
  },
} satisfies NotificationDefinitions;

const recipient = (userId: string, timezone = "UTC"): Recipient => ({
  userId,
  email: `${userId}@x.dev`,
  timezone,
  locale: "en",
});

let db: TestDatabase;
const available = await postgresReachable();

const sentEmails: string[] = [];
const logged: string[] = [];

function build(zone = "UTC", sendHour = 0) {
  return easyPing({
    database: db.adapter,
    secret: "s",
    cron: { secret: CRON },
    session: { getUserId: async () => "u1" },
    getRecipients: async (ids) => ids.map((id) => recipient(id, zone)),
    notifications: definitions,
    channels: {
      inApp: { enabled: true },
      email: {
        provider: {
          name: "fake",
          send: async (message) => {
            sentEmails.push(message.subject);
            return {};
          },
          isRetryable: () => false,
        },
      },
    },
    delivery: { mode: "cron" },
    logger: { warn: () => {}, error: (m) => void logged.push(m) },
    plugins: [preferences(), digests({ sendHour })],
  });
}

const runDigestCron = (notify: ReturnType<typeof build>) =>
  notify.handler.POST(
    new Request("https://app.dev/api/notifications/digests/cron", {
      method: "POST",
      headers: { authorization: `Bearer ${CRON}` },
    }),
  );

describe.skipIf(!available)("digests plugin", () => {
  beforeAll(async () => {
    db = await createTestDatabase("digests");
    const plugin = digests();
    for (const statement of renderPostgresDdl(plugin.schema ?? {})) {
      await db.client.unsafe(statement);
    }
  });

  afterAll(async () => {
    await db.end();
  });

  beforeEach(async () => {
    await db.truncate();
    await db.client.unsafe("TRUNCATE notification_digest_entry, notification_digest_state");
    sentEmails.length = 0;
    logged.length = 0;
  });

  const optIn = (userId: string, type: string, frequency: "daily" | "weekly") =>
    db.preferences.upsert(
      "notification_preference",
      [{ userId, type, channel: "email", enabled: true, frequency }],
      { onConflict: ["userId", "type", "channel"] },
    );

  it("leaves instant recipients alone", async () => {
    const notify = build();
    const result = await notify.send("commentReply", { to: "u1", payload: {} });

    expect(result.notifications[0]?.deliveries.map((d) => d.channel).sort()).toEqual([
      "email",
      "inApp",
    ]);
  });

  it("skips email and buckets the item for a digest recipient", async () => {
    await optIn("u1", "commentReply", "daily");
    const notify = build();

    const result = await notify.send("commentReply", { to: "u1", payload: { n: 1 } });

    // In-app still arrives immediately; only email is deferred.
    expect(result.notifications[0]?.deliveries.map((d) => d.channel)).toEqual(["inApp"]);

    const entries = await db.client.unsafe("SELECT * FROM notification_digest_entry");
    expect(entries).toHaveLength(1);
    expect(entries[0]?.notification_id).toBe(result.notifications[0]?.id);

    // afterSend fails open by design, which once hid a broken insert entirely.
    expect(logged).toEqual([]);
  });

  it("round-trips the payload through the digest entry", async () => {
    await optIn("u1", "commentReply", "daily");
    await build().send("commentReply", { to: "u1", payload: { author: "Dana", count: 3 } });

    const [entry] = await db.client.unsafe("SELECT payload FROM notification_digest_entry");
    expect(entry?.payload).toEqual({ author: "Dana", count: 3 });
    expect(logged).toEqual([]);
  });

  it("sends one digest containing every bucketed item", async () => {
    await optIn("u1", "commentReply", "daily");
    const notify = build("UTC", 0);

    for (let i = 0; i < 3; i += 1) {
      await notify.send("commentReply", { to: "u1", payload: { n: i } });
    }

    expect(await (await runDigestCron(notify)).json()).toMatchObject({ sent: 1 });

    // One email, not three.
    await notify.handler.POST(
      new Request("https://app.dev/api/notifications/cron", {
        method: "POST",
        headers: { authorization: `Bearer ${CRON}` },
      }),
    );
    expect(sentEmails).toEqual(["Your digest"]);

    const remaining = await db.client.unsafe("SELECT * FROM notification_digest_entry");
    expect(remaining).toHaveLength(0);
  });

  it("does not send twice in the same period", async () => {
    await optIn("u1", "commentReply", "daily");
    const notify = build("UTC", 0);
    await notify.send("commentReply", { to: "u1", payload: {} });

    expect(await (await runDigestCron(notify)).json()).toMatchObject({ sent: 1 });
    // An hourly cron hits this 23 more times today.
    expect(await (await runDigestCron(notify)).json()).toMatchObject({ sent: 0 });
  });

  it("holds the digest until the local send hour", async () => {
    await optIn("u1", "commentReply", "daily");
    // 09:00 local in a zone where it is currently well before that.
    const notify = build("Pacific/Kiritimati", 23);
    await notify.send("commentReply", { to: "u1", payload: {} });

    const result = (await (await runDigestCron(notify)).json()) as { sent: number };
    const moment = localMoment("Pacific/Kiritimati", new Date());
    expect(result.sent).toBe(moment.hour >= 23 ? 1 : 0);
  });

  it("keeps entries when the digest is not yet due", async () => {
    await optIn("u1", "commentReply", "daily");
    const notify = build("UTC", 25); // never reachable
    await notify.send("commentReply", { to: "u1", payload: {} });

    await runDigestCron(notify);
    const entries = await db.client.unsafe("SELECT * FROM notification_digest_entry");
    expect(entries).toHaveLength(1);
  });

  it("requires the preferences plugin", () => {
    expect(() =>
      easyPing({
        database: db.adapter,
        secret: "s",
        cron: { secret: CRON },
        session: { getUserId: async () => "u1" },
        getRecipients: async () => [],
        notifications: definitions,
        channels: { inApp: { enabled: true } },
        delivery: { mode: "cron" },
        logger: silent,
        plugins: [digests()],
      }),
    ).toThrow(/requires "preferences"/);
  });

  it("refuses the cron route without the machine secret", async () => {
    const response = await build().handler.POST(
      new Request("https://app.dev/api/notifications/digests/cron", { method: "POST" }),
    );
    expect(response.status).toBe(401);
  });
});
