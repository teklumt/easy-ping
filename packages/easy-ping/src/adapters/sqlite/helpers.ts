import type { SchemaDeclaration } from "../../core/plugin";
import { coreSchema } from "../../schema/declaration";
import { renderSqliteDdl } from "../../schema/render-sqlite";
import type { Row, SqlExec } from "../sql/dialect";

/** node:sqlite's DatabaseSync and better-sqlite3's Database, structurally, so neither is a dependency. */
export type SqliteDatabaseLike = {
  prepare(sql: string): {
    all(...params: unknown[]): unknown;
    run(...params: unknown[]): { changes: number | bigint };
  };
  exec(sql: string): unknown;
};

const returnsRows = (text: string) =>
  /^\s*(select|with|pragma)\b/i.test(text) || /\breturning\b/i.test(text);

/** The SqlExec for a synchronous SQLite driver. */
export const sqliteQuery =
  (db: SqliteDatabaseLike): SqlExec =>
  async (text, params) => {
    const statement = db.prepare(text);
    if (returnsRows(text)) return { rows: statement.all(...params) as Row[], affectedRows: 0 };
    const { changes } = statement.run(...params);
    return { rows: [], affectedRows: Number(changes) };
  };

/**
 * The `transaction` option for a synchronous driver. Queued one behind another: the adapter
 * awaits between statements, and SQLite refuses a BEGIN inside an open transaction.
 */
export function sqliteTransaction(db: SqliteDatabaseLike) {
  const exec = sqliteQuery(db);
  let tail: Promise<unknown> = Promise.resolve();

  return <T>(fn: (exec: SqlExec) => Promise<T>): Promise<T> => {
    const run = tail.then(async () => {
      db.exec("BEGIN");
      try {
        const result = await fn(exec);
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    });
    tail = run.catch(() => undefined);
    return run;
  };
}

export type CreateSqliteTablesOptions = {
  prefix?: string;
  plugins?: readonly SchemaDeclaration[];
};

/** Creates core and plugin tables, IF NOT EXISTS. Bootstrap, not migration. */
export async function createSqliteTables(
  query: SqlExec,
  options: CreateSqliteTablesOptions = {},
): Promise<number> {
  let count = 0;
  for (const schema of [coreSchema, ...(options.plugins ?? [])]) {
    for (const statement of renderSqliteDdl(schema, options.prefix)) {
      await query(statement, []);
      count += 1;
    }
  }
  return count;
}
