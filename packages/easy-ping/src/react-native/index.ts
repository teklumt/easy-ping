import { useMemo, useRef } from "react";
import { AppState } from "react-native";
import { createNotifyClient, type NotifyClient, type NotifyClientOptions } from "../client";
import { type UseNotificationsResult, useNotifications as useClientNotifications } from "../react";

/** The slice of React Native's AppState the client needs; injectable for tests. */
export type AppStateLike = {
  currentState: string;
  addEventListener(type: "change", handler: (state: string) => void): { remove(): void };
};

export type NativeNotifyClientOptions = Omit<
  NotifyClientOptions,
  "locks" | "channel" | "serviceWorker" | "activityTarget" | "isDocumentHidden"
> & {
  /** Defaults to React Native's AppState. */
  appState?: AppStateLike | undefined;
};

type Listener = (event: { data?: unknown }) => void;

/**
 * Turns AppState into the "activity target" the client listens on: coming
 * back to the foreground counts as focus, so the bell refreshes at once and
 * polls at the fast interval again.
 */
function appStateTarget(appState: AppStateLike) {
  const listeners = new Map<string, Set<Listener>>();
  let subscription: { remove(): void } | undefined;
  let last = appState.currentState;

  const ensure = () => {
    subscription ??= appState.addEventListener("change", (state) => {
      if (state === "active" && last !== "active") {
        for (const listener of listeners.get("focus") ?? []) listener({});
      }
      last = state;
    });
  };

  return {
    addEventListener(type: string, handler: Listener) {
      listeners.set(type, (listeners.get(type) ?? new Set()).add(handler));
      ensure();
    },
    removeEventListener(type: string, handler: Listener) {
      listeners.get(type)?.delete(handler);
      if ([...listeners.values()].every((set) => set.size === 0)) {
        subscription?.remove();
        subscription = undefined;
      }
    },
  };
}

/**
 * The web client, wired for a phone: AppState decides hidden vs. active, one
 * app is one user so there is no tab leader to elect, and the event stream is
 * tried first. A fetch that cannot stream (React Native's built-in one) makes
 * the client fall back to polling on the first attempt; pass `fetch` from
 * `expo/fetch` to keep the live stream.
 */
export function createNativeNotifyClient(options: NativeNotifyClientOptions = {}): NotifyClient {
  const { appState = AppState, ...rest } = options;
  return createNotifyClient({
    transport: "sse",
    ...rest,
    locks: null,
    channel: null,
    serviceWorker: null,
    isDocumentHidden: () => appState.currentState !== "active",
    activityTarget: appStateTarget(appState),
  });
}

/** `useNotifications` for React Native. Same result shape as the web hook. */
export function useNotifications(
  options: NativeNotifyClientOptions & { client?: NotifyClient } = {},
): UseNotificationsResult {
  const {
    client: provided,
    baseUrl,
    limit,
    pollIntervalMs,
    maxPollIntervalMs,
    safetyNetMs,
    activeWindowMs,
    transport,
    scope,
    appState,
  } = options;

  // Held in a ref so a new fetch identity per render does not rebuild the client.
  const fetchRef = useRef(options.fetch);
  fetchRef.current = options.fetch;

  const client = useMemo(
    () =>
      provided ??
      createNativeNotifyClient({
        baseUrl,
        limit,
        pollIntervalMs,
        maxPollIntervalMs,
        safetyNetMs,
        activeWindowMs,
        transport,
        scope,
        appState,
        fetch: (...args) => (fetchRef.current ?? globalThis.fetch)(...args),
      }),
    [
      provided,
      baseUrl,
      limit,
      pollIntervalMs,
      maxPollIntervalMs,
      safetyNetMs,
      activeWindowMs,
      transport,
      scope,
      appState,
    ],
  );

  return useClientNotifications({ client });
}

export type RegisterMobilePushOptions = {
  /** The token from expo-notifications' getExpoPushTokenAsync(), or your provider's equivalent. */
  token: string;
  platform: "ios" | "android" | "web";
  deviceName?: string | undefined;
  baseUrl?: string | undefined;
  /** Your authenticated fetch. */
  fetch?: typeof globalThis.fetch | undefined;
};

const post = async (
  doFetch: typeof globalThis.fetch,
  url: string,
  body: unknown,
): Promise<Response> =>
  doFetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

/** Registers this device for the mobilePush channel. Idempotent: the same token refreshes its row. */
export async function registerMobilePushDevice(options: RegisterMobilePushOptions): Promise<void> {
  const base = (options.baseUrl ?? "/api/notifications").replace(/\/$/, "");
  const doFetch = options.fetch ?? globalThis.fetch;
  const response = await post(doFetch, `${base}/mobile-push/devices`, {
    token: options.token,
    platform: options.platform,
    deviceName: options.deviceName,
  });
  if (!response.ok) {
    const detail = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(detail.error ?? `registering the device failed: ${response.status}`);
  }
}

/** Removes this device. Resolves false when nothing was registered. */
export async function unregisterMobilePushDevice(
  options: Pick<RegisterMobilePushOptions, "token" | "baseUrl" | "fetch">,
): Promise<boolean> {
  const base = (options.baseUrl ?? "/api/notifications").replace(/\/$/, "");
  const doFetch = options.fetch ?? globalThis.fetch;
  const response = await post(doFetch, `${base}/mobile-push/devices/remove`, {
    token: options.token,
  });
  if (response.status === 404) return false;
  if (!response.ok) throw new Error(`unregistering the device failed: ${response.status}`);
  return true;
}

export type { NotificationView, NotifyClient, NotifyClientOptions, NotifyState } from "../client";
export type { UseNotificationsResult } from "../react";
