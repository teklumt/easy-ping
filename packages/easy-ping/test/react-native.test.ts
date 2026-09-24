import { afterEach, describe, expect, it } from "vitest";
import {
  createNativeNotifyClient,
  registerMobilePushDevice,
  unregisterMobilePushDevice,
} from "../src/react-native";
import { AppState } from "./helpers/react-native-stub";
import { waitUntil } from "./helpers/wait";

type Row = { id: string; readAt: string | null; seenAt: string | null };

/** A server whose fetch cannot stream: React Native's built-in fetch returns a null body for SSE. */
function server(options: { streaming: boolean } = { streaming: false }) {
  const calls: string[] = [];
  const rows: Row[] = [{ id: "a", readAt: null, seenAt: null }];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url).replace("https://app.dev/api/notifications", "");
    calls.push(`${init?.method ?? "GET"} ${path}`);
    if (path === "/events") {
      if (!options.streaming) return new Response(null, { status: 200 });
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("event: ready\ndata: {}\n\n"));
          init?.signal?.addEventListener("abort", () => {
            try {
              controller.close();
            } catch {}
          });
        },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    }
    if (path.includes("/count")) return Response.json({ unseen: 1 });
    if (path.startsWith("/mobile-push/devices/remove")) {
      const body = JSON.parse(String(init?.body)) as { token: string };
      return body.token === "known"
        ? Response.json({ ok: true })
        : new Response(null, { status: 404 });
    }
    if (path.startsWith("/mobile-push/devices")) {
      const body = JSON.parse(String(init?.body)) as { token: string };
      return body.token.startsWith("ExponentPushToken[")
        ? Response.json({ ok: true })
        : Response.json({ error: "token is not a valid expo-push push token" }, { status: 400 });
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
  return { fetch, calls, pages: () => calls.filter((c) => c.startsWith("GET /?")).length };
}

const stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  AppState.set("active");
});

describe("createNativeNotifyClient", () => {
  it("falls back to polling on the first attempt when fetch cannot stream", async () => {
    const api = server({ streaming: false });
    const client = createNativeNotifyClient({
      baseUrl: "https://app.dev/api/notifications",
      fetch: api.fetch,
      appState: AppState,
    });
    stops.push(client.subscribe(() => {}));
    await waitUntil(() => client.getTransport().transport === "poll");
    await waitUntil(() => api.pages() === 1);
    expect(api.calls.filter((c) => c === "GET /events")).toHaveLength(1);
    expect(client.getTransport()).toEqual({ role: "solo", transport: "poll", connected: false });
  });

  it("keeps the live stream when the fetch can stream (expo/fetch)", async () => {
    const api = server({ streaming: true });
    const client = createNativeNotifyClient({
      baseUrl: "https://app.dev/api/notifications",
      fetch: api.fetch,
      appState: AppState,
    });
    stops.push(client.subscribe(() => {}));
    await waitUntil(() => client.getTransport().connected);
    expect(client.getTransport().transport).toBe("sse");
  });

  it("treats the background as hidden and a return to the foreground as activity", async () => {
    const api = server();
    const client = createNativeNotifyClient({
      baseUrl: "https://app.dev/api/notifications",
      fetch: api.fetch,
      appState: AppState,
      pollIntervalMs: 30,
    });
    stops.push(client.subscribe(() => {}));
    await waitUntil(() => api.pages() >= 1);

    AppState.set("background");
    const before = api.pages();
    await new Promise((resolve) => setTimeout(resolve, 150));
    // Hidden: the poller reschedules without fetching.
    expect(api.pages() - before).toBeLessThanOrEqual(1);

    AppState.set("active");
    await waitUntil(() => api.pages() > before + 1);
    expect(AppState.listenerCount()).toBe(1);
  });

  it("removes its AppState listener when the last subscriber leaves", async () => {
    const api = server();
    const client = createNativeNotifyClient({
      baseUrl: "https://app.dev/api/notifications",
      fetch: api.fetch,
      appState: AppState,
    });
    const stop = client.subscribe(() => {});
    expect(AppState.listenerCount()).toBe(1);
    stop();
    expect(AppState.listenerCount()).toBe(0);
  });
});

describe("device registration helpers", () => {
  it("posts the token and platform, and surfaces the server's error", async () => {
    const api = server();
    await registerMobilePushDevice({
      baseUrl: "https://app.dev/api/notifications",
      fetch: api.fetch,
      token: "ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]",
      platform: "ios",
      deviceName: "iPhone",
    });
    expect(api.calls.at(-1)).toBe("POST /mobile-push/devices");
    await expect(
      registerMobilePushDevice({
        baseUrl: "https://app.dev/api/notifications",
        fetch: api.fetch,
        token: "garbage",
        platform: "ios",
      }),
    ).rejects.toThrow(/not a valid/);
  });

  it("reports whether an unregister removed anything", async () => {
    const api = server();
    const base = { baseUrl: "https://app.dev/api/notifications", fetch: api.fetch };
    expect(await unregisterMobilePushDevice({ ...base, token: "known" })).toBe(true);
    expect(await unregisterMobilePushDevice({ ...base, token: "unknown" })).toBe(false);
  });
});
