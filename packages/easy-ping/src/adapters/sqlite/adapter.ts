import type { DatabaseAdapter } from "../../core/adapter";
import { createSqlAdapter, type SqlAdapterOptions } from "../sql/adapter";
import { type SqlExec, sqliteDialect } from "../sql/dialect";

export type SqliteAdapterOptions = SqlAdapterOptions;

/**
 * SQLite through any driver. One writer at a time, so the claim is a plain
 * UPDATE … WHERE id IN (SELECT … LIMIT ?). Dates are ISO text, booleans 0/1, JSON text. RFC 0005 §3.
 */
export function sqliteAdapter(query: SqlExec, options: SqliteAdapterOptions = {}): DatabaseAdapter {
  return createSqlAdapter(sqliteDialect, query, options);
}
