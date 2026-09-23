import { beforeEach, describe, expect, it, vi } from "vitest";
import { createNotifyClient, type NotifyState } from "../src/client";
import { waitUntil } from "./helpers/wait";

type Row = {
  id: string;
  readAt: string | null;
  seenAt: string | null;
};

function server(initial: Row[] = []) {
  let rows = initial;
  let unseen = initial.filter((r) => r.seenAt === null).length;
  const calls: string[] = [];
  let failNext = 0;

  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url);
    calls.push(`${init?.method ?? "GET"} ${path}`);

    if (failNext > 0) {
      failNext -= 1;
      return new Response("nope", { status: 500 });
    }

    if (path.includes("/count")) return Response.json({ unseen });
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
      unseen = 0;
      return Response.json({ ok: true });
    }

    const cursor = new URL(path, "https://x.dev").searchParams.get("cursor");
    const page = cursor ? rows.slice(2) : rows.slice(0, 2);
    return Response.json({
      notifications: page.map((r) => ({
        ...r,
        userId: "u1",
        type: "t",
        payload: {},
        actorId: null,
        groupKey: null,
        createdAt: "2026-01-01T00:00:00.000Z",
      })),
      nextCursor: cursor ? null : rows.length > 2 ? "cursor2" : null,
    });
  }) as unknown as typeof globalThis.fetch;

  return {
    fetch,
    calls,
    failOnce: () => {
      failNext = 1;
    },
    get rows() {
      return rows;
    },
  };
}

const row = (id: string, read = false, seen = false): Row => ({
  id,
  readAt: read ? "before" : null,
  seenAt: seen ? "before" : null,
});

const client = (api: ReturnType<typeof server>, extra = {}) =>
  createNotifyClient({
    fetch: api.fetch,
    baseUrl: "https://app.dev/api/notifications",
    isDocumentHidden: () => false,
    ...extra,
  });

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("notify client", () => {
  beforeEach(() => vi.useRealTimers());

  it("loads notifications and the unseen count on subscribe", async () => {
    const api = server([row("a"), row("b")]);
    const states: NotifyState[] = [];

    const unsubscribe = client(api).subscribe((s) => states.push(s));
    await settle();
    unsubscribe();

    const last = states.at(-1);
    expect(last?.notifications).toHaveLength(2);
    expect(last?.unseenCount).toBe(2);
    expect(last?.isLoading).toBe(false);
  });

  it("derives unreadCount from loaded rows", async () => {
    const api = server([row("a"), row("b", true)]);
    const instance = client(api);

    const unsubscribe = instance.subscribe(() => {});
    await settle();

    expect(instance.getState().unreadCount).toBe(1);
    unsubscribe();
  });

  it("applies markAsRead optimistically before the request resolves", async () => {
    const api = server([row("a"), row("b")]);
    const instance = client(api);
    const unsubscribe = instance.subscribe(() => {});
    await settle();

    const pending = instance.markAsRead("a");
    // Asserted before awaiting: the UI must not wait for the round trip.
    expect(instance.getState().notifications.find((n) => n.id === "a")?.readAt).not.toBeNull();

    await pending;
    unsubscribe();
  });

  it("rolls back an optimistic update when the request fails", async () => {
    const api = server([row("a"), row("b")]);
    const instance = client(api);
    const unsubscribe = instance.subscribe(() => {});
    await settle();

    api.failOnce();
    await expect(instance.markAsRead("a")).rejects.toThrow();

    expect(instance.getState().notifications.find((n) => n.id === "a")?.readAt).toBeNull();
    expect(instance.getState().unreadCount).toBe(2);
    unsubscribe();
  });

  it("clears the badge on markSeen and restores it on failure", async () => {
    const api = server([row("a"), row("b")]);
    const instance = client(api);
    const unsubscribe = instance.subscribe(() => {});
    await settle();

    api.failOnce();
    await expect(instance.markSeen()).rejects.toThrow();
    expect(instance.getState().unseenCount).toBe(2);

    await instance.markSeen();
    expect(instance.getState().unseenCount).toBe(0);
    unsubscribe();
  });

  it("appends the next page via the cursor", async () => {
    const api = server([row("a"), row("b"), row("c")]);
    const instance = client(api);
    const unsubscribe = instance.subscribe(() => {});
    await settle();

    expect(instance.getState().notifications).toHaveLength(2);
    await instance.loadMore();

    expect(instance.getState().notifications.map((n) => n.id)).toEqual(["a", "b", "c"]);
    expect(instance.getState().nextCursor).toBeNull();
    unsubscribe();
  });

  it("runs one poller no matter how many components subscribe", async () => {
    const api = server([row("a")]);
    const instance = client(api);

    const first = instance.subscribe(() => {});
    const second = instance.subscribe(() => {});
    const third = instance.subscribe(() => {});
    await settle();

    // Two calls total (feed + count), not six — otherwise a second bell or a
    // StrictMode double-mount multiplies the request rate.
    expect(api.calls).toHaveLength(2);

    first();
    second();
    third();
  });

  it("does not poll while the tab is hidden", async () => {
    const api = server([row("a")]);
    let hidden = true;
    const instance = createNotifyClient({
      fetch: api.fetch,
      baseUrl: "https://app.dev/api/notifications",
      pollIntervalMs: 10,
      isDocumentHidden: () => hidden,
    });

    const unsubscribe = instance.subscribe(() => {});
    await settle();
    expect(api.calls).toHaveLength(0);

    hidden = false;
    await waitUntil(() => api.calls.length > 0);
    expect(api.calls.length).toBeGreaterThan(0);
    unsubscribe();
  });

  it("surfaces an error and keeps the last good data", async () => {
    const api = server([row("a")]);
    const instance = client(api);
    const unsubscribe = instance.subscribe(() => {});
    await settle();

    api.failOnce();
    await expect(instance.refresh()).rejects.toThrow();

    expect(instance.getState().notifications).toHaveLength(1);
    unsubscribe();
  });

  it("discards a poll that was in flight when a mutation landed", async () => {
    // Found by the e2e suite: a poll started before markSeen must not overwrite the optimistic count.
    const api = server([row("a"), row("b")]);

    let releaseSlowPoll: (() => void) | undefined;
    let pollCount = 0;

    const slowFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const path = String(url);
      if (path.includes("/count") && pollCount++ === 0) {
        await new Promise<void>((resolve) => {
          releaseSlowPoll = resolve;
        });
      }
      return api.fetch(url as string, init);
    }) as unknown as typeof globalThis.fetch;

    const instance = createNotifyClient({
      fetch: slowFetch,
      baseUrl: "https://app.dev/api/notifications",
      isDocumentHidden: () => false,
    });

    const unsubscribe = instance.subscribe(() => {});
    await settle();

    // Mutation completes while the first poll is still stalled.
    await instance.markSeen();
    expect(instance.getState().unseenCount).toBe(0);

    releaseSlowPoll?.();
    await settle();

    expect(instance.getState().unseenCount).toBe(0);
    unsubscribe();
  });

  it("stops polling once the last subscriber leaves", async () => {
    const api = server([row("a")]);
    const instance = createNotifyClient({
      fetch: api.fetch,
      baseUrl: "https://app.dev/api/notifications",
      pollIntervalMs: 10,
      isDocumentHidden: () => false,
    });

    const unsubscribe = instance.subscribe(() => {});
    await settle();
    unsubscribe();

    const after = api.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(api.calls.length).toBe(after);
  });
});
