export type NotificationView = {
  id: string;
  userId: string;
  type: string;
  payload: unknown;
  actorId: string | null;
  groupKey: string | null;
  seenAt: string | null;
  readAt: string | null;
  createdAt: string;
};

export type NotifyState = {
  notifications: readonly NotificationView[];
  /** Badge count — cleared when the dropdown opens. Server-authoritative. */
  unseenCount: number;
  /** Items still bold. Derived from what is loaded, not a server total. */
  unreadCount: number;
  nextCursor: string | null;
  isLoading: boolean;
  error: Error | null;
};

export type NotifyClientOptions = {
  baseUrl?: string | undefined;
  fetch?: typeof globalThis.fetch | undefined;
  limit?: number | undefined;
  pollIntervalMs?: number | undefined;
  maxPollIntervalMs?: number | undefined;
  /** Injectable so the poller can be tested without a DOM. */
  isDocumentHidden?: (() => boolean) | undefined;
};

const INITIAL: NotifyState = {
  notifications: [],
  unseenCount: 0,
  unreadCount: 0,
  nextCursor: null,
  isLoading: true,
  error: null,
};

const countUnread = (rows: readonly NotificationView[]) =>
  rows.reduce((total, row) => (row.readAt === null ? total + 1 : total), 0);

export function createNotifyClient(options: NotifyClientOptions = {}) {
  const baseUrl = (options.baseUrl ?? "/api/notifications").replace(/\/$/, "");
  const doFetch = options.fetch ?? ((...args) => globalThis.fetch(...args));
  const limit = options.limit ?? 20;
  const pollIntervalMs = options.pollIntervalMs ?? 15_000;
  const maxPollIntervalMs = options.maxPollIntervalMs ?? 5 * 60_000;
  const isHidden =
    options.isDocumentHidden ??
    (() => typeof document !== "undefined" && document.visibilityState === "hidden");

  let state: NotifyState = INITIAL;
  const listeners = new Set<(state: NotifyState) => void>();

  let timer: ReturnType<typeof setTimeout> | undefined;
  let consecutiveFailures = 0;

  // Bumped per mutation so an in-flight poll cannot revert an optimistic update.
  let generation = 0;

  function set(patch: Partial<NotifyState>) {
    state = { ...state, ...patch };
    state = { ...state, unreadCount: countUnread(state.notifications) };
    for (const listener of listeners) listener(state);
  }

  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await doFetch(`${baseUrl}${path}`, {
      ...init,
      headers: { "content-type": "application/json", ...init?.headers },
    });
    if (!response.ok)
      throw new Error(`${init?.method ?? "GET"} ${path} failed: ${response.status}`);
    return (await response.json()) as T;
  }

  async function refresh(): Promise<void> {
    const startedAt = generation;

    // One request per poll; /count is only the fallback for a server too old to send unseenCount.
    const page = await request<{
      notifications: NotificationView[];
      nextCursor: string | null;
      unseenCount?: number;
    }>(`/?limit=${limit}`);

    const unseenCount = page.unseenCount ?? (await request<{ unseen: number }>("/count")).unseen;

    // A mutation landed while this was in flight; the response is stale.
    if (generation !== startedAt) return;

    set({
      notifications: page.notifications,
      nextCursor: page.nextCursor,
      unseenCount,
      isLoading: false,
      error: null,
    });
  }

  let loadingMore: Promise<void> | undefined;

  async function loadMore(): Promise<void> {
    if (!state.nextCursor) return;

    // Share the in-flight request so two clicks cannot append the same page twice.
    if (loadingMore) return loadingMore;

    const cursor = state.nextCursor;

    loadingMore = (async () => {
      try {
        const page = await request<{
          notifications: NotificationView[];
          nextCursor: string | null;
        }>(`/?limit=${limit}&cursor=${encodeURIComponent(cursor)}`);

        const known = new Set(state.notifications.map((row) => row.id));

        set({
          notifications: [
            ...state.notifications,
            ...page.notifications.filter((row) => !known.has(row.id)),
          ],
          nextCursor: page.nextCursor,
        });
      } finally {
        loadingMore = undefined;
      }
    })();

    return loadingMore;
  }

  /** Applies a patch immediately and reverts it if the request fails. */
  async function optimistic(
    apply: (rows: readonly NotificationView[]) => readonly NotificationView[],
    patch: Partial<NotifyState>,
    send: () => Promise<unknown>,
  ): Promise<void> {
    const previous = state;
    generation += 1;
    set({ notifications: apply(state.notifications), ...patch });

    try {
      await send();
    } catch (error) {
      generation += 1;
      state = previous;
      for (const listener of listeners) listener(state);
      throw error;
    }
  }

  const stamp = () => new Date().toISOString();

  async function markAsRead(id: string): Promise<void> {
    await optimistic(
      (rows) =>
        rows.map((row) => (row.id === id ? { ...row, readAt: row.readAt ?? stamp() } : row)),
      {},
      () => request("/read", { method: "POST", body: JSON.stringify({ ids: [id] }) }),
    );
  }

  async function markAllRead(): Promise<void> {
    await optimistic(
      (rows) => rows.map((row) => ({ ...row, readAt: row.readAt ?? stamp() })),
      {},
      () => request("/read-all", { method: "POST" }),
    );
  }

  async function markSeen(): Promise<void> {
    // Only what the user could have seen: no cutoff would mark newer arrivals seen too.
    const newest = state.notifications[0]?.createdAt;

    await optimistic(
      (rows) => rows.map((row) => ({ ...row, seenAt: row.seenAt ?? stamp() })),
      { unseenCount: 0 },
      () =>
        request("/seen", {
          method: "POST",
          body: JSON.stringify(newest ? { before: newest } : {}),
        }),
    );
  }

  function schedule(delay: number) {
    clearTimeout(timer);
    timer = setTimeout(tick, delay);
  }

  async function tick() {
    // A hidden tab is not looking at the bell.
    if (isHidden()) {
      schedule(pollIntervalMs);
      return;
    }

    try {
      await refresh();
      consecutiveFailures = 0;
    } catch (error) {
      consecutiveFailures += 1;
      set({ isLoading: false, error: error instanceof Error ? error : new Error(String(error)) });
    }

    // Back off on failure so an outage does not become a retry storm.
    schedule(
      consecutiveFailures === 0
        ? pollIntervalMs
        : Math.min(pollIntervalMs * 2 ** consecutiveFailures, maxPollIntervalMs),
    );
  }

  function subscribe(listener: (state: NotifyState) => void): () => void {
    listeners.add(listener);
    listener(state);

    // One poller regardless of how many components subscribe.
    if (listeners.size === 1) void tick();

    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) {
        clearTimeout(timer);
        timer = undefined;
      }
    };
  }

  return {
    subscribe,
    refresh,
    loadMore,
    markAsRead,
    markAllRead,
    markSeen,
    getState: () => state,
  };
}

export type NotifyClient = ReturnType<typeof createNotifyClient>;
