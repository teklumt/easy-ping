import type { DatabaseAdapter } from "./adapter";
import type { NotificationDefinitions, PayloadOf } from "./definition";
import type { Logger } from "./errors";
import type { AnyPlugin } from "./plugin";
import type { EmailProvider } from "./provider";
import type { Channel, DeliveryMode, Recipient, SkipReason } from "./types";

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

export type EasyNotifyConfig<TDefs extends NotificationDefinitions> = {
  database: DatabaseAdapter;
  session: SessionConfig;
  /** Signs unsubscribe and other tokenised links. See RFC 0002 §5. */
  secret: string;
  getRecipients: (userIds: readonly string[]) => Promise<readonly Recipient[]>;
  notifications: TDefs;
  channels: ChannelsConfig;
  delivery?: DeliveryConfig;
  /** Required by `cron` and `deferred` modes. See RFC 0002 §4. */
  cron?: { secret: string };
  plugins?: readonly AnyPlugin[];
  /** Where the handler is mounted, used to strip the prefix off incoming URLs. */
  basePath?: string;
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

export type HealthReport = {
  mode: DeliveryMode;
  cronMounted: boolean;
  /** True when the chosen mode relies on a cron sweep that is not wired up. */
  cronRequiredButMissing: boolean;
  warnings: readonly string[];
};

export type EasyNotify<TDefs extends NotificationDefinitions> = {
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
};
