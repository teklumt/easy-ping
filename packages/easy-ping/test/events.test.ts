import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type EasyPingConfig, INBOX_VERSION_HEADER } from "../src/core/config";
import type { NotificationDefinitions } from "../src/core/definition";
import { easyPing } from "../src/core/instance";
import type { Recipient } from "../src/core/types";
import { availableBackends, type Backend } from "./helpers/backends";
import { waitUntil } from "./helpers/wait";

const BASE = "/api/notifications";

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

// SQLite needs no server, so this suite always runs. The stream logic is
// database-agnostic; the probe test is the one place the adapter matters.
const sqlite = availableBackends.find((backend) => backend.name === "sqlite");
if (!sqlite) throw new Error("sqlite backend missing");

let db: Backend;

function build(overrides: Partial<EasyPingConfig<typeof definitions>> = {}) {
  return easyPing({
    database: db.adapter,
    secret: "test-signing-secret-0123456789",
    cron: { secret: "cron-secret-value" },
    session: { getUserId: async () => "u1" },
    getRecipients: async (ids) => ids.map(recipient),
    notifications: definitions,
    channels: { inApp: { enabled: true } },
    delivery: { mode: "cron" },
    logger: silent,
    ...overrides,
  });
}

const get = (path: string, signal?: AbortSignal) =>
  new Request(`https://app.dev${BASE}${path}`, signal ? { signal } : {});
const post = (path: string, body?: unknown) =>
  new Request(`https://app.dev${BASE}${path}`, {
    method: "POST",
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    headers: { "content-type": "application/json" },
  });

/** Reads `event:` names off an SSE response in the background. */
function tail(response: Response) {
  const events: string[] = [];
  const body = response.body;
  if (!body) throw new Error("no body");
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let ended = false;

  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (line.startsWith("event:")) events.push(line.slice(6).trim());
          newline = buffer.indexOf("\n");
        }
      }
    } catch {
      // aborted
    } finally {
      ended = true;
    }
  })();

  return {
    events,
    ended: () => ended,
    cancel: () => reader.cancel().catch(() => {}),
  };
}

const settle = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));

async function eventually(check: () => Promise<boolean>, timeout = 1_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await settle(5);
  }
  throw new Error("eventually timed out");
}

describe("GET /events", () => {
  beforeAll(async () => {
    db = await sqlite.create("events");
  });

  afterAll(async () => {
    await db.end();
  });

  beforeEach(async () => {
    await db.truncate();
  });

  it("says ready, then changed when a notification is sent to this user", async () => {
    const notify = build();
    const abort = new AbortController();
    const response = await notify.handler.GET(get("/events", abort.signal));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("cache-control")).toContain("no-store");

    const stream = tail(response);
    await waitUntil(() => stream.events.includes("ready"));

    await notify.send("inAppOnly", { to: "u1", payload: {} });
    await waitUntil(() => stream.events.includes("changed"));

    abort.abort();
    await waitUntil(() => stream.ended());
  });

  it("stays quiet for another user's notification", async () => {
    const notify = build();
    const abort = new AbortController();
    const stream = tail(await notify.handler.GET(get("/events", abort.signal)));
    await waitUntil(() => stream.events.includes("ready"));

    await notify.send("inAppOnly", { to: "u2", payload: {} });
    await settle();

    expect(stream.events).toEqual(["ready"]);
    abort.abort();
  });

  it("signals changed after read-all and seen", async () => {
    const notify = build();
    await notify.send("inAppOnly", { to: "u1", payload: {} });

    const abort = new AbortController();
    const stream = tail(await notify.handler.GET(get("/events", abort.signal)));
    await waitUntil(() => stream.events.includes("ready"));

    expect((await notify.handler.POST(post("/read-all"))).status).toBe(200);
    await waitUntil(() => stream.events.filter((e) => e === "changed").length === 1);

    // Nothing left to mark: no signal, no spurious refresh on the client.
    await notify.handler.POST(post("/read-all"));
    await settle();
    expect(stream.events.filter((e) => e === "changed")).toHaveLength(1);

    await notify.handler.POST(post("/seen", {}));
    await waitUntil(() => stream.events.filter((e) => e === "changed").length === 2);

    abort.abort();
  });

  it("closes cleanly when the consumer cancels", async () => {
    const notify = build();
    const stream = tail(await notify.handler.GET(get("/events")));
    await waitUntil(() => stream.events.includes("ready"));

    await stream.cancel();
    // A send after cancel must not throw into the handler's subscriber.
    await notify.send("inAppOnly", { to: "u1", payload: {} });
    await settle();
    expect(stream.events).toEqual(["ready"]);
  });

  it("probes the database so a send through another process still shows up", async () => {
    // Two instances over one database stand in for two serverless replicas
    // with no shared bus: the memory signals of one never reach the other.
    const sender = build();
    const listener = build({ events: { probeIntervalMs: 20 } });

    const abort = new AbortController();
    const stream = tail(await listener.handler.GET(get("/events", abort.signal)));
    await waitUntil(() => stream.events.includes("ready"));
    await settle(50);

    await sender.send("inAppOnly", { to: "u1", payload: {} });
    await waitUntil(() => stream.events.includes("changed"), { timeout: 3_000 });

    abort.abort();
  });

  it("can be switched off, which also removes it from the route inventory", async () => {
    const notify = build({ events: false });
    expect((await notify.handler.GET(get("/events"))).status).toBe(404);
    expect(notify.listRoutes().some((route) => route.path === "/events")).toBe(false);
    expect(build().listRoutes()).toContainEqual({
      method: "GET",
      path: "/events",
      scope: { type: "user" },
      owner: "core",
    });
  });
});

describe("wake-ups", () => {
  beforeAll(async () => {
    db = await sqlite.create("wakeups");
  });

  afterAll(async () => {
    await db.end();
  });

  beforeEach(async () => {
    await db.truncate();
  });

  const deliveredCount = async () =>
    (await db.rows("notification_delivery")).filter((row) => row.status === "sent").length;

  it("a send wakes an idle worker instead of waiting for its interval", async () => {
    const notify = build({ delivery: { mode: "worker" } });
    const worker = notify.startWorker({ intervalMs: 60_000 });
    await settle(30);

    await notify.send("inAppOnly", { to: "u1", payload: {} });
    await eventually(async () => (await deliveredCount()) === 1);

    await worker.stop();
  });

  it("sweepOnRequest delivers pending work after any request", async () => {
    const notify = build({ delivery: { mode: "cron", sweepOnRequest: { everyMs: 0 } } });
    await notify.send("inAppOnly", { to: "u1", payload: {} });
    expect(await deliveredCount()).toBe(0);

    await notify.handler.GET(get("/count"));
    await eventually(async () => (await deliveredCount()) === 1);
  });

  it("inboxHeaders moves once per change to that user's inbox", async () => {
    const notify = build();
    const version = () => notify.inboxHeaders("u1")[INBOX_VERSION_HEADER];

    expect(version()).toBe("0");
    await notify.send("inAppOnly", { to: "u1", payload: {} });
    expect(version()).toBe("1");
    await notify.send("inAppOnly", { to: "u2", payload: {} });
    expect(version()).toBe("1");
    await notify.handler.POST(post("/read-all"));
    expect(version()).toBe("2");
  });
});
