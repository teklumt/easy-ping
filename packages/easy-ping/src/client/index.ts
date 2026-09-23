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

export type Transport = "auto" | "sse" | "poll";

export type TransportStatus = {
  /** "leader" holds this browser's single connection; "follower" mirrors it; "solo" has no Web Locks. */
  role: "leader" | "follower" | "solo";
  /** What the leader is using right now. */
  transport: "sse" | "poll";
  /** True while the event stream has said `ready` and not since closed. */
  connected: boolean;
};

type LockManagerLike = {
  request(
    name: string,
    options: { mode: "exclusive"; signal?: AbortSignal },
    callback: () => Promise<void>,
  ): Promise<void>;
};

type ChannelLike = {
  postMessage(message: unknown): void;
  addEventListener(type: "message", handler: (event: { data: unknown }) => void): void;
  removeEventListener(type: "message", handler: (event: { data: unknown }) => void): void;
  close(): void;
};

type MessageTargetLike = {
  addEventListener(type: string, handler: (event: { data?: unknown }) => void): void;
  removeEventListener(type: string, handler: (event: { data?: unknown }) => void): void;
};

export type NotifyClientOptions = {
  baseUrl?: string | undefined;
  fetch?: typeof globalThis.fetch | undefined;
  limit?: number | undefined;
  /** Poll interval while the user is active and no stream is connected. Default 15 s. */
  pollIntervalMs?: number | undefined;
  /** Ceiling the idle backoff grows to. Default 10 min. */
  maxPollIntervalMs?: number | undefined;
  /** Poll interval while the event stream is connected: a safety net. Default 5 min. */
  safetyNetMs?: number | undefined;
  /** How long after user input polling stays at the base interval. Default 60 s. */
  activeWindowMs?: number | undefined;
  /** "auto" streams when a DOM is present, "poll" never streams, "sse" always tries. */
  transport?: Transport | undefined;
  /** Injectable so the poller can be tested without a DOM. */
  isDocumentHidden?: (() => boolean) | undefined;
  /** Web Locks, for one connection per browser. Defaults to navigator.locks; null disables. */
  locks?: LockManagerLike | null | undefined;
  /** Cross-tab channel factory. Defaults to BroadcastChannel; null disables. */
  channel?: (() => ChannelLike) | null | undefined;
  /** Where push relays arrive. Defaults to navigator.serviceWorker; null disables. */
  serviceWorker?: MessageTargetLike | null | undefined;
  /** Where user activity is observed. Defaults to window; null disables. */
  activityTarget?: MessageTargetLike | null | undefined;
  now?: (() => number) | undefined;
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

/** A stream that dies this fast, repeatedly, is being cut by the platform: stop trying. */
const SHORT_STREAM_MS = 15_000;
const SHORT_STREAMS_BEFORE_GIVING_UP = 3;

type TabMessage =
  | { type: "hello" }
  | { type: "state"; state: NotifyState }
  | { type: "mutated" }
  | { type: "leader" };

export function createNotifyClient(options: NotifyClientOptions = {}) {
  const baseUrl = (options.baseUrl ?? "/api/notifications").replace(/\/$/, "");
  const doFetch = options.fetch ?? ((...args) => globalThis.fetch(...args));
  const limit = options.limit ?? 20;
  const pollIntervalMs = options.pollIntervalMs ?? 15_000;
  const maxPollIntervalMs = options.maxPollIntervalMs ?? 10 * 60_000;
  const safetyNetMs = options.safetyNetMs ?? 5 * 60_000;
  const activeWindowMs = options.activeWindowMs ?? 60_000;
  const now = options.now ?? (() => Date.now());
  const hasDom = typeof window !== "undefined" && typeof document !== "undefined";
  const transport: Transport = options.transport ?? "auto";
  const wantsStream = transport === "sse" || (transport === "auto" && hasDom);
  const isHidden =
    options.isDocumentHidden ??
    (() => typeof document !== "undefined" && document.visibilityState === "hidden");

  const locks =
    options.locks === undefined
      ? typeof navigator !== "undefined"
        ? ((navigator as { locks?: LockManagerLike }).locks ?? null)
        : null
      : options.locks;
  const makeChannel =
    options.channel === undefined
      ? typeof BroadcastChannel !== "undefined"
        ? () => new BroadcastChannel(`easy-ping:${baseUrl}`) as unknown as ChannelLike
        : null
      : options.channel;
  const serviceWorker =
    options.serviceWorker === undefined
      ? typeof navigator !== "undefined"
        ? ((navigator as { serviceWorker?: MessageTargetLike }).serviceWorker ?? null)
        : null
      : options.serviceWorker;
  const activityTarget =
    options.activityTarget === undefined
      ? hasDom
        ? (window as unknown as MessageTargetLike)
        : null
      : options.activityTarget;

  let state: NotifyState = INITIAL;
  const listeners = new Set<(state: NotifyState) => void>();

  let role: TransportStatus["role"] = "solo";
  let running = false;
  let channel: ChannelLike | undefined;
  let releaseLock: (() => void) | undefined;
  let lockAbort: AbortController | undefined;

  let timer: ReturnType<typeof setTimeout> | undefined;
  let consecutiveFailures = 0;
  let idleTicks = 0;
  let activeUntil = 0;
  let lastRefreshAt = 0;
  let refreshing: Promise<void> | undefined;
  let refreshAgain = false;

  let streamAbort: AbortController | undefined;
  let streamConnected = false;
  let streamDisabled = !wantsStream;
  let shortStreams = 0;
  let streamFailures = 0;

  // Bumped per mutation so an in-flight poll cannot revert an optimistic update.
  let generation = 0;

  // A follower's own optimistic changes, kept until the leader's state reflects them.
  const localReads = new Set<string>();
  let localSeen = false;

  const stamp = () => new Date().toISOString();

  function emit() {
    for (const listener of listeners) listener(state);
  }

  function set(patch: Partial<NotifyState>) {
    state = { ...state, ...patch };
    state = { ...state, unreadCount: countUnread(state.notifications) };
    emit();
    if (role === "leader") post({ type: "state", state });
  }

  function post(message: TabMessage) {
    try {
      channel?.postMessage(message);
    } catch {
      // channel closed
    }
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

  async function fetchPage(): Promise<void> {
    const startedAt = generation;

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

  /** Coalesces overlapping calls: a second request while one is in flight runs once after it. */
  function refresh(): Promise<void> {
    if (refreshing) {
      refreshAgain = true;
      return refreshing;
    }
    refreshing = (async () => {
      try {
        do {
          refreshAgain = false;
          await fetchPage();
          lastRefreshAt = now();
        } while (refreshAgain);
      } finally {
        refreshing = undefined;
      }
    })();
    return refreshing;
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
      if (role === "follower") post({ type: "mutated" });
    } catch (error) {
      generation += 1;
      state = previous;
      emit();
      throw error;
    }
  }

  async function markAsRead(id: string): Promise<void> {
    if (role === "follower") localReads.add(id);
    await optimistic(
      (rows) =>
        rows.map((row) => (row.id === id ? { ...row, readAt: row.readAt ?? stamp() } : row)),
      {},
      () => request("/read", { method: "POST", body: JSON.stringify({ ids: [id] }) }),
    ).catch((error) => {
      localReads.delete(id);
      throw error;
    });
  }

  async function markAllRead(): Promise<void> {
    if (role === "follower") for (const row of state.notifications) localReads.add(row.id);
    await optimistic(
      (rows) => rows.map((row) => ({ ...row, readAt: row.readAt ?? stamp() })),
      {},
      () => request("/read-all", { method: "POST" }),
    ).catch((error) => {
      localReads.clear();
      throw error;
    });
  }

  async function markSeen(): Promise<void> {
    // Only what the user could have seen: no cutoff would mark newer arrivals seen too.
    const newest = state.notifications[0]?.createdAt;
    if (role === "follower") localSeen = true;

    await optimistic(
      (rows) => rows.map((row) => ({ ...row, seenAt: row.seenAt ?? stamp() })),
      { unseenCount: 0 },
      () =>
        request("/seen", {
          method: "POST",
          body: JSON.stringify(newest ? { before: newest } : {}),
        }),
    ).catch((error) => {
      localSeen = false;
      throw error;
    });
  }

  // ---- follower: mirror the leader, keep own optimistic changes until confirmed ----

  function applyRemoteState(remote: NotifyState) {
    const notifications = remote.notifications.map((row) => {
      if (!localReads.has(row.id)) return row;
      if (row.readAt) {
        localReads.delete(row.id);
        return row;
      }
      return { ...row, readAt: stamp() };
    });
    if (localSeen && remote.unseenCount === 0) localSeen = false;
    state = {
      ...remote,
      notifications,
      unseenCount: localSeen ? 0 : remote.unseenCount,
      unreadCount: countUnread(notifications),
    };
    emit();
  }

  function onTabMessage(event: { data: unknown }) {
    const message = event.data as TabMessage | null;
    if (!message || typeof message !== "object") return;
    if (role === "leader") {
      if (message.type === "hello") post({ type: "state", state });
      else if (message.type === "mutated") void refresh().catch(() => {});
      return;
    }
    if (message.type === "state") applyRemoteState(message.state);
  }

  // ---- leader / solo: polling with activity-shaped backoff ----

  function schedule(delay: number) {
    clearTimeout(timer);
    timer = setTimeout(tick, delay);
  }

  function nextDelay(): number {
    if (consecutiveFailures > 0) {
      return Math.min(pollIntervalMs * 2 ** consecutiveFailures, maxPollIntervalMs);
    }
    if (streamConnected) return safetyNetMs;
    if (now() < activeUntil) return pollIntervalMs;
    idleTicks += 1;
    return Math.min(pollIntervalMs * 2 ** idleTicks, maxPollIntervalMs);
  }

  async function tick() {
    if (!running) return;
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

    if (running) schedule(nextDelay());
  }

  /** User input or a returning tab: poll fast again, and catch up now if the last refresh is stale. */
  function onActivity() {
    if (!running || role === "follower") return;
    activeUntil = now() + activeWindowMs;
    idleTicks = 0;
    if (!isHidden() && now() - lastRefreshAt > pollIntervalMs) {
      void refresh().catch(() => {});
      schedule(nextDelay());
    }
  }

  const onVisibility = () => {
    if (!isHidden()) onActivity();
  };

  const ACTIVITY_EVENTS = ["focus", "pointerdown", "keydown", "online"];

  // ---- leader / solo: the event stream ----

  function changed() {
    if (!running) return;
    void refresh().catch(() => {});
  }

  async function readStream(signal: AbortSignal): Promise<void> {
    const openedAt = now();
    const response = await doFetch(`${baseUrl}/events`, {
      headers: { accept: "text/event-stream" },
      signal,
    });
    if (!response.ok || !response.body) throw new Error(`GET /events failed: ${response.status}`);

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let eventName = "";

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          const line = buffer.slice(0, newline).replace(/\r$/, "");
          buffer = buffer.slice(newline + 1);
          if (line === "") {
            if (eventName === "ready") {
              streamConnected = true;
              streamFailures = 0;
              schedule(nextDelay());
            } else if (eventName === "changed") changed();
            eventName = "";
          } else if (line.startsWith("event:")) eventName = line.slice(6).trim();
          newline = buffer.indexOf("\n");
        }
      }
    } finally {
      streamConnected = false;
      if (now() - openedAt < SHORT_STREAM_MS) shortStreams += 1;
      else shortStreams = 0;
    }
  }

  const isFollower = () => role === "follower";

  async function streamLoop() {
    while (running && !streamDisabled && !isFollower()) {
      streamAbort = new AbortController();
      try {
        await readStream(streamAbort.signal);
      } catch {
        if (!running) return;
        streamFailures += 1;
      }
      if (!running || isFollower()) return;
      if (shortStreams >= SHORT_STREAMS_BEFORE_GIVING_UP) {
        // The platform cuts streams too fast for them to be worth it here.
        streamDisabled = true;
        schedule(nextDelay());
        return;
      }
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(3_000 * 2 ** streamFailures, 60_000)),
      );
    }
  }

  // ---- roles ----

  function becomeLeader() {
    role = "leader";
    post({ type: "leader" });
    post({ type: "state", state });
    void tick();
    if (!streamDisabled) void streamLoop();
  }

  function becomeFollower() {
    role = "follower";
    post({ type: "hello" });
  }

  function acquireLeadership() {
    if (!locks || !channel) {
      role = "solo";
      void tick();
      if (!streamDisabled) void streamLoop();
      return;
    }
    becomeFollower();
    lockAbort = new AbortController();
    locks
      .request(
        `easy-ping:leader:${baseUrl}`,
        { mode: "exclusive", signal: lockAbort.signal },
        () =>
          new Promise<void>((resolve) => {
            releaseLock = resolve;
            if (running) becomeLeader();
            else resolve();
          }),
      )
      .catch(() => {
        // aborted on stop, or Web Locks refused; either way no leadership here
      });
  }

  function start() {
    running = true;
    channel = makeChannel ? makeChannel() : undefined;
    channel?.addEventListener("message", onTabMessage);
    serviceWorker?.addEventListener("message", onRelay);
    if (activityTarget) {
      for (const name of ACTIVITY_EVENTS) activityTarget.addEventListener(name, onActivity);
    }
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisibility);
    }
    activeUntil = now() + activeWindowMs;
    acquireLeadership();
  }

  function stop() {
    running = false;
    clearTimeout(timer);
    timer = undefined;
    streamAbort?.abort();
    streamAbort = undefined;
    lockAbort?.abort();
    lockAbort = undefined;
    releaseLock?.();
    releaseLock = undefined;
    channel?.removeEventListener("message", onTabMessage);
    channel?.close();
    channel = undefined;
    serviceWorker?.removeEventListener("message", onRelay);
    if (activityTarget) {
      for (const name of ACTIVITY_EVENTS) activityTarget.removeEventListener(name, onActivity);
    }
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", onVisibility);
    }
    role = "solo";
  }

  // ---- signals from outside: the service worker relay and the piggyback header ----

  function onRelay(event: { data?: unknown }) {
    const data = event.data as { source?: unknown; type?: unknown } | null;
    if (data?.source === "easy-ping" && data.type === "changed") changed();
  }

  let lastInboxVersion: string | null = null;

  /**
   * Wraps your app's fetch so responses carrying the inbox-version header
   * refresh the bell when the version moves. Active users then never need a
   * dedicated poll. RFC 0006 idea 1.
   */
  function instrument(inner: typeof globalThis.fetch): typeof globalThis.fetch {
    return (async (...args: Parameters<typeof globalThis.fetch>) => {
      const response = await inner(...args);
      const version = response.headers.get("x-easy-ping-inbox");
      if (version !== null && version !== lastInboxVersion) {
        const first = lastInboxVersion === null;
        lastInboxVersion = version;
        if (!first && role !== "follower") changed();
      }
      return response;
    }) as typeof globalThis.fetch;
  }

  function subscribe(listener: (state: NotifyState) => void): () => void {
    listeners.add(listener);
    listener(state);

    // One transport regardless of how many components subscribe.
    if (listeners.size === 1) start();

    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) stop();
    };
  }

  return {
    subscribe,
    refresh,
    loadMore,
    markAsRead,
    markAllRead,
    markSeen,
    instrument,
    getState: () => state,
    getTransport: (): TransportStatus => ({
      role,
      transport: streamDisabled ? "poll" : "sse",
      connected: streamConnected,
    }),
  };
}

export type NotifyClient = ReturnType<typeof createNotifyClient>;
