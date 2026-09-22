import { describe, expect, it, vi } from "vitest";
import {
  decodeVapidKey,
  PushPermissionError,
  subscribeToPush,
  unsubscribeFromPush,
} from "../src/browser";

const VAPID_KEY =
  "BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U";

const SUBSCRIPTION = {
  endpoint: "https://push.example.com/sub/abc",
  keys: { p256dh: "p256-key", auth: "auth-key" },
};

function fakeRegistration(existing: unknown = null) {
  const subscribe = vi.fn(async () => ({
    toJSON: () => SUBSCRIPTION,
    endpoint: SUBSCRIPTION.endpoint,
    unsubscribe: async () => true,
  }));

  return {
    subscribe,
    registration: {
      pushManager: {
        getSubscription: async () => existing,
        subscribe,
      },
    } as unknown as ServiceWorkerRegistration,
  };
}

function fakeFetch(status = 200) {
  const calls: { url: string; body: unknown }[] = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? "null")) });
    return new Response(null, { status });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

/** Notification is absent in Node; the helper must tolerate that. */
const withPermission = (permission: NotificationPermission, run: () => Promise<void>) => {
  const original = (globalThis as Record<string, unknown>).Notification;
  (globalThis as Record<string, unknown>).Notification = {
    permission,
    requestPermission: async () => permission,
  };
  return run().finally(() => {
    (globalThis as Record<string, unknown>).Notification = original;
  });
};

describe("decodeVapidKey", () => {
  it("rejects a malformed key with an actionable message", () => {
    expect(() => decodeVapidKey("not a key!!")).toThrow(/base64url|65-byte/);
    expect(() => decodeVapidKey("c2hvcnQ")).toThrow(/65-byte/);
  });

  it("returns the raw 65 bytes the browser requires", () => {
    // A base64url string handed straight to applicationServerKey fails with an
    // opaque InvalidCharacterError.
    const key =
      "BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U";
    const bytes = decodeVapidKey(key);

    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes).toHaveLength(65);
    expect(bytes[0]).toBe(0x04);
  });
});

describe("subscribeToPush", () => {
  it("subscribes and posts the subscription to the server", async () => {
    const { registration, subscribe } = fakeRegistration();
    const { fetch, calls } = fakeFetch();

    await withPermission("granted", async () => {
      const result = await subscribeToPush({
        publicKey:
          "BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U",
        registration,
        fetch,
        baseUrl: "https://app.dev/api/notifications",
      });
      expect(result.endpoint).toBe(SUBSCRIPTION.endpoint);
    });

    expect(subscribe).toHaveBeenCalledWith(expect.objectContaining({ userVisibleOnly: true }));
    expect(calls[0]?.url).toBe("https://app.dev/api/notifications/push/devices");
    expect(calls[0]?.body).toEqual(SUBSCRIPTION);
  });

  it("reuses an existing subscription rather than creating a second", async () => {
    const existing = {
      toJSON: () => SUBSCRIPTION,
      endpoint: SUBSCRIPTION.endpoint,
      unsubscribe: async () => true,
    };
    const { registration, subscribe } = fakeRegistration(existing);
    const { fetch } = fakeFetch();

    await withPermission("granted", async () => {
      await subscribeToPush({ publicKey: VAPID_KEY, registration, fetch });
    });

    // Re-subscribing rotates the endpoint and orphans the stored row.
    expect(subscribe).not.toHaveBeenCalled();
  });

  it("throws when permission is denied instead of registering nothing", async () => {
    const { registration } = fakeRegistration();
    const { fetch, calls } = fakeFetch();

    await withPermission("denied", async () => {
      await expect(
        subscribeToPush({ publicKey: VAPID_KEY, registration, fetch }),
      ).rejects.toBeInstanceOf(PushPermissionError);
    });

    expect(calls).toHaveLength(0);
  });

  it("surfaces a failed device registration", async () => {
    const { registration } = fakeRegistration();
    const { fetch } = fakeFetch(401);

    await withPermission("granted", async () => {
      await expect(subscribeToPush({ publicKey: VAPID_KEY, registration, fetch })).rejects.toThrow(
        /401/,
      );
    });
  });
});

describe("unsubscribeFromPush", () => {
  it("tells the server before dropping the local subscription", async () => {
    const order: string[] = [];
    const existing = {
      toJSON: () => SUBSCRIPTION,
      endpoint: SUBSCRIPTION.endpoint,
      unsubscribe: async () => {
        order.push("browser");
        return true;
      },
    };

    const { registration } = fakeRegistration(existing);
    const fetch = (async () => {
      order.push("server");
      return new Response(null, { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    expect(await unsubscribeFromPush({ registration, fetch })).toBe(true);
    // Browser-first would leave a dead row the server keeps pushing to.
    expect(order).toEqual(["server", "browser"]);
  });

  it("is a no-op when nothing is subscribed", async () => {
    const { registration } = fakeRegistration(null);
    const { fetch, calls } = fakeFetch();

    expect(await unsubscribeFromPush({ registration, fetch })).toBe(false);
    expect(calls).toHaveLength(0);
  });
});
