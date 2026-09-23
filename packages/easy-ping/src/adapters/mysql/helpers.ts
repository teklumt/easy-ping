import type { SchemaDeclaration } from "../../core/plugin";
import { coreSchema } from "../../schema/declaration";
import { renderMysqlDdl } from "../../schema/render-mysql";
import type { Row, SqlExec, SqlResult } from "../sql/dialect";

/** The slice of a mysql2 pool or connection this needs, structurally. */
export type Mysql2Queryable = {
  // biome-ignore lint/suspicious/noExplicitAny: must accept mysql2's own overloaded signature
  query(sql: string, values?: any): Promise<[unknown, unknown]>;
};

export type Mysql2PoolLike = Mysql2Queryable & {
  getConnection(): Promise<
    Mysql2Queryable & {
      beginTransaction(): Promise<void>;
      commit(): Promise<void>;
      rollback(): Promise<void>;
      release(): void;
    }
  >;
};

/** mysql2 returns rows for a SELECT and a ResultSetHeader for anything else. */
function toResult([result]: [unknown, unknown]): SqlResult {
  if (Array.isArray(result)) return { rows: result as Row[], affectedRows: 0 };
  const header = result as { affectedRows?: unknown } | null;
  return { rows: [], affectedRows: Number(header?.affectedRows ?? 0) };
}

/** The SqlExec for a mysql2 pool. Create the pool with `timezone: "Z"`, or DATETIME comes back shifted. */
export const mysql2Query =
  (pool: Mysql2Queryable): SqlExec =>
  async (text, params) =>
    toResult(await pool.query(text, [...params]));

/** The `transaction` option for mysql2. */
export function mysqlTransaction(pool: Mysql2PoolLike) {
  return async <T>(fn: (exec: SqlExec) => Promise<T>): Promise<T> => {
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const result = await fn(async (text, params) =>
        toResult(await connection.query(text, [...params])),
      );
      await connection.commit();
      return result;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  };
}

export type CreateMysqlTablesOptions = {
  /** Must match the prefix given to the adapter. */
  prefix?: string;
  /** Plugin schemas, e.g. `pushSchema`. */
  plugins?: readonly SchemaDeclaration[];
};

/** Creates core and plugin tables, IF NOT EXISTS. Bootstrap, not migration. */
export async function createMysqlTables(
  query: SqlExec,
  options: CreateMysqlTablesOptions = {},
): Promise<number> {
  let count = 0;
  for (const schema of [coreSchema, ...(options.plugins ?? [])]) {
    for (const statement of renderMysqlDdl(schema, options.prefix)) {
      await query(statement, []);
      count += 1;
    }
  }
  return count;
}
