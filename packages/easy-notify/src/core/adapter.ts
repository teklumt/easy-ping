import type { QueryOptions, WhereClause } from "./store";
import type { Channel, DeliveryRecord, Frequency, NotificationRecord } from "./types";

export type PreferenceRecord = {
  userId: string;
  type: string;
  channel: Channel;
  enabled: boolean;
  frequency: Frequency;
};

export type InsertNotification = {
  id: string;
  userId: string;
  type: string;
  payload: unknown;
  actorId?: string | undefined;
  groupKey?: string | undefined;
  dedupeKey?: string | undefined;
  deliveries: readonly InsertDelivery[];
};

export type InsertDelivery = {
  id: string;
  channel: Channel;
  maxAttempts: number;
  notBefore: Date;
};

export type ClaimArgs = {
  limit: number;
  leaseMs: number;
  /** Unique per call, not per worker. See RFC 0003 §4. */
  claimToken: string;
  channels?: readonly Channel[] | undefined;
  /** Scopes the claim to one send; without it inline/deferred flush the whole table. */
  ids?: readonly string[] | undefined;
  now?: Date | undefined;
};

export type ClaimedDelivery = {
  id: string;
  notificationId: string;
  channel: Channel;
  attempts: number;
  maxAttempts: number;
  notification: {
    userId: string;
    type: string;
    payload: unknown;
    actorId: string | null;
  };
};

export type DeliveryOutcome =
  | { result: "sent" }
  | { result: "failed"; error: string; retryable: boolean };

export type DeliveryRelease = {
  id: string;
  claimToken: string;
  outcome: DeliveryOutcome;
  /** Applied when a retryable failure re-arms the row. */
  nextAttemptAt?: Date | undefined;
};

export type FeedQuery = {
  userId: string;
  limit: number;
  cursor?: string | undefined;
  unreadOnly?: boolean | undefined;
};

export type FeedPage = {
  notifications: readonly NotificationRecord[];
  nextCursor: string | null;
};

export type DatabaseAdapter = {
  readonly name: string;

  /** One transaction. A duplicate (userId, dedupeKey) is reported, not thrown. */
  createNotifications(rows: readonly InsertNotification[]): Promise<{
    created: readonly string[];
    deduped: readonly string[];
  }>;

  /** Atomic lease: a returned row stays invisible to other callers until it expires. */
  claimPendingDeliveries(args: ClaimArgs): Promise<readonly ClaimedDelivery[]>;

  /** Writes terminal state even when claimToken is stale. See RFC 0003 §6. */
  releaseDeliveries(releases: readonly DeliveryRelease[]): Promise<void>;

  listNotifications(query: FeedQuery): Promise<FeedPage>;
  countUnseen(userId: string): Promise<number>;
  markSeen(userId: string, before: Date): Promise<void>;
  markRead(userId: string, notificationIds: readonly string[]): Promise<number>;
  markAllRead(userId: string): Promise<number>;

  getFailedDeliveries(args: { since: Date; limit: number }): Promise<readonly DeliveryRecord[]>;

  /**
   * Generic table access for plugin-declared tables. Reached only through a
   * PluginStore, which validates the table and every column against the
   * plugin's own schema() before anything gets here.
   */
  queryTable(
    table: string,
    where: WhereClause,
    options: QueryOptions,
  ): Promise<Record<string, unknown>[]>;
  insertRows(
    table: string,
    rows: readonly Record<string, unknown>[],
    onConflict?: readonly string[],
  ): Promise<number>;
  updateRows(table: string, where: WhereClause, set: Record<string, unknown>): Promise<number>;
  deleteRows(table: string, where: WhereClause): Promise<number>;
};
