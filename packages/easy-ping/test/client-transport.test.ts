import { afterEach, describe, expect, it, vi } from "vitest";
import { createNotifyClient, type NotifyClientOptions, type NotifyState } from "../src/client";
import { waitUntil } from "./helpers/wait";

type Row = { id: string; readAt: string | null; seenAt: string | null };

const row = (id: string): Row => ({ id, readAt: null, seenAt: null });

/** Fake origin: a JSON feed plus an SSE endpoint whose streams the test drives by hand. */
function server(initial: Row[] = [row("a"), row("b")]) {
  let rows = initial;
  const calls: string[] = [];
  const streams: { push: (text: string) => void; end: () => void; alive: boolean }[] = [];
  let dieImmediately = false;

  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url);
    calls.push(`${init?.method ?? "GET"} ${path.replace(/^https:\/\/app\.dev/, "")}`);

    if (path.endsWith("/events")) {
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const handle = {
            alive: true,
            push: (text: string) => controller.enqueue(encoder.encode(text)),
            end: () => {
              if (!handle.alive) return;
              handle.alive = false;
              controller.close();
            },
          };
          streams.push(handle);
          init?.signal?.addEventListener("abort", handle.end);
          if (dieImmediately) handle.end();
          else handle.push("retry: 3000\n\nevent: ready\ndata: {}\n\n");
        },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    }

    if (path.includes("/count")) {
      return Response.json({ unseen: rows.filter((r) => r.seenAt === null).length });
    }
    if (path.includes("/read-all")) {
      rows = rows.map((r) => ({ ...r, readAt: r.readAt ?? "now" }));
      return Response.json({ updated: rows.length });
    }
    if (path.includes("/read")) {
      const body = JSON.parse(String(init?.body)) as { ids: string[] };
      rows = rows.map((r) => (body.ids.includes(r.id) ? { ...r, readAt: "now" } : r));
      return Response.json({ updated: body.ids.length });
    }
    if (path.includes("/seen")) {
      rows = rows.map((r) => ({ ...r, seenAt: "now" }));
      return Response.json({ ok: true });
    }

    return Response.json({
      notifications: rows.map((r) => ({
        ...r,
        userId: "u1",
        type: "t",
        payload: {},
        actorId: null,
        groupKey: null,
        createdAt: "2026-01-01T00:00:00.000Z",
      })),
      nextCursor: null,
    });
  }) as unknown as typeof globalThis.fetch;

  return {
    fetch,
    calls,
    streams,
    pages: () => calls.filter((c) => c.startsWith("GET /api/notifications/?")).length,
    latest: () => streams.at(-1),
    killStreams: () => {
      dieImmediately = true;
    },
    add: (id: string) => {
      rows = [row(id), ...rows];
    },
  };
}

/** BroadcastChannel semantics: everyone on the name hears it except the sender. */
function hub() {
  const ports = new Set<{ handlers: Set<(event: { data: unknown }) => void> }>();
  return () => {
    const port = { handlers: new Set<(event: { data: unknown }) => void>() };
    ports.add(port);
    return {
      postMessage(message: unknown) {
        for (const other of ports) {
          if (other === port) continue;
          for (const handler of other.handlers) queueMicrotask(() => handler({ data: message }));
        }
      },
      addEventListener: (_: "message", handler: (event: { data: unknown }) => void) => {
        port.handlers.add(handler);
      },
      removeEventListener: (_: "message", handler: (event: { data: unknown }) => void) => {
        port.handlers.delete(handler);
      },
      close: () => {
        ports.delete(port);
      },
    };
  };
}

/** Web Locks: one exclusive holder per name, waiters served in order, abortable while waiting. */
function locks() {
  const held = new Set<string>();
  const queues = new Map<string, (() => void)[]>();
  return {
    request(
      name: string,
      options: { mode: "exclusive"; signal?: AbortSignal },
      callback: () => Promise<void>,
    ) {
      return new Promise<void>((resolve, reject) => {
        const grant = () => {
          held.add(name);
          callback().finally(() => {
            held.delete(name);
            resolve();
            queues.get(name)?.shift()?.();
          });
        };
        if (options.signal?.aborted) return reject(new Error("aborted"));
        if (!held.has(name)) return grant();
        const queue = queues.get(name) ?? [];
        queues.set(name, queue);
        queue.push(grant);
        options.signal?.addEventListener("abort", () => {
          const index = queue.indexOf(grant);
          if (index >= 0) queue.splice(index, 1);
          reject(new Error("aborted"));
        });
      });
    },
  };
}

function target() {
  const handlers = new Map<string, Set<(event: { data?: unknown }) => void>>();
  return {
    addEventListener: (type: string, handler: (event: { data?: unknown }) => void) => {
      handlers.set(type, (handlers.get(type) ?? new Set()).add(handler));
    },
    removeEventListener: (type: string, handler: (event: { data?: unknown }) => void) => {
      handlers.get(type)?.delete(handler);
    },
    fire: (type: string, data?: unknown) => {
      for (const handler of handlers.get(type) ?? []) handler({ data });
    },
    count: (type: string) => handlers.get(type)?.size ?? 0,
  };
}

const client = (api: ReturnType<typeof server>, extra: Partial<NotifyClientOptions> = {}) =>
  createNotifyClient({
    fetch: api.fetch,
    baseUrl: "https://app.dev/api/notifications",
    isDocumentHidden: () => false,
    locks: null,
    channel: null,
    serviceWorker: null,
    activityTarget: null,
    transport: "poll",
    ...extra,
  });

const stops: (() => void)[] = [];
const watch = (c: ReturnType<typeof createNotifyClient>) => {
  let state = c.getState();
  const stop = c.subscribe((next) => {
    state = next;
  });
  stops.push(stop);
  return {
    stop,
    get state() {
      return state;
    },
  };
};

afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  vi.useRealTimers();
});

describe("event stream", () => {
  it("connects, refreshes on `changed`, and closes the stream when the last subscriber leaves", async () => {
    const api = server();
    const c = client(api, { transport: "sse" });
    const { stop } = watch(c);

    await waitUntil(() => c.getTransport().connected);
    expect(c.getTransport()).toEqual({ role: "solo", transport: "sse", connected: true });
    await waitUntil(() => api.pages() === 1);

    api.add("c");
    api.latest()?.push("event: changed\ndata: {}\n\n");
    await waitUntil(() => api.pages() === 2);
    expect(c.getState().notifications.map((n) => n.id)).toEqual(["c", "a", "b"]);

    // Comments and unknown events are ignored, not treated as changes.
    api.latest()?.push(": keepalive\n\nevent: mystery\ndata: {}\n\n");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(api.pages()).toBe(2);

    stop();
    await waitUntil(() => api.latest()?.alive === false);
    expect(c.getTransport().connected).toBe(false);
  });

  it("gives up on streaming after three short-lived connections and keeps polling", async () => {
    vi.useFakeTimers();
    const api = server();
    api.killStreams();
    const c = client(api, { transport: "sse", pollIntervalMs: 1_000 });
    watch(c);

    await vi.advanceTimersByTimeAsync(0);
    expect(api.streams).toHaveLength(1);
    expect(c.getTransport().transport).toBe("sse");

    await vi.advanceTimersByTimeAsync(3_100);
    expect(api.streams).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(3_100);
    expect(api.streams).toHaveLength(3);

    await vi.advanceTimersByTimeAsync(10);
    expect(c.getTransport().transport).toBe("poll");

    const before = api.pages();
    await vi.advanceTimersByTimeAsync(1_100);
    expect(api.pages()).toBeGreaterThan(before);
    expect(api.streams).toHaveLength(3);
  });

  it("polls only as a slow safety net while the stream is up", async () => {
    vi.useFakeTimers();
    const api = server();
    const c = client(api, { transport: "sse", pollIntervalMs: 1_000, safetyNetMs: 30_000 });
    watch(c);

    await vi.advanceTimersByTimeAsync(0);
    expect(c.getTransport().connected).toBe(true);
    const before = api.pages();

    await vi.advanceTimersByTimeAsync(10_000);
    expect(api.pages()).toBe(before);
    await vi.advanceTimersByTimeAsync(25_000);
    expect(api.pages()).toBe(before + 1);
  });
});

describe("event stream without a streaming fetch", () => {
  it("gives up after one attempt when the response has no body, instead of three retries", async () => {
    vi.useFakeTimers();
    const api = server();
    const bodiless = (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("/events")) {
        api.calls.push("GET /api/notifications/events");
        return new Response(null, { status: 200 });
      }
      return api.fetch(url, init);
    }) as unknown as typeof globalThis.fetch;
    const c = client(api, { transport: "sse", pollIntervalMs: 1_000, fetch: bodiless });
    watch(c);

    await vi.advanceTimersByTimeAsync(0);
    expect(c.getTransport().transport).toBe("poll");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(api.calls.filter((call) => call.endsWith("/events"))).toHaveLength(1);
    expect(api.pages()).toBeGreaterThan(1);
  });
});

describe("one connection per browser", () => {
  it("elects a leader; followers mirror it and hand leadership on when it closes", async () => {
    const api = server();
    const shared = { locks: locks(), channel: hub(), transport: "sse" as const };
    const first = client(api, shared);
    const second = client(api, shared);

    const tabA = watch(first);
    const tabB = watch(second);

    await waitUntil(() => first.getTransport().role === "leader");
    expect(second.getTransport().role).toBe("follower");
    await waitUntil(() => tabB.state.isLoading === false);

    expect(api.streams).toHaveLength(1);
    expect(tabB.state.notifications.map((n) => n.id)).toEqual(["a", "b"]);
    expect(tabA.state).toEqual(tabB.state);

    // The follower's own write shows immediately and asks the leader to refresh.
    const pagesBefore = api.pages();
    await second.markAsRead("a");
    expect(tabB.state.notifications[0]?.readAt).not.toBeNull();
    await waitUntil(() => api.pages() === pagesBefore + 1);
    await waitUntil(() => tabA.state.notifications[0]?.readAt !== null);
    expect(tabB.state.unreadCount).toBe(1);

    tabA.stop();
    await waitUntil(() => second.getTransport().role === "leader");
    await waitUntil(() => second.getTransport().connected);
    expect(api.streams).toHaveLength(2);
    expect(api.streams[0]?.alive).toBe(false);
  });
});

describe("polling shape", () => {
  it("backs off while idle and snaps back on user activity", async () => {
    vi.useFakeTimers();
    const api = server();
    const activity = target();
    const c = client(api, {
      pollIntervalMs: 100,
      maxPollIntervalMs: 10_000,
      activeWindowMs: 500,
      activityTarget: activity,
    });
    watch(c);

    await vi.advanceTimersByTimeAsync(0);
    expect(api.pages()).toBe(1);

    // Active window: every 100 ms.
    await vi.advanceTimersByTimeAsync(400);
    expect(api.pages()).toBe(5);

    // Idle: 200, 400, 800, 1600 ... far fewer than 30 polls in three seconds.
    const idleStart = api.pages();
    await vi.advanceTimersByTimeAsync(3_000);
    const idlePolls = api.pages() - idleStart;
    expect(idlePolls).toBeGreaterThan(1);
    expect(idlePolls).toBeLessThan(8);

    // A keypress refreshes now (the last poll is stale) and returns to the base interval.
    const beforeActivity = api.pages();
    activity.fire("keydown");
    await vi.advanceTimersByTimeAsync(0);
    expect(api.pages()).toBe(beforeActivity + 1);
    await vi.advanceTimersByTimeAsync(300);
    expect(api.pages()).toBe(beforeActivity + 4);
  });

  it("removes its listeners when the last subscriber leaves", async () => {
    const api = server();
    const activity = target();
    const sw = target();
    const c = client(api, { activityTarget: activity, serviceWorker: sw });
    const { stop } = watch(c);

    expect(activity.count("keydown")).toBe(1);
    expect(sw.count("message")).toBe(1);
    stop();
    expect(activity.count("keydown")).toBe(0);
    expect(sw.count("message")).toBe(0);
  });
});

describe("outside signals", () => {
  it("refreshes when the service worker relays a push", async () => {
    const api = server();
    const sw = target();
    const c = client(api, { serviceWorker: sw, pollIntervalMs: 60_000 });
    watch(c);
    await waitUntil(() => api.pages() === 1);

    sw.fire("message", { source: "other" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(api.pages()).toBe(1);

    sw.fire("message", { source: "easy-ping", type: "changed" });
    await waitUntil(() => api.pages() === 2);
  });

  it("instrument(fetch) refreshes when the inbox-version header moves", async () => {
    const api = server();
    const c = client(api, { pollIntervalMs: 60_000 });
    watch(c);
    await waitUntil(() => api.pages() === 1);

    let version = "7";
    const app = c.instrument(
      (async () => new Response("{}", { headers: { "x-easy-ping-inbox": version } })) as never,
    );

    await app("/api/anything");
    await app("/api/anything");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(api.pages()).toBe(1);

    version = "8";
    await app("/api/anything");
    await waitUntil(() => api.pages() === 2);

    const plain = c.instrument((async () => new Response("{}")) as never);
    await plain("/api/no-header");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(api.pages()).toBe(2);
  });
});

describe("no DOM", () => {
  it("auto transport polls on the server side instead of opening a stream", async () => {
    const api = server();
    const c = client(api, { transport: "auto" });
    watch(c);
    await waitUntil(() => api.pages() === 1);
    expect(c.getTransport()).toEqual({ role: "solo", transport: "poll", connected: false });
    expect(api.streams).toHaveLength(0);
  });

  it("keeps the state shape the existing consumers rely on", async () => {
    const api = server();
    const c = client(api);
    const tab = watch(c);
    await waitUntil(() => tab.state.isLoading === false);
    const expected: NotifyState = {
      notifications: tab.state.notifications,
      unseenCount: 2,
      unreadCount: 2,
      nextCursor: null,
      isLoading: false,
      error: null,
    };
    expect(tab.state).toEqual(expected);
  });
});

describe("scope", () => {
  it("keeps tabs signed in as different users apart: separate leaders, separate state", async () => {
    const api = server();
    const shared = locks();
    const requested: string[] = [];
    const recording = {
      request: (
        name: string,
        options: { mode: "exclusive"; signal?: AbortSignal },
        cb: () => Promise<void>,
      ) => {
        requested.push(name);
        return shared.request(name, options, cb);
      },
    };
    // Real Node BroadcastChannel, so the channel name carries the scope too.
    const a = client(api, {
      transport: "sse",
      locks: recording,
      channel: undefined,
      scope: "alice",
    });
    const b = client(api, { transport: "sse", locks: recording, channel: undefined, scope: "bob" });
    watch(a);
    watch(b);

    await waitUntil(() => a.getTransport().role === "leader" && b.getTransport().role === "leader");
    expect(new Set(requested).size).toBe(2);
    expect(requested.every((name) => name.includes("#alice") || name.includes("#bob"))).toBe(true);
    await waitUntil(() => api.streams.length === 2);
  });
});
