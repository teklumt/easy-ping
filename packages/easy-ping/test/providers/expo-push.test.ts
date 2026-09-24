import { describe, expect, it } from "vitest";
import { EXPO_SEND_BATCH, expoPush, isExpoPushToken } from "../../src/providers/expo-push";

const T = (n: number) => `ExponentPushToken[${String(n).padStart(22, "x")}]`;

/** Expo's push service in miniature: records requests, answers per the script. */
function fakeExpo(script: (path: string, body: unknown) => Response) {
  const calls: { path: string; headers: Record<string, string>; body: unknown }[] = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    const body = JSON.parse(String(init?.body));
    calls.push({ path, headers: (init?.headers as Record<string, string>) ?? {}, body });
    return script(path, body);
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

const okTickets = (messages: unknown[]) =>
  Response.json({ data: messages.map((_, i) => ({ status: "ok", id: `ticket-${i}` })) });

describe("expoPush", () => {
  it("validates token shapes", () => {
    expect(isExpoPushToken(T(1))).toBe(true);
    expect(isExpoPushToken("ExpoPushToken[abcdefgh12345678]")).toBe(true);
    for (const bad of ["", "abc", "ExponentPushToken[]", "ExponentPushToken[short]", "https://x"]) {
      expect(isExpoPushToken(bad)).toBe(false);
    }
  });

  it("sends the message shape Expo expects and returns tickets in order", async () => {
    const api = fakeExpo((_, body) => okTickets(body as unknown[]));
    const provider = expoPush({ fetch: api.fetch, accessToken: "secret-access" });

    const tickets = await provider.send([
      { token: T(1), title: "New", body: "hello", data: { id: "n1" }, badge: 3 },
      { token: T(2), title: "New", body: "hello", sound: null, channelId: "alerts" },
    ]);

    expect(tickets).toEqual([
      { ok: true, ticketId: "ticket-0" },
      { ok: true, ticketId: "ticket-1" },
    ]);
    expect(api.calls[0]?.path).toBe("/--/api/v2/push/send");
    expect(api.calls[0]?.headers.authorization).toBe("Bearer secret-access");
    expect(api.calls[0]?.body).toEqual([
      { to: T(1), title: "New", body: "hello", data: { id: "n1" }, badge: 3, sound: "default" },
      { to: T(2), title: "New", body: "hello", sound: null, channelId: "alerts" },
    ]);
  });

  it("splits into batches of 100", async () => {
    const api = fakeExpo((_, body) => okTickets(body as unknown[]));
    const provider = expoPush({ fetch: api.fetch });
    const messages = Array.from({ length: 250 }, (_, i) => ({
      token: T(i),
      title: "t",
      body: "b",
    }));
    const tickets = await provider.send(messages);
    expect(tickets).toHaveLength(250);
    expect(api.calls.map((c) => (c.body as unknown[]).length)).toEqual([EXPO_SEND_BATCH, 100, 50]);
  });

  it("classifies per-token errors: gone, retryable, permanent", async () => {
    const api = fakeExpo(() =>
      Response.json({
        data: [
          { status: "error", message: "not registered", details: { error: "DeviceNotRegistered" } },
          { status: "error", message: "slow down", details: { error: "MessageRateExceeded" } },
          { status: "error", message: "too big", details: { error: "MessageTooBig" } },
          { status: "ok", id: "t" },
        ],
      }),
    );
    const tickets = await expoPush({ fetch: api.fetch }).send([
      { token: T(1), title: "t", body: "b" },
      { token: T(2), title: "t", body: "b" },
      { token: T(3), title: "t", body: "b" },
      { token: T(4), title: "t", body: "b" },
    ]);
    expect(tickets[0]).toMatchObject({ ok: false, gone: true, retryable: false });
    expect(tickets[1]).toMatchObject({ ok: false, gone: false, retryable: true });
    expect(tickets[2]).toMatchObject({ ok: false, gone: false, retryable: false });
    expect(tickets[3]).toEqual({ ok: true, ticketId: "t" });
  });

  it("treats a 5xx or network failure as retryable for the whole batch, a 4xx as permanent", async () => {
    const down = fakeExpo(() => new Response("upstream", { status: 503 }));
    const a = await expoPush({ fetch: down.fetch }).send([{ token: T(1), title: "t", body: "b" }]);
    expect(a[0]).toMatchObject({ ok: false, retryable: true, gone: false });

    const forbidden = fakeExpo(
      () => new Response("bad access token secret-access", { status: 401 }),
    );
    const b = await expoPush({ fetch: forbidden.fetch, accessToken: "secret-access" }).send([
      { token: T(1), title: "t", body: "b" },
    ]);
    expect(b[0]).toMatchObject({ ok: false, retryable: false });
    if (!b[0]?.ok) {
      expect(b[0]?.error).not.toContain("secret-access");
      expect(b[0]?.error).toContain("<token>");
    }
  });

  it("fetches receipts and flags devices the service later found gone", async () => {
    const api = fakeExpo(() =>
      Response.json({
        data: {
          "ticket-1": { status: "ok" },
          "ticket-2": {
            status: "error",
            message: "gone",
            details: { error: "DeviceNotRegistered" },
          },
        },
      }),
    );
    const receipts = await expoPush({ fetch: api.fetch }).receipts?.(["ticket-1", "ticket-2"]);
    expect(api.calls[0]).toMatchObject({
      path: "/--/api/v2/push/getReceipts",
      body: { ids: ["ticket-1", "ticket-2"] },
    });
    expect(receipts).toEqual([
      { ticketId: "ticket-1", ok: true },
      expect.objectContaining({ ticketId: "ticket-2", ok: false, gone: true }),
    ]);
  });
});
