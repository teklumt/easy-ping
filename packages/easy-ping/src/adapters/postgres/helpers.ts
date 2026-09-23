import type { SchemaDeclaration } from "../../core/plugin";
import { coreSchema, renderPostgresDdl } from "../../schema";
import type { SqlQuery } from "./adapter";

/** The slice of pg's Pool this needs, structurally. */
export type PgPoolLike = {
  connect(): Promise<{
    query(text: string, params?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
    release(): void;
  }>;
};

/** The `transaction` option for node-postgres. */
export function pgTransaction(pool: PgPoolLike) {
  return async <T>(fn: (query: SqlQuery) => Promise<T>): Promise<T> => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(async (text, params) => (await client.query(text, params)).rows);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  };
}

export type CreateTablesOptions = {
  /** Must match the prefix given to the adapter. */
  prefix?: string;
  /** Plugin schemas, e.g. `pushSchema`. */
  plugins?: readonly SchemaDeclaration[];
};

/** Creates core and plugin tables, IF NOT EXISTS. Bootstrap, not migration. */
export async function createPostgresTables(
  query: SqlQuery,
  options: CreateTablesOptions = {},
): Promise<number> {
  const schemas: readonly SchemaDeclaration[] = [coreSchema, ...(options.plugins ?? [])];

  let count = 0;
  for (const schema of schemas) {
    for (const statement of renderPostgresDdl(schema, options.prefix)) {
      await query(statement, []);
      count += 1;
    }
  }
  return count;
}
