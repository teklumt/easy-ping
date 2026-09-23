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
import { quote, Statement } from "../sql/statement";

type Row = Record<string, unknown>;

/** Run one parameterised statement, return rows: the whole driver contract. */
export type SqlQuery = (text: string, params: readonly unknown[]) => Promise<readonly Row[]>;

export type PostgresAdapterOptions = {
  /** Table-name prefix. Must match the instance's `tablePrefix`. */
  prefix?: string;
  /** Makes createNotifications atomic. Optional; without it each write is still safe. */
  transaction?: <T>(fn: (query: SqlQuery) => Promise<T>) => Promise<T>;
};

const str = (value: unknown): string => String(value);
const nullableStr = (value: unknown): string | null => (value == null ? null : String(value));
const num = (value: unknown): number => Number(value);
const date = (value: unknown): Date => (value instanceof Date ? value : new Date(String(value)));
const nullableDate = (value: unknown): Date | null =>
  value == null ? null : value instanceof Date ? value : new Date(String(value));

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
    payload: typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload,
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

/** Appends ` WHERE …` for a PluginStore clause. Values are always bound. */
function appendWhere(statement: Statement, where: WhereClause): void {
  const entries = Object.entries(where);
  if (entries.length === 0) return;

  statement.raw(" WHERE ");

  entries.forEach(([field, condition], index) => {
    if (index > 0) statement.raw(" AND ");
    const column = quote(toSnakeCase(field));

    if (condition === null) {
      statement.raw(`${column} IS NULL`);
      return;
    }

    if (!isOperator(condition)) {
      statement.raw(`${column} = `).value(condition);
      return;
    }

    const operator = condition as Record<string, unknown>;

    if ("in" in operator) {
      const list = operator.in as readonly (string | number)[];
      // An empty IN () is a syntax error.
      if (list.length === 0) statement.raw("FALSE");
      else statement.raw(`${column} IN (`).list(list).raw(")");
      return;
    }

    if ("lt" in operator) statement.raw(`${column} < `).value(operator.lt);
    else if ("lte" in operator) statement.raw(`${column} <= `).value(operator.lte);
    else if ("gt" in operator) statement.raw(`${column} > `).value(operator.gt);
    else if ("gte" in operator) statement.raw(`${column} >= `).value(operator.gte);
    else if ("not" in operator) {
      if (operator.not === null) statement.raw(`${column} IS NOT NULL`);
      else statement.raw(`${column} IS DISTINCT FROM `).value(operator.not);
    } else statement.raw("TRUE");
  });
}

/** Postgres through any driver, no ORM. Deliberately Postgres-specific: ON CONFLICT, FOR UPDATE SKIP LOCKED, IS DISTINCT FROM. RFC 0003. */
export function postgresAdapter(
  query: SqlQuery,
  options: PostgresAdapterOptions = {},
): DatabaseAdapter {
  const prefix = options.prefix ?? "";

  const NOTIFICATION = quote(`${prefix}notification`);
  const DELIVERY = quote(`${prefix}notification_delivery`);

  const run = async (statement: Statement, exec: SqlQuery = query) =>
    exec(statement.text, statement.params);

  const atomically = <T>(fn: (exec: SqlQuery) => Promise<T>): Promise<T> =>
    options.transaction ? options.transaction(fn) : fn(query);

  return {
    name: "postgres",
    naming: "snake_case",
    serializesJson: true,

    async createNotifications(input: readonly InsertNotification[]) {
      if (input.length === 0) return { created: [], deduped: [] };

      // App clock, not now(): markSeen compares against app-side cutoffs and NTP skew broke it.
      const now = new Date();

      return atomically(async (exec) => {
        const insert = new Statement().raw(
          `INSERT INTO ${NOTIFICATION} ` +
            "(id, user_id, type, payload, actor_id, group_key, dedupe_key, created_at) VALUES ",
        );

        input.forEach((row, index) => {
          if (index > 0) insert.raw(", ");
          insert.tuple([
            [row.id, "text"],
            [row.userId, "text"],
            [row.type, "text"],
            [JSON.stringify(row.payload ?? null), "jsonb"],
            [row.actorId ?? null, "text"],
            [row.groupKey ?? null, "text"],
            [row.dedupeKey ?? null, "text"],
            [now, "timestamptz"],
          ]);
        });

        // NULL dedupe keys never conflict, so undeduped rows coexist.
        insert.raw(" ON CONFLICT (user_id, dedupe_key) DO NOTHING RETURNING id");

        const inserted = await run(insert, exec);
        const created = new Set(inserted.map((row) => str(row.id)));

        const deliveries = input
          .filter((row) => created.has(row.id))
          .flatMap((row) => row.deliveries.map((delivery) => ({ row, delivery })));

        if (deliveries.length > 0) {
          const insertDeliveries = new Statement().raw(
            `INSERT INTO ${DELIVERY} ` +
              "(id, notification_id, channel, max_attempts, not_before, updated_at) VALUES ",
          );

          deliveries.forEach(({ row, delivery }, index) => {
            if (index > 0) insertDeliveries.raw(", ");
            insertDeliveries.tuple([
              [delivery.id, "text"],
              [row.id, "text"],
              [delivery.channel, "text"],
              [delivery.maxAttempts, "integer"],
              [delivery.notBefore, "timestamptz"],
              [now, "timestamptz"],
            ]);
          });

          await run(insertDeliveries, exec);
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

      // SKIP LOCKED lets concurrent sweeps step around each other. RFC 0003 §5.
      const statement = new Statement()
        .raw(`WITH claimed AS (UPDATE ${DELIVERY} SET status = 'claimed', claimed_at = `)
        .value(now)
        .raw("::timestamptz, claimed_by = ")
        .value(args.claimToken)
        .raw(`::text WHERE id IN (SELECT id FROM ${DELIVERY} WHERE (status = 'pending' OR `)
        .raw("(status = 'claimed' AND claimed_at < ")
        .value(staleBefore)
        .raw("::timestamptz)) AND not_before <= ")
        .value(now)
        .raw("::timestamptz AND attempts < max_attempts");

      if (args.channels && args.channels.length > 0) {
        statement.raw(" AND channel IN (").list(args.channels).raw(")");
      }
      if (args.ids && args.ids.length > 0) {
        statement.raw(" AND id IN (").list(args.ids).raw(")");
      }

      statement
        .raw(" ORDER BY not_before ASC, id ASC LIMIT ")
        .value(args.limit)
        .raw(" FOR UPDATE SKIP LOCKED)")
        .raw(" RETURNING id, notification_id, channel, attempts, max_attempts)")
        .raw(
          " SELECT c.id, c.notification_id, c.channel, c.attempts, c.max_attempts," +
            " n.user_id, n.type, n.payload, n.actor_id FROM claimed c" +
            ` JOIN ${NOTIFICATION} n ON n.id = c.notification_id`,
        );

      const rows = await run(statement);

      return rows.map((row) => ({
        id: str(row.id),
        notificationId: str(row.notification_id),
        channel: str(row.channel) as Channel,
        attempts: num(row.attempts),
        maxAttempts: num(row.max_attempts),
        notification: {
          userId: str(row.user_id),
          type: str(row.type),
          payload: typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload,
          actorId: nullableStr(row.actor_id),
        },
      }));
    },

    async releaseDeliveries(releases: readonly DeliveryRelease[]) {
      if (releases.length === 0) return;
      const now = new Date();

      // No claimed_by predicate on purpose: terminal state beats a wedged row. RFC 0003 §6.
      const statement = new Statement().raw(
        `UPDATE ${DELIVERY} d SET status = CASE` +
          " WHEN v.result = 'sent' THEN 'sent'" +
          " WHEN v.result = 'skipped' THEN 'skipped'" +
          " WHEN v.retryable AND d.attempts + 1 < d.max_attempts THEN 'pending'" +
          " ELSE 'failed' END," +
          " attempts = CASE WHEN v.result IN ('sent', 'skipped')" +
          " THEN d.attempts ELSE d.attempts + 1 END," +
          " last_error = v.error," +
          " not_before = COALESCE(v.not_before, d.not_before)," +
          " claimed_at = NULL, claimed_by = NULL, updated_at = ",
      );

      statement.value(now).raw("::timestamptz FROM (VALUES ");

      releases.forEach(({ id, outcome, nextAttemptAt }, index) => {
        if (index > 0) statement.raw(", ");
        statement.tuple([
          [id, "text"],
          [outcome.result, "text"],
          [outcome.result === "failed" && outcome.retryable, "boolean"],
          [
            outcome.result === "failed"
              ? outcome.error.slice(0, 2000)
              : outcome.result === "skipped"
                ? outcome.reason.slice(0, 2000)
                : null,
            "text",
          ],
          [nextAttemptAt ?? null, "timestamptz"],
        ]);
      });

      statement.raw(") AS v(id, result, retryable, error, not_before) WHERE d.id = v.id");

      await run(statement);
    },

    async listNotifications(feed: FeedQuery): Promise<FeedPage> {
      const cursor = feed.cursor ? decodeCursor(feed.cursor) : null;

      const statement = new Statement()
        .raw(`SELECT * FROM ${NOTIFICATION} WHERE user_id = `)
        .value(feed.userId)
        .raw("::text AND archived_at IS NULL");

      if (feed.unreadOnly) statement.raw(" AND read_at IS NULL");

      if (cursor) {
        statement
          .raw(" AND (created_at, id) < (")
          .value(cursor.createdAt)
          .raw("::timestamptz, ")
          .value(cursor.id)
          .raw("::text)");
      }

      statement.raw(" ORDER BY created_at DESC, id DESC LIMIT ").value(feed.limit + 1);

      const rows = await run(statement);
      const page = rows.slice(0, feed.limit).map(toNotification);
      const last = page.at(-1);

      return {
        notifications: page,
        nextCursor: rows.length > feed.limit && last ? encodeCursor(last.createdAt, last.id) : null,
      };
    },

    async countUnseen(userId: string) {
      const rows = await run(
        new Statement()
          .raw(`SELECT count(*)::int AS count FROM ${NOTIFICATION} WHERE user_id = `)
          .value(userId)
          .raw("::text AND seen_at IS NULL AND archived_at IS NULL"),
      );
      return num(rows[0]?.count ?? 0);
    },

    async markSeen(userId: string, before: Date) {
      await run(
        new Statement()
          .raw(`UPDATE ${NOTIFICATION} SET seen_at = `)
          .value(new Date())
          .raw("::timestamptz WHERE user_id = ")
          .value(userId)
          .raw("::text AND seen_at IS NULL AND created_at <= ")
          .value(before)
          .raw("::timestamptz"),
      );
    },

    async markRead(userId: string, notificationIds: readonly string[]) {
      if (notificationIds.length === 0) return 0;

      // Scoped by user_id (RFC 0002 §2); no read_at IS NULL filter so re-marking stays idempotent.
      const rows = await run(
        new Statement()
          .raw(`UPDATE ${NOTIFICATION} SET read_at = COALESCE(read_at, `)
          .value(new Date())
          .raw("::timestamptz) WHERE user_id = ")
          .value(userId)
          .raw("::text AND id IN (")
          .list(notificationIds)
          .raw(") RETURNING id"),
      );
      return rows.length;
    },

    async markAllRead(userId: string) {
      const rows = await run(
        new Statement()
          .raw(`UPDATE ${NOTIFICATION} SET read_at = `)
          .value(new Date())
          .raw("::timestamptz WHERE user_id = ")
          .value(userId)
          .raw("::text AND read_at IS NULL RETURNING id"),
      );
      return rows.length;
    },

    async getFailedDeliveries(args: { since: Date; limit: number }) {
      const rows = await run(
        new Statement()
          .raw(`SELECT * FROM ${DELIVERY} WHERE status = 'failed' AND updated_at >= `)
          .value(args.since)
          .raw("::timestamptz ORDER BY updated_at DESC LIMIT ")
          .value(args.limit),
      );
      return rows.map(toDelivery);
    },

    async queryTable(table: string, where: WhereClause, queryOptions: QueryOptions) {
      const statement = new Statement().raw(`SELECT * FROM ${quote(table)}`);
      appendWhere(statement, where);

      if (queryOptions.orderBy) {
        const direction = queryOptions.orderBy.direction === "desc" ? "DESC" : "ASC";
        statement.raw(` ORDER BY ${quote(toSnakeCase(queryOptions.orderBy.field))} ${direction}`);
      }
      if (queryOptions.limit) statement.raw(" LIMIT ").value(queryOptions.limit);

      return [...(await run(statement))];
    },

    async insertRows(
      table: string,
      rows: readonly Record<string, unknown>[],
      onConflict?: readonly string[],
    ) {
      if (rows.length === 0) return 0;

      const columns = Object.keys(rows[0] ?? {});
      if (columns.length === 0) return 0;

      const statement = new Statement().raw(
        `INSERT INTO ${quote(table)} (${columns.map((c) => quote(toSnakeCase(c))).join(", ")}) VALUES `,
      );

      rows.forEach((row, index) => {
        if (index > 0) statement.raw(", ");
        statement
          .raw("(")
          .list(columns.map((column) => row[column]))
          .raw(")");
      });

      if (onConflict && onConflict.length > 0) {
        const assignments = columns
          .filter((column) => !onConflict.includes(column))
          .map((column) => {
            const quoted = quote(toSnakeCase(column));
            return `${quoted} = EXCLUDED.${quoted}`;
          });

        statement.raw(
          ` ON CONFLICT (${onConflict.map((f) => quote(toSnakeCase(f))).join(", ")}) DO UPDATE SET ${assignments.join(", ")}`,
        );
      }

      statement.raw(" RETURNING 1 AS ok");
      return (await run(statement)).length;
    },

    async updateRows(table: string, where: WhereClause, set: Record<string, unknown>) {
      const assignments = Object.entries(set);
      if (assignments.length === 0) return 0;

      const statement = new Statement().raw(`UPDATE ${quote(table)} SET `);

      assignments.forEach(([field, value], index) => {
        if (index > 0) statement.raw(", ");
        statement.raw(`${quote(toSnakeCase(field))} = `).value(value);
      });

      appendWhere(statement, where);
      statement.raw(" RETURNING 1 AS ok");

      return (await run(statement)).length;
    },

    async deleteRows(table: string, where: WhereClause) {
      const statement = new Statement().raw(`DELETE FROM ${quote(table)}`);
      appendWhere(statement, where);
      statement.raw(" RETURNING 1 AS ok");

      return (await run(statement)).length;
    },
  };
}
