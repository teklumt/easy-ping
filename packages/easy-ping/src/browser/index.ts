// Everything here is injectable so it can be tested in Node.

export type PushSubscriptionPayload = {
  endpoint: string;
  keys: { p256dh: string; auth: string };
};

export type SubscribeOptions = {
  /** VAPID public key, base64url — the same one the server signs with. */
  publicKey: string;
  baseUrl?: string;
  serviceWorkerPath?: string;
  scope?: string;
  fetch?: typeof globalThis.fetch;
  /** Pre-resolved registration, so tests need no service worker. */
  registration?: ServiceWorkerRegistration;
};

export class PushUnsupportedError extends Error {
  constructor(reason: string) {
    super(`web push is unavailable: ${reason}`);
    this.name = "PushUnsupportedError";
  }
}

export class PushPermissionError extends Error {
  constructor(readonly permission: NotificationPermission) {
    super(`notification permission was ${permission}`);
    this.name = "PushPermissionError";
  }
}

export function isPushSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    "serviceWorker" in navigator &&
    typeof PushManager !== "undefined" &&
    typeof Notification !== "undefined"
  );
}

/** applicationServerKey must be raw bytes, not the base64url string. */
export function decodeVapidKey(publicKey: string): Uint8Array<ArrayBuffer> {
  const padded = publicKey.padEnd(publicKey.length + ((4 - (publicKey.length % 4)) % 4), "=");

  let binary: string;
  try {
    binary = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
  } catch {
    throw new Error("VAPID publicKey is not valid base64url");
  }

  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  if (bytes.length !== 65 || bytes[0] !== 0x04) {
    throw new Error(
      `VAPID publicKey must be a 65-byte uncompressed EC point, got ${bytes.length} bytes`,
    );
  }
  return bytes;
}

async function resolveRegistration(options: SubscribeOptions): Promise<ServiceWorkerRegistration> {
  if (options.registration) return options.registration;
  if (!isPushSupported()) throw new PushUnsupportedError("this browser has no PushManager");

  const path = options.serviceWorkerPath ?? "/sw.js";
  const registration = await navigator.serviceWorker.register(
    path,
    options.scope ? { scope: options.scope } : undefined,
  );

  // subscribe() before the worker is active rejects.
  await navigator.serviceWorker.ready;
  return registration;
}

/** Registers the worker, asks permission, subscribes, and registers the subscription with the server. */
export async function subscribeToPush(options: SubscribeOptions): Promise<PushSubscriptionPayload> {
  const registration = await resolveRegistration(options);

  if (typeof Notification !== "undefined") {
    const permission =
      Notification.permission === "default"
        ? await Notification.requestPermission()
        : Notification.permission;

    if (permission !== "granted") throw new PushPermissionError(permission);
  }

  const existing = await registration.pushManager.getSubscription();
  const subscription =
    existing ??
    (await registration.pushManager.subscribe({
      // Required by Chrome; a silent push is rejected outright.
      userVisibleOnly: true,
      applicationServerKey: decodeVapidKey(options.publicKey),
    }));

  const payload = subscription.toJSON() as PushSubscriptionPayload;
  const doFetch = options.fetch ?? globalThis.fetch;
  const baseUrl = (options.baseUrl ?? "/api/notifications").replace(/\/$/, "");

  const response = await doFetch(`${baseUrl}/push/devices`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({ endpoint: payload.endpoint, keys: payload.keys }),
  });

  if (!response.ok) {
    throw new Error(`registering the push device failed: ${response.status}`);
  }

  return payload;
}

/** Tells the server first: a browser-only unsubscribe leaves a dead row behind. */
export async function unsubscribeFromPush(
  options: Omit<SubscribeOptions, "publicKey">,
): Promise<boolean> {
  const registration = await resolveRegistration({ ...options, publicKey: "" });
  const subscription = await registration.pushManager.getSubscription();
  if (!subscription) return false;

  const doFetch = options.fetch ?? globalThis.fetch;
  const baseUrl = (options.baseUrl ?? "/api/notifications").replace(/\/$/, "");

  await doFetch(`${baseUrl}/push/devices/remove`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({ endpoint: subscription.endpoint }),
  }).catch(() => undefined);

  return subscription.unsubscribe();
}
