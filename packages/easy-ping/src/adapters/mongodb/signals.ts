import { createBridgedSignals, type Signals } from "../../core/signals";

type SignalDocument = { channel: string; origin: string; at: Date };

type ChangeStreamLike = {
  on(event: "change", handler: (change: { fullDocument?: SignalDocument }) => void): unknown;
  on(event: "error", handler: (error: unknown) => void): unknown;
  close(): Promise<unknown>;
};

/** Structural, so `mongodb` stays an optional peer dependency. */
export type MongoSignalsDb = {
  createCollection(name: string, options: { capped: boolean; size: number }): Promise<unknown>;
  collection(name: string): {
    insertOne(doc: SignalDocument): Promise<unknown>;
    watch(pipeline?: unknown[], options?: Record<string, unknown>): ChangeStreamLike;
  };
};

export type MongoSignalsOptions = {
  /** Capped collection the signals pass through. Default `easy_ping_signals`. */
  collection?: string;
  /** Capped size in bytes. Old signals fall off the end; nobody reads history. Default 1 MiB. */
  size?: number;
  onError?: (error: unknown) => void;
};

const originId = () => Math.random().toString(36).slice(2, 10);

/**
 * Cross-replica wake-ups over a change stream on a capped collection.
 * Needs a replica set, which the adapter's transactions need anyway.
 * RFC 0006 §4C.
 */
export function mongoSignals(db: MongoSignalsDb, options: MongoSignalsOptions = {}): Signals {
  const name = options.collection ?? "easy_ping_signals";
  const onError = options.onError ?? (() => {});
  const origin = originId();
  const handlers = new Map<string, Set<() => void>>();
  let ready: Promise<void> | undefined;
  let stream: ChangeStreamLike | undefined;

  const ensureCollection = () => {
    ready ??= db.createCollection(name, { capped: true, size: options.size ?? 1024 * 1024 }).then(
      () => {},
      (error: unknown) => {
        // 48: NamespaceExists. Another replica got there first.
        if ((error as { code?: number })?.code === 48) return;
        ready = undefined;
        throw error;
      },
    );
    return ready;
  };

  const ensureWatching = async () => {
    if (stream) return;
    await ensureCollection();
    if (stream) return;
    const opened = db
      .collection(name)
      .watch([{ $match: { operationType: "insert" } }], { fullDocument: "updateLookup" });
    stream = opened;
    opened.on("change", (change) => {
      const doc = change.fullDocument;
      if (!doc || doc.origin === origin) return;
      for (const handler of handlers.get(doc.channel) ?? []) handler();
    });
    opened.on("error", (error) => {
      onError(error);
      if (stream === opened) stream = undefined;
    });
  };

  const bridged = createBridgedSignals(
    {
      publish: async (logical) => {
        await ensureCollection();
        await db.collection(name).insertOne({ channel: logical, origin, at: new Date() });
      },
      subscribe: async (logical, handler) => {
        let set = handlers.get(logical);
        if (!set) {
          set = new Set();
          handlers.set(logical, set);
        }
        set.add(handler);
        await ensureWatching();
        return () => {
          set?.delete(handler);
          if (set?.size === 0) handlers.delete(logical);
        };
      },
    },
    onError,
  );

  return {
    ...bridged,
    close: async () => {
      const open = stream;
      stream = undefined;
      handlers.clear();
      await open?.close();
    },
  };
}
