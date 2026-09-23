import { createBridgedSignals, type Signals } from "../../core/signals";

/** postgres.js's `sql` already has this shape. For node-postgres, see `pgListenNotify`. */
export type ListenNotifyLike = {
  listen(
    channel: string,
    onNotify: (payload: string) => void,
  ): Promise<{ unlisten(): Promise<void> }>;
  notify(channel: string, payload: string): Promise<unknown>;
};

export type PostgresSignalsOptions = {
  /** The one Postgres channel every easy-ping signal travels on. Default `easy_ping`. */
  channel?: string;
  onError?: (error: unknown) => void;
};

const originId = () => Math.random().toString(36).slice(2, 10);

/**
 * Cross-replica wake-ups over LISTEN/NOTIFY: no extra table, no extra service.
 * Every logical channel (`inbox:<userId>`, `deliveries`) rides one Postgres
 * channel as the payload, because Postgres channel names are identifiers and
 * user ids are not. RFC 0006 §4C.
 */
export function postgresSignals(
  sql: ListenNotifyLike,
  options: PostgresSignalsOptions = {},
): Signals {
  const channel = options.channel ?? "easy_ping";
  const onError = options.onError ?? (() => {});
  const origin = originId();
  const handlers = new Map<string, Set<() => void>>();
  let listening: Promise<{ unlisten(): Promise<void> }> | undefined;

  const dispatch = (payload: string) => {
    const separator = payload.indexOf("|");
    if (separator < 0) return;
    // Postgres hands a NOTIFY back to the connection that sent it; local subscribers already heard it.
    if (payload.slice(0, separator) === origin) return;
    for (const handler of handlers.get(payload.slice(separator + 1)) ?? []) handler();
  };

  const ensureListening = () => {
    listening ??= sql.listen(channel, dispatch).catch((error) => {
      listening = undefined;
      throw error;
    });
    return listening;
  };

  const bridged = createBridgedSignals(
    {
      publish: async (logical) => {
        await sql.notify(channel, `${origin}|${logical}`);
      },
      subscribe: async (logical, handler) => {
        let set = handlers.get(logical);
        if (!set) {
          set = new Set();
          handlers.set(logical, set);
        }
        set.add(handler);
        await ensureListening();
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
      const pending = listening;
      listening = undefined;
      handlers.clear();
      if (pending) await (await pending).unlisten();
    },
  };
}

/** The slice of a node-postgres Client used for LISTEN. One dedicated, connected client. */
export type PgListenClientLike = {
  query(text: string): Promise<unknown>;
  on(
    event: "notification",
    handler: (message: { channel: string; payload?: string }) => void,
  ): unknown;
  off(
    event: "notification",
    handler: (message: { channel: string; payload?: string }) => void,
  ): unknown;
};

/** Adapts a dedicated node-postgres Client (not a Pool: LISTEN is per connection) to `ListenNotifyLike`. */
export function pgListenNotify(client: PgListenClientLike): ListenNotifyLike {
  const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;
  const literal = (value: string) => `'${value.replace(/'/g, "''")}'`;
  return {
    async listen(channel, onNotify) {
      const handler = (message: { channel: string; payload?: string }) => {
        if (message.channel === channel && message.payload !== undefined) onNotify(message.payload);
      };
      client.on("notification", handler);
      await client.query(`LISTEN ${quote(channel)}`);
      return {
        unlisten: async () => {
          client.off("notification", handler);
          await client.query(`UNLISTEN ${quote(channel)}`);
        },
      };
    },
    notify: (channel, payload) =>
      client.query(`SELECT pg_notify(${literal(channel)}, ${literal(payload)})`),
  };
}
