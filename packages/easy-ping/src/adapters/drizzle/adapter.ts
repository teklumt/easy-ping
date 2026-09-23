import { type SQL, sql } from "drizzle-orm";
import type {
  ClaimArgs,
  ClaimedDelivery,
  DatabaseAdapter,
  DeliveryRelease,
  FeedPage,
  FeedQuery,
  InsertNotification,
} from "../../core/adapter";
import { decodeBase64Url, encodeBase64Url } from "../../core/base64url";
import { isOperator, type QueryOptions, type WhereClause } from "../../core/store";
import type { Channel, DeliveryRecord, DeliveryStatus, NotificationRecord } from "../../core/types";
import { toSnakeCase } from "../../schema/declaration";

type Row = Record<string, unknown>;

/** Structural, not Drizzle's inferred type: that costs thousands of instantiations at a boundary. */
type ExecutableDb = {
  execute: (query: SQL) => Promise<unknown>;
  transaction: <T>(fn: (tx: ExecutableDb) => Promise<T>) => Promise<T>;
};

export type DrizzleAdapterOptions = {
  prefix?: string;
};

/** postgres-js returns rows directly; node-postgres wraps them in { rows }. */
function toRows(result: unknown): Row[] {
  if (Array.isArray(result)) return result as Row[];
  if (result && typeof result === "object" && "rows" in result) {
    const { rows } = result as { rows: unknown };
    if (Array.isArray(rows)) return rows as Row[];
  }
  return [];
}

const str = (value: unknown): string => String(value);
const nullableStr = (value: unknown): string | null => (value == null ? null : String(value));
const num = (value: unknown): number => Number(value);
const date = (value: unknown): Date => (value instanceof Date ? value : new Date(String(value)));
const nullableDate = (value: unknown): Date | null =>
  value == null ? null : value instanceof Date ? value : new Date(String(value));

/** postgres-js rejects a Date bound to a ::timestamptz param; ISO strings bind everywhere. */
const ts = (value: Date) => value.toISOString();

const encodeCursor = (createdAt: Date, id: string) =>
  encodeBase64Url(`${createdAt.toISOString()}|${id}`);

function decodeCursor(cursor: string): { createdAt: Date; id: string } | null {
  const decoded = decodeBase64Url(cursor);
  if (!decoded) return null;

  const [iso, id] = decoded.split("|");
  if (!iso || !id) return null;

  const createdAt = new Date(iso);
  return Number.isNaN(createdAt.getTime()) ? null : { createdAt, id };
}

function toNotification(row: Row): NotificationRecord {
  return {
    id: str(row.id),
    userId: str(row.user_id),
    type: str(row.type),
    payload: row.payload,
    actorId: nullableStr(row.actor_id),
    groupKey: nullableStr(row.group_key),
    dedupeKey: nullableStr(row.dedupe_key),
    seenAt: nullableDate(row.seen_at),
    readAt: nullableDate(row.read_at),
    archivedAt: nullableDate(row.archived_at),
    createdAt: date(row.created_at),
  };
}

function toDelivery(row: Row): DeliveryRecord {
  return {
    id: str(row.id),
    notificationId: str(row.notification_id),
    channel: str(row.channel) as Channel,
    status: str(row.status) as DeliveryStatus,
    attempts: num(row.attempts),
    maxAttempts: num(row.max_attempts),
    notBefore: date(row.not_before),
    claimedAt: nullableDate(row.claimed_at),
    claimedBy: nullableStr(row.claimed_by),
    lastError: nullableStr(row.last_error),
    updatedAt: date(row.updated_at),
  };
}

const bind = (value: unknown): unknown => (value instanceof Date ? value.toISOString() : value);

function whereSql(where: WhereClause): SQL {
  const entries = Object.entries(where);
  if (entries.length === 0) return sql``;

  const conditions = entries.map(([field, condition]) => {
    const column = sql.identifier(toSnakeCase(field));

    if (condition === null) return sql`${column} IS NULL`;
    if (!isOperator(condition)) return sql`${column} = ${bind(condition)}`;

    const operator = condition as Record<string, unknown>;
    if ("in" in operator) {
      const list = operator.in as readonly (string | number)[];
      if (list.length === 0) return sql`FALSE`;
      return sql`${column} IN (${sql.join(
        list.map((item) => sql`${item}`),
        sql`, `,
      )})`;
    }
    if ("lt" in operator) return sql`${column} < ${bind(operator.lt)}`;
    if ("lte" in operator) return sql`${column} <= ${bind(operator.lte)}`;
    if ("gt" in operator) return sql`${column} > ${bind(operator.gt)}`;
    if ("gte" in operator) return sql`${column} >= ${bind(operator.gte)}`;
    if ("not" in operator) {
      return operator.not === null
        ? sql`${column} IS NOT NULL`
        : sql`${column} IS DISTINCT FROM ${bind(operator.not)}`;
    }
    return sql`TRUE`;
  });

  return sql` WHERE ${sql.join(conditions, sql` AND `)}`;
}

export function drizzleAdapter(
  client: unknown,
  options: DrizzleAdapterOptions = {},
): DatabaseAdapter {
  const db = client as ExecutableDb;
  const prefix = options.prefix ?? "";

  const NOTIFICATION = sql.identifier(`${prefix}notification`);
  const DELIVERY = sql.identifier(`${prefix}notification_delivery`);

  const run = async (query: SQL, on: ExecutableDb = db) => toRows(await on.execute(query));

  return {
    name: "drizzle-pg",
    naming: "snake_case",
    serializesJson: true,

    async createNotifications(input: readonly InsertNotification[]) {
      if (input.length === 0) return { created: [], deduped: [] };

      // App clock, not now(): markSeen compares against app-side cutoffs and NTP skew broke it.
      const now = new Date();

      return db.transaction(async (tx) => {
        const values = input.map(
          (row) => sql`(
            ${row.id}::text,
            ${row.userId}::text,
            ${row.type}::text,
            ${JSON.stringify(row.payload ?? null)}::jsonb,
            ${row.actorId ?? null}::text,
            ${row.groupKey ?? null}::text,
            ${row.dedupeKey ?? null}::text,
            ${ts(now)}::timestamptz
          )`,
        );

        // NULL dedupe keys never conflict, so undeduped rows coexist.
        const inserted = await run(
          sql`
            INSERT INTO ${NOTIFICATION} (id, user_id, type, payload, actor_id, group_key, dedupe_key, created_at)
            VALUES ${sql.join(values, sql`, `)}
            ON CONFLICT (user_id, dedupe_key) DO NOTHING
            RETURNING id
          `,
          tx,
        );

        const created = new Set(inserted.map((row) => str(row.id)));

        const deliveries = input
          .filter((row) => created.has(row.id))
          .flatMap((row) =>
            row.deliveries.map(
              (delivery) => sql`(
                ${delivery.id}::text,
                ${row.id}::text,
                ${delivery.channel}::text,
                ${delivery.maxAttempts}::integer,
                ${ts(delivery.notBefore)}::timestamptz,
                ${ts(now)}::timestamptz
              )`,
            ),
          );

        if (deliveries.length > 0) {
          await tx.execute(sql`
            INSERT INTO ${DELIVERY} (id, notification_id, channel, max_attempts, not_before, updated_at)
            VALUES ${sql.join(deliveries, sql`, `)}
          `);
        }

        return {
          created: [...created],
          deduped: input.filter((row) => !created.has(row.id)).map((row) => row.id),
        };
      });
    },

    async claimPendingDeliveries(args: ClaimArgs): Promise<readonly ClaimedDelivery[]> {
      const now = args.now ?? new Date();
      const staleBefore = new Date(now.getTime() - args.leaseMs);

      const channelFilter =
        args.channels && args.channels.length > 0
          ? sql`AND channel IN (${sql.join(
              args.channels.map((channel) => sql`${channel}`),
              sql`, `,
            )})`
          : sql``;

      const idFilter =
        args.ids && args.ids.length > 0
          ? sql`AND id IN (${sql.join(
              args.ids.map((id) => sql`${id}`),
              sql`, `,
            )})`
          : sql``;

      // SKIP LOCKED lets concurrent sweeps step around each other. RFC 0003 §5.
      const rows = await run(sql`
        WITH claimed AS (
          UPDATE ${DELIVERY}
          SET status = 'claimed', claimed_at = ${ts(now)}::timestamptz, claimed_by = ${args.claimToken}::text
          WHERE id IN (
            SELECT id FROM ${DELIVERY}
            WHERE (status = 'pending' OR (status = 'claimed' AND claimed_at < ${ts(staleBefore)}::timestamptz))
              AND not_before <= ${ts(now)}::timestamptz
              AND attempts < max_attempts
              ${channelFilter}
              ${idFilter}
            ORDER BY not_before ASC, id ASC
            LIMIT ${args.limit}
            FOR UPDATE SKIP LOCKED
          )
          RETURNING id, notification_id, channel, attempts, max_attempts
        )
        SELECT c.id, c.notification_id, c.channel, c.attempts, c.max_attempts,
               n.user_id, n.type, n.payload, n.actor_id
        FROM claimed c
        JOIN ${NOTIFICATION} n ON n.id = c.notification_id
      `);

      return rows.map((row) => ({
        id: str(row.id),
        notificationId: str(row.notification_id),
        channel: str(row.channel) as Channel,
        attempts: num(row.attempts),
        maxAttempts: num(row.max_attempts),
        notification: {
          userId: str(row.user_id),
          type: str(row.type),
          payload: row.payload,
          actorId: nullableStr(row.actor_id),
        },
      }));
    },

    async releaseDeliveries(releases: readonly DeliveryRelease[]) {
      if (releases.length === 0) return;
      const now = new Date();

      const values = releases.map(({ id, outcome, nextAttemptAt }) => {
        const retryable = outcome.result === "failed" && outcome.retryable;
        const error =
          outcome.result === "failed"
            ? outcome.error.slice(0, 2000)
            : outcome.result === "skipped"
              ? outcome.reason.slice(0, 2000)
              : null;

        return sql`(
          ${id}::text,
          ${outcome.result}::text,
          ${retryable}::boolean,
          ${error}::text,
          ${nextAttemptAt ? ts(nextAttemptAt) : null}::timestamptz
        )`;
      });

      // No claimed_by predicate on purpose: terminal state beats a wedged row. RFC 0003 §6.
      await db.execute(sql`
        UPDATE ${DELIVERY} d
        SET status = CASE
              WHEN v.result = 'sent' THEN 'sent'
              WHEN v.result = 'skipped' THEN 'skipped'
              WHEN v.retryable AND d.attempts + 1 < d.max_attempts THEN 'pending'
              ELSE 'failed'
            END,
            attempts = CASE
              WHEN v.result IN ('sent', 'skipped') THEN d.attempts
              ELSE d.attempts + 1
            END,
            last_error = v.error,
            not_before = COALESCE(v.not_before, d.not_before),
            claimed_at = NULL,
            claimed_by = NULL,
            updated_at = ${ts(now)}::timestamptz
        FROM (VALUES ${sql.join(values, sql`, `)}) AS v(id, result, retryable, error, not_before)
        WHERE d.id = v.id
      `);
    },

    async listNotifications(query: FeedQuery): Promise<FeedPage> {
      const cursor = query.cursor ? decodeCursor(query.cursor) : null;

      const rows = await run(sql`
        SELECT * FROM ${NOTIFICATION}
        WHERE user_id = ${query.userId}::text
          AND archived_at IS NULL
          ${query.unreadOnly ? sql`AND read_at IS NULL` : sql``}
          ${
            cursor
              ? sql`AND (created_at, id) < (${ts(cursor.createdAt)}::timestamptz, ${cursor.id}::text)`
              : sql``
          }
        ORDER BY created_at DESC, id DESC
        LIMIT ${query.limit + 1}
      `);

      const page = rows.slice(0, query.limit).map(toNotification);
      const last = page.at(-1);

      return {
        notifications: page,
        nextCursor:
          rows.length > query.limit && last ? encodeCursor(last.createdAt, last.id) : null,
      };
    },

    async countUnseen(userId: string) {
      const rows = await run(sql`
        SELECT count(*)::int AS count FROM ${NOTIFICATION}
        WHERE user_id = ${userId}::text AND seen_at IS NULL AND archived_at IS NULL
      `);
      return num(rows[0]?.count ?? 0);
    },

    async markSeen(userId: string, before: Date) {
      await db.execute(sql`
        UPDATE ${NOTIFICATION} SET seen_at = ${ts(new Date())}::timestamptz
        WHERE user_id = ${userId}::text AND seen_at IS NULL AND created_at <= ${ts(before)}::timestamptz
      `);
    },

    async markRead(userId: string, notificationIds: readonly string[]) {
      if (notificationIds.length === 0) return 0;

      // Scoped by user_id (RFC 0002 §2); no read_at IS NULL filter so re-marking stays idempotent.
      const rows = await run(sql`
        UPDATE ${NOTIFICATION}
        SET read_at = COALESCE(read_at, ${ts(new Date())}::timestamptz)
        WHERE user_id = ${userId}::text
          AND id IN (${sql.join(
            notificationIds.map((id) => sql`${id}`),
            sql`, `,
          )})
        RETURNING id
      `);
      return rows.length;
    },

    async markAllRead(userId: string) {
      const rows = await run(sql`
        UPDATE ${NOTIFICATION} SET read_at = ${ts(new Date())}::timestamptz
        WHERE user_id = ${userId}::text AND read_at IS NULL
        RETURNING id
      `);
      return rows.length;
    },

    async queryTable(table: string, where: WhereClause, options: QueryOptions) {
      const order = options.orderBy
        ? sql` ORDER BY ${sql.identifier(toSnakeCase(options.orderBy.field))} ${
            options.orderBy.direction === "desc" ? sql`DESC` : sql`ASC`
          }`
        : sql``;
      const limit = options.limit ? sql` LIMIT ${options.limit}` : sql``;

      return run(
        sql`SELECT * FROM ${sql.identifier(table)}${whereSql(where)}${order}${limit}`,
      ) as Promise<Record<string, unknown>[]>;
    },

    async insertRows(
      table: string,
      rows: readonly Record<string, unknown>[],
      onConflict?: readonly string[],
    ) {
      if (rows.length === 0) return 0;

      const columns = Object.keys(rows[0] ?? {});
      if (columns.length === 0) return 0;

      const values = rows.map(
        (row) =>
          sql`(${sql.join(
            columns.map((column) => sql`${bind(row[column])}`),
            sql`, `,
          )})`,
      );

      const conflict =
        onConflict && onConflict.length > 0
          ? sql` ON CONFLICT (${sql.join(
              onConflict.map((field) => sql.identifier(toSnakeCase(field))),
              sql`, `,
            )}) DO UPDATE SET ${sql.join(
              columns
                .filter((column) => !onConflict.includes(column))
                .map(
                  (column) =>
                    sql`${sql.identifier(toSnakeCase(column))} = EXCLUDED.${sql.identifier(
                      toSnakeCase(column),
                    )}`,
                ),
              sql`, `,
            )}`
          : sql``;

      const inserted = await run(sql`
        INSERT INTO ${sql.identifier(table)} (${sql.join(
          columns.map((column) => sql.identifier(toSnakeCase(column))),
          sql`, `,
        )})
        VALUES ${sql.join(values, sql`, `)}${conflict}
        RETURNING 1 AS ok
      `);
      return inserted.length;
    },

    async updateRows(table: string, where: WhereClause, set: Record<string, unknown>) {
      const assignments = Object.entries(set).map(
        ([field, value]) => sql`${sql.identifier(toSnakeCase(field))} = ${bind(value)}`,
      );
      if (assignments.length === 0) return 0;

      const rows = await run(sql`
        UPDATE ${sql.identifier(table)}
        SET ${sql.join(assignments, sql`, `)}${whereSql(where)}
        RETURNING 1 AS ok
      `);
      return rows.length;
    },

    async deleteRows(table: string, where: WhereClause) {
      const rows = await run(
        sql`DELETE FROM ${sql.identifier(table)}${whereSql(where)} RETURNING 1 AS ok`,
      );
      return rows.length;
    },

    async getFailedDeliveries(args: { since: Date; limit: number }) {
      const rows = await run(sql`
        SELECT * FROM ${DELIVERY}
        WHERE status = 'failed' AND updated_at >= ${ts(args.since)}::timestamptz
        ORDER BY updated_at DESC
        LIMIT ${args.limit}
      `);
      return rows.map(toDelivery);
    },
  };
}
