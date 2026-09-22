import type { SchemaDeclaration } from "../../core/plugin";
import { coreSchema, renderPostgresDdl } from "../../schema";
import type { SqlQuery } from "./adapter";

/**
 * The slice of `pg`'s Pool this needs, declared structurally so the library
 * takes no dependency on the driver. `postgres.js` and Kysely have their own
 * transaction helpers and do not need this one.
 */
export type PgPoolLike = {
  connect(): Promise<{
    query(text: string, params?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
    release(): void;
  }>;
};

/**
 * The `transaction` option for `node-postgres`, so callers stop hand-writing
 * the same sixteen lines of BEGIN/COMMIT/ROLLBACK/release.
 *
 *     postgresAdapter(query, { transaction: pgTransaction(pool) })
 *
 * The `finally` is the part worth having in one place: drop the release and
 * every send leaks a connection until the pool is exhausted.
 */
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
  /**
   * Schemas owned by plugins, exported alongside each plugin — `pushSchema`
   * from `easy-ping/plugins/push`, for instance.
   */
  plugins?: readonly SchemaDeclaration[];
};

/**
 * Creates the core tables, plus any plugin tables passed, and returns how many
 * statements ran.
 *
 * Every statement is `IF NOT EXISTS`, so this is safe to run on every boot.
 * It is a bootstrap, not a migration: it never alters a table that already
 * exists. Once a database is live, use `planPostgresMigration` instead.
 */
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
