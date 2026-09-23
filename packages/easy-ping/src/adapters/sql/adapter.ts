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
import type { Dialect, Row, SqlExec, SqlResult } from "./dialect";
import { Statement } from "./statement";

export type SqlAdapterOptions = {
  /** Table-name prefix. Must match the instance's `tablePrefix`. */
  prefix?: string;
  /** Makes createNotifications atomic and, on MySQL, lets a claim use FOR UPDATE SKIP LOCKED. */
  transaction?: <T>(fn: (exec: SqlExec) => Promise<T>) => Promise<T>;
};

const str = (value: unknown): string => String(value);
const nullableStr = (value: unknown): string | null => (value == null ? null : String(value));
const num = (value: unknown): number => Number(value);

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

const NONE: SqlResult = { rows: [], affectedRows: 0 };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** InnoDB rolls back the loser of a deadlock and asks for a retry; bounded and jittered. */
async function retryingLocks<T>(dialect: Dialect, attempt: () => Promise<T>): Promise<T> {
  for (let tries = 0; ; tries += 1) {
    try {
      return await attempt();
    } catch (error) {
      if (tries >= 5 || !dialect.isRetryableLock(error)) throw error;
      await sleep(5 + Math.random() * 20 * (tries + 1));
    }
  }
}

/**
 * Every SQL engine that is not Postgres, behind one dialect: the same queries
 * minus RETURNING, casts and IS DISTINCT FROM. RFC 0005.
 */
export function createSqlAdapter(
  dialect: Dialect,
  exec: SqlExec,
  options: SqlAdapterOptions = {},
): DatabaseAdapter {
  const prefix = options.prefix ?? "";
  const q = dialect.quote;
  const NOTIFICATION = q(`${prefix}notification`);
  const DELIVERY = q(`${prefix}notification_delivery`);

  const stmt = () => new Statement({ placeholder: dialect.placeholder, bind: dialect.bind });
  const run = (statement: Statement, on: SqlExec = exec) => on(statement.text, statement.params);
  const atomically = <T>(fn: (on: SqlExec) => Promise<T>): Promise<T> =>
    options.transaction ? options.transaction(fn) : fn(exec);

  const toNotification = (row: Row): NotificationRecord => ({
    id: str(row.id),
    userId: str(row.user_id),
    type: str(row.type),
    payload: dialect.readJson(row.payload),
    actorId: nullableStr(row.actor_id),
    groupKey: nullableStr(row.group_key),
    dedupeKey: nullableStr(row.dedupe_key),
    seenAt: dialect.readNullableDate(row.seen_at),
    readAt: dialect.readNullableDate(row.read_at),
    archivedAt: dialect.readNullableDate(row.archived_at),
    createdAt: dialect.readDate(row.created_at),
  });

  const toDelivery = (row: Row): DeliveryRecord => ({
    id: str(row.id),
    notificationId: str(row.notification_id),
    channel: str(row.channel) as Channel,
    status: str(row.status) as DeliveryStatus,
    attempts: num(row.attempts),
    maxAttempts: num(row.max_attempts),
    notBefore: dialect.readDate(row.not_before),
    claimedAt: dialect.readNullableDate(row.claimed_at),
    claimedBy: nullableStr(row.claimed_by),
    lastError: nullableStr(row.last_error),
    updatedAt: dialect.readDate(row.updated_at),
  });

  function appendWhere(statement: Statement, where: WhereClause): void {
    const entries = Object.entries(where);
    if (entries.length === 0) return;

    statement.raw(" WHERE ");

    entries.forEach(([field, condition], index) => {
      if (index > 0) statement.raw(" AND ");
      const column = q(toSnakeCase(field));

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
        if (list.length === 0) statement.raw("1 = 0");
        else statement.raw(`${column} IN (`).list(list).raw(")");
        return;
      }
      if ("lt" in operator) statement.raw(`${column} < `).value(operator.lt);
      else if ("lte" in operator) statement.raw(`${column} <= `).value(operator.lte);
      else if ("gt" in operator) statement.raw(`${column} > `).value(operator.gt);
      else if ("gte" in operator) statement.raw(`${column} >= `).value(operator.gte);
      else if ("not" in operator) {
        if (operator.not === null) statement.raw(`${column} IS NOT NULL`);
        else dialect.distinctFrom(statement, column, operator.not);
      } else statement.raw("1 = 1");
    });
  }

  function eligible(statement: Statement, args: ClaimArgs, now: Date, staleBefore: Date): void {
    statement
      .raw("(status = 'pending' OR (status = 'claimed' AND claimed_at < ")
      .value(staleBefore)
      .raw(")) AND not_before <= ")
      .value(now)
      .raw(" AND attempts < max_attempts");
    if (args.channels && args.channels.length > 0) {
      statement.raw(" AND channel IN (").list(args.channels).raw(")");
    }
    if (args.ids && args.ids.length > 0) {
      statement.raw(" AND id IN (").list(args.ids).raw(")");
    }
  }

  /** The token is unique per call, so this is exactly what the call just claimed. */
  const readClaimed = (token: string, on: SqlExec) =>
    run(
      stmt()
        .raw(
          "SELECT c.id, c.notification_id, c.channel, c.attempts, c.max_attempts," +
            ` n.user_id, n.type, n.payload, n.actor_id FROM ${DELIVERY} c` +
            ` JOIN ${NOTIFICATION} n ON n.id = c.notification_id WHERE c.claimed_by = `,
        )
        .value(token)
        .raw(" AND c.status = 'claimed' ORDER BY c.not_before ASC, c.id ASC"),
      on,
    );

  return {
    name: dialect.name,
    naming: "snake_case",
    serializesJson: true,

    async createNotifications(input: readonly InsertNotification[]) {
      if (input.length === 0) return { created: [], deduped: [] };
      const now = new Date();

      return atomically(async (on) => {
        const created: string[] = [];
        const deduped: string[] = [];

        // No RETURNING on MySQL and INSERT IGNORE hides real errors: look, insert, treat a race as dedupe.
        for (const row of input) {
          if (row.dedupeKey) {
            const existing = await run(
              stmt()
                .raw(`SELECT id FROM ${NOTIFICATION} WHERE user_id = `)
                .value(row.userId)
                .raw(" AND dedupe_key = ")
                .value(row.dedupeKey),
              on,
            );
            if (existing.rows.length > 0) {
              deduped.push(row.id);
              continue;
            }
          }

          try {
            await run(
              stmt()
                .raw(
                  `INSERT INTO ${NOTIFICATION} ` +
                    "(id, user_id, type, payload, actor_id, group_key, dedupe_key, created_at) VALUES (",
                )
                .list([
                  row.id,
                  row.userId,
                  row.type,
                  JSON.stringify(row.payload ?? null),
                  row.actorId ?? null,
                  row.groupKey ?? null,
                  row.dedupeKey ?? null,
                  now,
                ])
                .raw(")"),
              on,
            );
          } catch (error) {
            if (row.dedupeKey && dialect.isDuplicateKey(error)) {
              deduped.push(row.id);
              continue;
            }
            throw error;
          }
          created.push(row.id);
        }

        const createdSet = new Set(created);
        const deliveries = input
          .filter((row) => createdSet.has(row.id))
          .flatMap((row) => row.deliveries.map((delivery) => ({ row, delivery })));

        if (deliveries.length > 0) {
          const insert = stmt().raw(
            `INSERT INTO ${DELIVERY} ` +
              "(id, notification_id, channel, max_attempts, not_before, updated_at) VALUES ",
          );
          deliveries.forEach(({ row, delivery }, index) => {
            if (index > 0) insert.raw(", ");
            insert
              .raw("(")
              .list([
                delivery.id,
                row.id,
                delivery.channel,
                delivery.maxAttempts,
                delivery.notBefore,
                now,
              ])
              .raw(")");
          });
          await run(insert, on);
        }

        return { created, deduped };
      });
    },

    async claimPendingDeliveries(args: ClaimArgs): Promise<readonly ClaimedDelivery[]> {
      const now = args.now ?? new Date();
      const staleBefore = new Date(now.getTime() - args.leaseMs);
      const strategy = options.transaction
        ? dialect.claim.withTransaction
        : dialect.claim.withoutTransaction;

      const claimSet = (statement: Statement) =>
        statement
          .raw("status = 'claimed', claimed_at = ")
          .value(now)
          .raw(", claimed_by = ")
          .value(args.claimToken);

      let result: SqlResult;

      if (strategy === "skip-locked") {
        result = await atomically(async (on) => {
          const pick = stmt().raw(`SELECT id FROM ${DELIVERY} WHERE `);
          eligible(pick, args, now, staleBefore);
          pick
            .raw(" ORDER BY not_before ASC, id ASC LIMIT ")
            .value(args.limit)
            .raw(" FOR UPDATE SKIP LOCKED");
          const ids = (await run(pick, on)).rows.map((row) => str(row.id));
          if (ids.length === 0) return NONE;

          const update = stmt().raw(`UPDATE ${DELIVERY} SET `);
          claimSet(update).raw(" WHERE id IN (").list(ids).raw(")");
          await run(update, on);
          return readClaimed(args.claimToken, on);
        });
      } else {
        const update = stmt();
        if (strategy === "derived-update") {
          // The derived table is materialised, which is what lets MySQL update the table it
          // selects from; the outer predicate is re-evaluated on the locked row.
          update.raw(`UPDATE ${DELIVERY} d JOIN (SELECT id FROM ${DELIVERY} WHERE `);
          eligible(update, args, now, staleBefore);
          update
            .raw(" ORDER BY not_before ASC, id ASC LIMIT ")
            .value(args.limit)
            .raw(") s ON s.id = d.id SET d.status = 'claimed', d.claimed_at = ")
            .value(now)
            .raw(", d.claimed_by = ")
            .value(args.claimToken)
            .raw(" WHERE d.status = 'pending' OR (d.status = 'claimed' AND d.claimed_at < ")
            .value(staleBefore)
            .raw(")");
        } else {
          update.raw(`UPDATE ${DELIVERY} SET `);
          claimSet(update).raw(` WHERE id IN (SELECT id FROM ${DELIVERY} WHERE `);
          eligible(update, args, now, staleBefore);
          update.raw(" ORDER BY not_before ASC, id ASC LIMIT ").value(args.limit).raw(")");
        }
        const updated = await retryingLocks(dialect, () => run(update));
        result = updated.affectedRows > 0 ? await readClaimed(args.claimToken, exec) : NONE;
      }

      return result.rows.map((row) => ({
        id: str(row.id),
        notificationId: str(row.notification_id),
        channel: str(row.channel) as Channel,
        attempts: num(row.attempts),
        maxAttempts: num(row.max_attempts),
        notification: {
          userId: str(row.user_id),
          type: str(row.type),
          payload: dialect.readJson(row.payload),
          actorId: nullableStr(row.actor_id),
        },
      }));
    },

    async releaseDeliveries(releases: readonly DeliveryRelease[]) {
      if (releases.length === 0) return;
      const now = new Date();

      // No claimed_by predicate (RFC 0003 §6). `status` before `attempts`: MySQL evaluates SET
      // left to right with updated values, and the CASE needs the old count.
      await atomically(async (on) => {
        for (const { id, outcome, nextAttemptAt } of releases) {
          const result = outcome.result;
          const retryable = outcome.result === "failed" && outcome.retryable;
          const error =
            outcome.result === "failed"
              ? outcome.error.slice(0, 2000)
              : outcome.result === "skipped"
                ? outcome.reason.slice(0, 2000)
                : null;

          await run(
            stmt()
              .raw(`UPDATE ${DELIVERY} SET status = CASE WHEN `)
              .value(result)
              .raw(" = 'sent' THEN 'sent' WHEN ")
              .value(result)
              .raw(" = 'skipped' THEN 'skipped' WHEN ")
              .value(retryable)
              .raw(" = 1 AND attempts + 1 < max_attempts THEN 'pending' ELSE 'failed' END")
              .raw(", attempts = CASE WHEN ")
              .value(result)
              .raw(" IN ('sent', 'skipped') THEN attempts ELSE attempts + 1 END")
              .raw(", last_error = ")
              .value(error)
              .raw(", not_before = COALESCE(")
              .value(nextAttemptAt ?? null)
              .raw(", not_before), claimed_at = NULL, claimed_by = NULL, updated_at = ")
              .value(now)
              .raw(" WHERE id = ")
              .value(id),
            on,
          );
        }
      });
    },

    async listNotifications(feed: FeedQuery): Promise<FeedPage> {
      const cursor = feed.cursor ? decodeCursor(feed.cursor) : null;

      const statement = stmt()
        .raw(`SELECT * FROM ${NOTIFICATION} WHERE user_id = `)
        .value(feed.userId)
        .raw(" AND archived_at IS NULL");
      if (feed.unreadOnly) statement.raw(" AND read_at IS NULL");
      if (cursor) {
        statement
          .raw(" AND (created_at, id) < (")
          .value(cursor.createdAt)
          .raw(", ")
          .value(cursor.id)
          .raw(")");
      }
      statement.raw(" ORDER BY created_at DESC, id DESC LIMIT ").value(feed.limit + 1);

      const { rows } = await run(statement);
      const page = rows.slice(0, feed.limit).map(toNotification);
      const last = page.at(-1);

      return {
        notifications: page,
        nextCursor: rows.length > feed.limit && last ? encodeCursor(last.createdAt, last.id) : null,
      };
    },

    async countUnseen(userId: string) {
      const { rows } = await run(
        stmt()
          .raw(`SELECT COUNT(*) AS count FROM ${NOTIFICATION} WHERE user_id = `)
          .value(userId)
          .raw(" AND seen_at IS NULL AND archived_at IS NULL"),
      );
      return num(rows[0]?.count ?? 0);
    },

    async markSeen(userId: string, before: Date) {
      await run(
        stmt()
          .raw(`UPDATE ${NOTIFICATION} SET seen_at = `)
          .value(new Date())
          .raw(" WHERE user_id = ")
          .value(userId)
          .raw(" AND seen_at IS NULL AND created_at <= ")
          .value(before),
      );
    },

    async markRead(userId: string, notificationIds: readonly string[]) {
      if (notificationIds.length === 0) return 0;

      // Idempotent, so the answer is rows matched; MySQL's affectedRows reports rows changed.
      await run(
        stmt()
          .raw(`UPDATE ${NOTIFICATION} SET read_at = COALESCE(read_at, `)
          .value(new Date())
          .raw(") WHERE user_id = ")
          .value(userId)
          .raw(" AND id IN (")
          .list(notificationIds)
          .raw(")"),
      );
      const { rows } = await run(
        stmt()
          .raw(`SELECT COUNT(*) AS count FROM ${NOTIFICATION} WHERE user_id = `)
          .value(userId)
          .raw(" AND id IN (")
          .list(notificationIds)
          .raw(")"),
      );
      return num(rows[0]?.count ?? 0);
    },

    async markAllRead(userId: string) {
      const { affectedRows } = await run(
        stmt()
          .raw(`UPDATE ${NOTIFICATION} SET read_at = `)
          .value(new Date())
          .raw(" WHERE user_id = ")
          .value(userId)
          .raw(" AND read_at IS NULL"),
      );
      return affectedRows;
    },

    async getFailedDeliveries(args: { since: Date; limit: number }) {
      const { rows } = await run(
        stmt()
          .raw(`SELECT * FROM ${DELIVERY} WHERE status = 'failed' AND updated_at >= `)
          .value(args.since)
          .raw(" ORDER BY updated_at DESC LIMIT ")
          .value(args.limit),
      );
      return rows.map(toDelivery);
    },

    async queryTable(table: string, where: WhereClause, queryOptions: QueryOptions) {
      const statement = stmt().raw(`SELECT * FROM ${q(table)}`);
      appendWhere(statement, where);
      if (queryOptions.orderBy) {
        const direction = queryOptions.orderBy.direction === "desc" ? "DESC" : "ASC";
        statement.raw(` ORDER BY ${q(toSnakeCase(queryOptions.orderBy.field))} ${direction}`);
      }
      if (queryOptions.limit) statement.raw(" LIMIT ").value(queryOptions.limit);
      return [...(await run(statement)).rows];
    },

    async insertRows(
      table: string,
      rows: readonly Record<string, unknown>[],
      onConflict?: readonly string[],
    ) {
      if (rows.length === 0) return 0;
      const columns = Object.keys(rows[0] ?? {});
      if (columns.length === 0) return 0;

      const statement = stmt().raw(
        `INSERT INTO ${q(table)} (${columns.map((c) => q(toSnakeCase(c))).join(", ")}) VALUES `,
      );
      rows.forEach((row, index) => {
        if (index > 0) statement.raw(", ");
        statement
          .raw("(")
          .list(columns.map((column) => row[column]))
          .raw(")");
      });

      if (onConflict && onConflict.length > 0) {
        statement.raw(
          dialect.upsertClause(
            onConflict.map((f) => q(toSnakeCase(f))),
            columns.filter((c) => !onConflict.includes(c)).map((c) => q(toSnakeCase(c))),
          ),
        );
        await run(statement);
        // MySQL reports 2 for an updated row; the rows handed in is the honest count.
        return rows.length;
      }

      return (await run(statement)).affectedRows;
    },

    async updateRows(table: string, where: WhereClause, set: Record<string, unknown>) {
      const assignments = Object.entries(set);
      if (assignments.length === 0) return 0;

      const statement = stmt().raw(`UPDATE ${q(table)} SET `);
      assignments.forEach(([field, value], index) => {
        if (index > 0) statement.raw(", ");
        statement.raw(`${q(toSnakeCase(field))} = `).value(value);
      });
      appendWhere(statement, where);
      return (await run(statement)).affectedRows;
    },

    async deleteRows(table: string, where: WhereClause) {
      const statement = stmt().raw(`DELETE FROM ${q(table)}`);
      appendWhere(statement, where);
      return (await run(statement)).affectedRows;
    },
  };
}
