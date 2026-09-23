/**
 * The wake-up seam. A publish carries no payload: it says "something changed
 * on this channel, go look", so losing one costs latency, never data.
 * RFC 0006 §4C.
 */
export type Signals = {
  /** True when a publish in one process reaches subscribers in another. */
  readonly crossProcess: boolean;
  publish(channel: string): void;
  subscribe(channel: string, handler: () => void): () => void;
  close?(): Promise<void> | void;
};

export const DELIVERIES_CHANNEL = "deliveries";
export const inboxChannel = (userId: string) => `inbox:${userId}`;

/** In-process only. The default, and exactly right on SQLite or a single replica. */
export function createMemorySignals(): Signals {
  const handlers = new Map<string, Set<() => void>>();

  return {
    crossProcess: false,
    publish(channel) {
      const set = handlers.get(channel);
      if (!set) return;
      for (const handler of [...set]) {
        queueMicrotask(() => {
          try {
            handler();
          } catch {
            // a subscriber's failure is its own problem
          }
        });
      }
    },
    subscribe(channel, handler) {
      let set = handlers.get(channel);
      if (!set) {
        set = new Set();
        handlers.set(channel, set);
      }
      set.add(handler);
      return () => {
        set?.delete(handler);
        if (set?.size === 0) handlers.delete(channel);
      };
    },
  };
}

/**
 * Wraps a cross-process transport (LISTEN/NOTIFY, a change stream) so local
 * subscribers still hear local publishes even if the transport drops them,
 * and a transport failure degrades to in-process rather than to silence.
 */
export function createBridgedSignals(
  transport: {
    publish(channel: string): Promise<void> | void;
    subscribe(channel: string, handler: () => void): Promise<() => void> | (() => void);
  },
  onError: (error: unknown) => void,
): Signals {
  const local = createMemorySignals();
  const remoteUnsubscribes = new Map<string, Promise<() => void>>();
  const counts = new Map<string, number>();

  return {
    crossProcess: true,
    publish(channel) {
      local.publish(channel);
      Promise.resolve()
        .then(() => transport.publish(channel))
        .catch(onError);
    },
    subscribe(channel, handler) {
      const unsubscribeLocal = local.subscribe(channel, handler);
      counts.set(channel, (counts.get(channel) ?? 0) + 1);

      if (!remoteUnsubscribes.has(channel)) {
        remoteUnsubscribes.set(
          channel,
          Promise.resolve()
            .then(() => transport.subscribe(channel, () => local.publish(channel)))
            .catch((error) => {
              onError(error);
              return () => {};
            }),
        );
      }

      return () => {
        unsubscribeLocal();
        const remaining = (counts.get(channel) ?? 1) - 1;
        if (remaining > 0) {
          counts.set(channel, remaining);
          return;
        }
        counts.delete(channel);
        const pending = remoteUnsubscribes.get(channel);
        remoteUnsubscribes.delete(channel);
        pending?.then((unsubscribe) => unsubscribe()).catch(onError);
      };
    },
  };
}
