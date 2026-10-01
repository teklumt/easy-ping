"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createNotifyClient,
  type NotifyClient,
  type NotifyClientOptions,
  type NotifyState,
} from "../client";

export type UseNotificationsResult = NotifyState & {
  markAsRead: (id: string) => Promise<void>;
  markAllRead: () => Promise<void>;
  markSeen: () => Promise<void>;
  loadMore: () => Promise<void>;
  refresh: () => Promise<void>;
};

/** State lives in the framework-agnostic client; this only wires React's lifecycle. */
export function useNotifications(
  options: NotifyClientOptions & { client?: NotifyClient } = {},
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
    locks,
    channel,
    serviceWorker,
    activityTarget,
    now,
  } = options;

  // Held in a ref so a new callback identity per render does not rebuild the client.
  const callbacksRef = useRef(options);
  callbacksRef.current = options;

  const client = useMemo(
    () =>
      provided ??
      createNotifyClient({
        baseUrl,
        limit,
        pollIntervalMs,
        maxPollIntervalMs,
        safetyNetMs,
        activeWindowMs,
        transport,
        scope,
        locks,
        channel,
        serviceWorker,
        activityTarget,
        now,
        fetch: (...args) => (callbacksRef.current.fetch ?? globalThis.fetch)(...args),
        isDocumentHidden: () =>
          callbacksRef.current.isDocumentHidden?.() ??
          (typeof document !== "undefined" && document.visibilityState === "hidden"),
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
      locks,
      channel,
      serviceWorker,
      activityTarget,
      now,
    ],
  );

  const [state, setState] = useState<NotifyState>(() => client.getState());

  useEffect(() => client.subscribe(setState), [client]);

  return {
    ...state,
    markAsRead: useCallback((id: string) => client.markAsRead(id), [client]),
    markAllRead: useCallback(() => client.markAllRead(), [client]),
    markSeen: useCallback(() => client.markSeen(), [client]),
    loadMore: useCallback(() => client.loadMore(), [client]),
    refresh: useCallback(() => client.refresh(), [client]),
  };
}

export type {
  NotificationView,
  NotifyClient,
  NotifyClientOptions,
  NotifyState,
} from "../client";
export { createNotifyClient } from "../client";
