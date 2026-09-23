import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseAdapter } from "../src/core/adapter";
import type { EasyPingConfig } from "../src/core/config";
import type { NotificationDefinitions } from "../src/core/definition";
import { easyPing } from "../src/core/instance";
import type { Recipient } from "../src/core/types";
import { availableBackends, type Backend } from "./helpers/backends";
import { waitUntil } from "./helpers/wait";

const BASE = "/api/notifications";
const definitions = { inAppOnly: { channels: ["inApp"] } } satisfies NotificationDefinitions;
const recipient = (userId: string): Recipient => ({
  userId,
  email: `${userId}@x.dev`,
  timezone: "UTC",
  locale: "en",
});
const silent = { warn: () => {}, error: () => {} };

const sqlite = availableBackends.find((backend) => backend.name === "sqlite");
if (!sqlite) throw new Error("sqlite backend missing");

let db: Backend;

function build(
  overrides: Partial<EasyPingConfig<typeof definitions>> = {},
  adapter: DatabaseAdapter = db.adapter,
) {
  return easyPing({
    database: adapter,
    secret: "test-signing-secret-0123456789",
    cron: { secret: "cron-secret-value" },
    session: { getUserId: async (request) => request.headers.get("x-user") },
    getRecipients: async (ids) => ids.map(recipient),
    notifications: definitions,
    channels: { inApp: { enabled: true } },
    delivery: { mode: "cron" },
    logger: silent,
    ...overrides,
  });
}

const get = (path: string, user: string | null, signal?: AbortSignal) =>
  new Request(`https://app.dev${BASE}${path}`, {
    ...(signal ? { signal } : {}),
    headers: user ? { "x-user": user } : {},
  });

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Reads the stream so backpressure never interferes with what these tests measure. */
function drain(response: Response) {
  const reader = response.body?.getReader();
  void (async () => {
    try {
      for (;;) {
        const { done } = await (reader?.read() ?? Promise.resolve({ done: true }));
        if (done) break;
      }
    } catch {
      // aborted
    }
  })();
}

describe("GET /events hardening", () => {
  beforeAll(async () => {
    db = await sqlite.create("events-hardening");
  });
  afterAll(async () => {
    await db.end();
  });
  beforeEach(async () => {
    await db.truncate();
  });

  it("caps concurrent streams per user and frees the slot when one closes", async () => {
    const notify = build({ events: { maxStreamsPerUser: 2 } });
    const a = new AbortController();
    const b = new AbortController();
    drain(await notify.handler.GET(get("/events", "u1", a.signal)));
    drain(await notify.handler.GET(get("/events", "u1", b.signal)));

    const third = await notify.handler.GET(get("/events", "u1"));
    expect(third.status).toBe(429);
    expect(third.headers.get("retry-after")).toBe("30");

    // Another user is unaffected by u1's quota.
    const other = new AbortController();
    expect((await notify.handler.GET(get("/events", "u2", other.signal))).status).toBe(200);

    a.abort();
    await settle(10);
    const fourth = new AbortController();
    expect((await notify.handler.GET(get("/events", "u1", fourth.signal))).status).toBe(200);

    b.abort();
    other.abort();
    fourth.abort();
  });

  it("caps streams for the whole process", async () => {
    const notify = build({ events: { maxStreams: 1 } });
    const a = new AbortController();
    drain(await notify.handler.GET(get("/events", "u1", a.signal)));
    const second = await notify.handler.GET(get("/events", "u2"));
    expect(second.status).toBe(503);
    a.abort();
  });

  it("runs one database probe per user however many streams that user holds", async () => {
    let probes = 0;
    const counting = new Proxy(db.adapter, {
      get(target, key, receiver) {
        if (key === "countUnseen") {
          return (...args: unknown[]) => {
            probes += 1;
            return (target.countUnseen as (...a: unknown[]) => unknown)(...args);
          };
        }
        return Reflect.get(target, key, receiver);
      },
    });
    const notify = build({ events: { probeIntervalMs: 30 } }, counting);

    const controllers = [1, 2, 3, 4].map(() => new AbortController());
    for (const controller of controllers) {
      drain(await notify.handler.GET(get("/events", "u1", controller.signal)));
    }
    await settle(20);
    probes = 0;
    await settle(300);
    for (const controller of controllers) controller.abort();

    // One shared probe: roughly ten ticks in 300 ms. Four independent ones would be about forty.
    expect(probes).toBeGreaterThan(4);
    expect(probes).toBeLessThan(20);
  });

  it("stops probing when the last stream for that user closes", async () => {
    let probes = 0;
    const counting = new Proxy(db.adapter, {
      get(target, key, receiver) {
        if (key === "countUnseen") {
          return (...args: unknown[]) => {
            probes += 1;
            return (target.countUnseen as (...a: unknown[]) => unknown)(...args);
          };
        }
        return Reflect.get(target, key, receiver);
      },
    });
    const notify = build({ events: { probeIntervalMs: 20 } }, counting);
    const controller = new AbortController();
    drain(await notify.handler.GET(get("/events", "u1", controller.signal)));
    await waitUntil(() => probes >= 2);
    controller.abort();
    await settle(30);
    const after = probes;
    await settle(100);
    expect(probes).toBe(after);
  });

  it("does not run the request-driven sweep for rejected requests", async () => {
    const notify = build({ delivery: { mode: "cron", sweepOnRequest: { everyMs: 0 } } });
    await notify.send("inAppOnly", { to: "u1", payload: {} });
    const delivered = async () =>
      (await db.rows("notification_delivery")).filter((row) => row.status === "sent").length;

    expect((await notify.handler.GET(get("/count", null))).status).toBe(401);
    await settle(80);
    expect(await delivered()).toBe(0);

    expect((await notify.handler.GET(get("/count", "u1"))).status).toBe(200);
    const deadline = Date.now() + 1_000;
    while ((await delivered()) === 0 && Date.now() < deadline) await settle(10);
    expect(await delivered()).toBe(1);
  });
});
