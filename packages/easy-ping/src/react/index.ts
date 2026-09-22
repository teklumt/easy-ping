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

/**
 * All state and optimistic-rollback logic lives in the framework-agnostic
 * client; this binding only wires it to React's lifecycle.
 */
export function useNotifications(
  options: NotifyClientOptions & { client?: NotifyClient } = {},
): UseNotificationsResult {
  const { client: provided, baseUrl, limit, pollIntervalMs, maxPollIntervalMs } = options;

  // Callbacks are usually inline literals. Held in a ref and called through a
  // stable wrapper so a new function identity each render does not rebuild the
  // client and restart polling.
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
        fetch: (...args) => (callbacksRef.current.fetch ?? globalThis.fetch)(...args),
        isDocumentHidden: () =>
          callbacksRef.current.isDocumentHidden?.() ??
          (typeof document !== "undefined" && document.visibilityState === "hidden"),
      }),
    [provided, baseUrl, limit, pollIntervalMs, maxPollIntervalMs],
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
