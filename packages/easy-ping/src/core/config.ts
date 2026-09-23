import type { DatabaseAdapter } from "./adapter";
import type { NotificationDefinitions, PayloadOf } from "./definition";
import type { Logger } from "./errors";
import type { AnyPlugin, Promisable, RouteScope } from "./plugin";
import type { EmailProvider } from "./provider";
import type { RateLimitConfig } from "./rate-limit";
import type { Signals } from "./signals";
import type { Channel, DeliveryMode, DeliveryRecord, Recipient, SkipReason } from "./types";

export type SessionConfig = {
  /** null yields 401; throwing yields 500. Deliberately distinct. */
  getUserId: (request: Request) => string | null | Promise<string | null>;
};

export type DeliveryConfig = {
  mode?: DeliveryMode;
  maxAttempts?: number;
  /** Must exceed the slowest provider timeout, or duplicates are systematic. */
  leaseMs?: number;
  batchSize?: number;
  /** inline mode only. */
  throwOnError?: boolean;
  backoff?: "exponential" | ((attempt: number) => number);
  /** Next.js `after` or Cloudflare `ctx.waitUntil`. Injected, not detected. */
  waitUntil?: (promise: Promise<unknown>) => void;
  /**
   * Run one small claim-and-deliver pass after any request the handler serves,
   * at most once per `everyMs` per process. Delivery then rides on your own
   * traffic and the cron becomes a backstop. Ignored in `inline` mode. RFC 0006 idea 5.
   */
  sweepOnRequest?: true | { everyMs?: number; limit?: number };
};

export type EventsConfig = {
  /** Comment line keeping proxies from closing an idle stream. Default 25 s. */
  heartbeatMs?: number;
  /**
   * Without a cross-process signal source, each stream checks the database
   * for changes this often on its subscriber's behalf. Default 30 s; 0 disables.
   */
  probeIntervalMs?: number;
  /** Close the stream after this long; the client reconnects. 0 (default) leaves it open. */
  maxDurationMs?: number;
};

export type ChannelsConfig = {
  inApp?: { enabled: boolean };
  email?: { provider: EmailProvider };
};

export type EasyPingConfig<TDefs extends NotificationDefinitions> = {
  database: DatabaseAdapter;
  session: SessionConfig;
  /** Signs unsubscribe and other tokenised links. See RFC 0002 §5. */
  secret: string;
  getRecipients: (userIds: readonly string[]) => Promise<readonly Recipient[]>;
  notifications: TDefs;
  channels: ChannelsConfig;
  delivery?: DeliveryConfig;
  /** Required by `cron` and `deferred` modes. See RFC 0002 §4. */
  cron?: {
    secret: string;
    /** Sweeps one POST /cron may run before returning. Defaults to 50. */
    maxSweeps?: number;
  };
  /** Bearer secret for plugin machine routes. Falls back to `cron.secret`. */
  machineSecret?: string;
  /** In-process fixed-window limiter, applied before routing. */
  rateLimit?: RateLimitConfig;
  /**
   * How "something changed" travels between the sender, the worker and open
   * event streams. Defaults to in-process. Supply a LISTEN/NOTIFY or change
   * stream implementation to cross replicas. RFC 0006 §4C.
   */
  signals?: Signals;
  /** `GET /events`, a Server-Sent Events stream per user. `false` unmounts it. */
  events?: EventsConfig | false;
  plugins?: readonly AnyPlugin[];
  /** Where the handler is mounted, used to strip the prefix off incoming URLs. */
  basePath?: string;
  /** Origins other than the request host that may POST. `"*.example.com"` matches subdomains. */
  trustedOrigins?: readonly string[];
  /** Runs before routing. Return a Response to short-circuit — a rate limiter's 429, say. */
  // biome-ignore lint/suspicious/noConfusingVoidType: a hook that returns nothing is the common case
  onRequest?: (request: Request) => Promisable<Response | undefined | void>;
  /** Defaults to 64 KiB. */
  maxBodyBytes?: number;
  /** Table-name prefix; must match the one given to the adapter. */
  tablePrefix?: string;
  logger?: Logger;
};

export type SendArgs<TDefs extends NotificationDefinitions, TKey extends keyof TDefs> = {
  to: string | readonly string[];
  payload: PayloadOf<TDefs[TKey]>;
  actorId?: string;
  dedupeKey?: string;
  overrides?: { channels?: readonly Channel[] };
};

export type SendResult = {
  notifications: readonly {
    id: string;
    userId: string;
    deliveries: readonly { id: string; channel: Channel }[];
  }[];
  skipped: readonly { userId: string; reason: SkipReason }[];
};

export type Worker = {
  stop: () => Promise<void>;
};

export type MountedRoute = {
  method: "GET" | "POST";
  path: string;
  scope: RouteScope;
  /** "core" for the built-in routes, otherwise the plugin id. */
  owner: string;
};

export type HealthReport = {
  mode: DeliveryMode;
  cronMounted: boolean;
  /** True when the chosen mode relies on a cron sweep that is not wired up. */
  cronRequiredButMissing: boolean;
  warnings: readonly string[];
};

/** Response header carrying a per-user inbox version, so app traffic can replace polling. */
export const INBOX_VERSION_HEADER = "x-easy-ping-inbox";

export type EasyPing<TDefs extends NotificationDefinitions> = {
  send<TKey extends keyof TDefs & string>(
    type: TKey,
    args: SendArgs<TDefs, TKey>,
  ): Promise<SendResult>;

  handler: {
    /** Method-agnostic entry, for toNodeHandler and single-dispatch frameworks. */
    handle: (request: Request) => Promise<Response>;
    GET: (request: Request) => Promise<Response>;
    POST: (request: Request) => Promise<Response>;
  };

  /** Idle interval defaults to 10 s; a send in this process wakes the loop at once. */
  startWorker(options?: { intervalMs?: number; batchSize?: number }): Worker;
  healthCheck(): Promise<HealthReport>;

  /** Every mounted route with its auth scope, so `custom`-scoped ones stay visible. RFC 0002 §3. */
  listRoutes(): readonly MountedRoute[];

  /**
   * Headers to attach to any response your app sends this user. The client's
   * `instrument(fetch)` reads them and refreshes only when the version moved,
   * so an active user never needs a dedicated poll. RFC 0006 idea 1.
   */
  inboxHeaders(userId: string): Record<string, string>;

  /** Deliveries that exhausted their attempts, newest first. Wire it to an admin page or an alert. */
  getFailedDeliveries(options?: {
    /** Defaults to the last 24 hours. */
    since?: Date;
    /** Defaults to 100. */
    limit?: number;
  }): Promise<readonly DeliveryRecord[]>;
};
