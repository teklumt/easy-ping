import type { DatabaseAdapter } from "./adapter";
import type { NotificationDefinitions, PayloadOf } from "./definition";
import type { Logger } from "./errors";
import type { AnyPlugin, Promisable, RouteScope } from "./plugin";
import type { EmailProvider } from "./provider";
import type { RateLimitConfig } from "./rate-limit";
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
  /**
   * Next.js `after`, Cloudflare `ctx.waitUntil`, or @vercel/functions.
   * Injected, not detected: importing a maybe-absent package breaks bundlers.
   */
  waitUntil?: (promise: Promise<unknown>) => void;
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
  /**
   * Bearer secret for plugins' machine routes (`/push/prune`, `/digests/cron`).
   * Falls back to `cron.secret`; set it when the scheduler that hits /cron
   * should not also be able to prune devices or fire digests.
   */
  machineSecret?: string;
  /**
   * In-process fixed-window limiter, applied before routing. Keyed by client
   * address from the usual proxy headers unless `key` says otherwise.
   */
  rateLimit?: RateLimitConfig;
  plugins?: readonly AnyPlugin[];
  /** Where the handler is mounted, used to strip the prefix off incoming URLs. */
  basePath?: string;
  /**
   * Origins allowed to POST besides the request's own host. Cross-origin
   * POSTs are otherwise refused with 403, and every POST must be
   * `application/json`. `"*.example.com"` matches subdomains.
   */
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

  startWorker(options?: { intervalMs?: number; batchSize?: number }): Worker;
  healthCheck(): Promise<HealthReport>;

  /** Every mounted route with its auth scope, so `custom`-scoped ones stay visible. RFC 0002 §3. */
  listRoutes(): readonly MountedRoute[];

  /**
   * Deliveries that exhausted their attempts, newest first.
   *
   * The retry machinery is otherwise a black box: rows go quiet and the only
   * way to ask what happened is SQL against tables the library owns. Wire this
   * to an admin page or an alert.
   */
  getFailedDeliveries(options?: {
    /** Defaults to the last 24 hours. */
    since?: Date;
    /** Defaults to 100. */
    limit?: number;
  }): Promise<readonly DeliveryRecord[]>;
};
