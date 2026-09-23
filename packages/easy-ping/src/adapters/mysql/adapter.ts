import type { DatabaseAdapter } from "../../core/adapter";
import { createSqlAdapter, type SqlAdapterOptions } from "../sql/adapter";
import { mysqlDialect, type SqlExec } from "../sql/dialect";

export type MysqlAdapterOptions = SqlAdapterOptions;

/**
 * MySQL 8 or MariaDB through any driver. With `transaction` a claim uses
 * FOR UPDATE SKIP LOCKED; without it a lock-free UPDATE that never double-claims. RFC 0005 §3.
 */
export function mysqlAdapter(query: SqlExec, options: MysqlAdapterOptions = {}): DatabaseAdapter {
  return createSqlAdapter(mysqlDialect, query, options);
}
