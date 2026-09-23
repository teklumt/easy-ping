import type { Placeholder, Statement } from "./statement";
import { quoteWith } from "./statement";

export type Row = Record<string, unknown>;

export type SqlResult = {
  rows: readonly Row[];
  /** Rows an INSERT/UPDATE/DELETE touched; drivers without RETURNING report through this. */
  affectedRows: number;
};

/** The whole driver contract for the MySQL and SQLite adapters. */
export type SqlExec = (text: string, params: readonly unknown[]) => Promise<SqlResult>;

/** How a claim takes its rows. RFC 0005 §3. */
export type ClaimStrategy = "skip-locked" | "derived-update" | "subquery-update";

export type Dialect = {
  name: string;
  placeholder: Placeholder;
  quote: (identifier: string) => string;
  bind: (value: unknown) => unknown;
  readDate: (value: unknown) => Date;
  readNullableDate: (value: unknown) => Date | null;
  readJson: (value: unknown) => unknown;
  /** Appends `column IS DISTINCT FROM value` in the engine's spelling. */
  distinctFrom: (statement: Statement, column: string, value: unknown) => void;
  /** The clause after a multi-row INSERT that makes it an upsert. Columns arrive quoted. */
  upsertClause: (conflict: readonly string[], update: readonly string[]) => string;
  isDuplicateKey: (error: unknown) => boolean;
  /** A deadlock or busy lock the engine asks the caller to retry; the statement was rolled back. */
  isRetryableLock: (error: unknown) => boolean;
  claim: { withTransaction: ClaimStrategy; withoutTransaction: ClaimStrategy };
};

const parseUtc = (value: unknown): Date => {
  if (value instanceof Date) return value;
  const text = String(value).trim();
  // "2026-09-23 10:11:12.345" from a dateStrings driver carries no zone; it was written as UTC.
  return new Date(/^\d{4}-\d{2}-\d{2} /.test(text) ? `${text.replace(" ", "T")}Z` : text);
};

const readJson = (value: unknown) => (typeof value === "string" ? JSON.parse(value) : value);

const bindCommon = (value: unknown) => {
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value === undefined) return null;
  return value;
};

const code = (error: unknown) => (error as { code?: unknown } | null)?.code;
const errno = (error: unknown) => (error as { errno?: unknown } | null)?.errno;

export const mysqlDialect: Dialect = {
  name: "mysql",
  placeholder: "question",
  quote: quoteWith("`"),
  bind: (value) =>
    value instanceof Date ? value.toISOString().slice(0, 23).replace("T", " ") : bindCommon(value),
  readDate: parseUtc,
  readNullableDate: (value) => (value == null ? null : parseUtc(value)),
  readJson,
  distinctFrom: (statement, column, value) => {
    statement.raw(`NOT (${column} <=> `).value(value).raw(")");
  },
  // VALUES() rather than the 8.0.19 `AS new` alias: it also works on MariaDB.
  upsertClause: (conflict, update) =>
    ` ON DUPLICATE KEY UPDATE ${(
      update.length === 0
        ? [`${conflict[0]} = ${conflict[0]}`]
        : update.map((column) => `${column} = VALUES(${column})`)
    ).join(", ")}`,
  isDuplicateKey: (error) => code(error) === "ER_DUP_ENTRY" || errno(error) === 1062,
  isRetryableLock: (error) =>
    code(error) === "ER_LOCK_DEADLOCK" ||
    errno(error) === 1213 ||
    code(error) === "ER_LOCK_WAIT_TIMEOUT" ||
    errno(error) === 1205,
  claim: { withTransaction: "skip-locked", withoutTransaction: "derived-update" },
};

export const sqliteDialect: Dialect = {
  name: "sqlite",
  placeholder: "question",
  quote: quoteWith('"'),
  bind: (value) => (value instanceof Date ? value.toISOString() : bindCommon(value)),
  readDate: parseUtc,
  readNullableDate: (value) => (value == null ? null : parseUtc(value)),
  readJson,
  distinctFrom: (statement, column, value) => {
    statement.raw(`${column} IS NOT `).value(value);
  },
  upsertClause: (conflict, update) =>
    ` ON CONFLICT (${conflict.join(", ")}) DO ${
      update.length === 0
        ? "NOTHING"
        : `UPDATE SET ${update.map((column) => `${column} = excluded.${column}`).join(", ")}`
    }`,
  isDuplicateKey: (error) =>
    code(error) === "SQLITE_CONSTRAINT_UNIQUE" ||
    /UNIQUE constraint failed/i.test(String((error as Error | null)?.message ?? "")),
  isRetryableLock: (error) =>
    code(error) === "SQLITE_BUSY" ||
    /database is locked/i.test(String((error as Error | null)?.message ?? "")),
  claim: { withTransaction: "subquery-update", withoutTransaction: "subquery-update" },
};
