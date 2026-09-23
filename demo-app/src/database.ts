import { drizzle } from "drizzle-orm/postgres-js";
import type { DatabaseAdapter, SchemaDeclaration } from "easy-ping";
import { drizzleAdapter } from "easy-ping/adapters/drizzle";
import { createMongoIndexes, createPluginIndexes, mongoAdapter } from "easy-ping/adapters/mongodb";
import {
  createMysqlTables,
  mysql2Query,
  mysqlAdapter,
  mysqlTransaction,
} from "easy-ping/adapters/mysql";
import {
  createSqliteTables,
  sqliteAdapter,
  sqliteQuery,
  sqliteTransaction,
} from "easy-ping/adapters/sqlite";
import { coreSchema, renderPostgresDdl } from "easy-ping/schema";
import { MongoClient } from "mongodb";
import mysql from "mysql2/promise";
import postgres from "postgres";

export type Driver = "postgres" | "mongodb" | "mysql" | "sqlite";

export const DRIVERS: readonly Driver[] = ["postgres", "mongodb", "mysql", "sqlite"];

/** The same demo against any of the four databases; everything above this file is identical. */
export async function connect(
  driver: Driver,
  pluginSchemas: readonly SchemaDeclaration[],
): Promise<{ adapter: DatabaseAdapter; label: string }> {
  if (driver === "mongodb") {
    const url = process.env.MONGO_URL ?? "mongodb://localhost:27019/?replicaSet=rs0";
    const client = new MongoClient(url, { serverSelectionTimeoutMS: 5000 });

    try {
      await client.connect();
    } catch (error) {
      fail(`MongoDB at ${redact(url)}`, error);
    }

    const db = client.db(process.env.MONGO_DB ?? "easyping_demo");
    await createMongoIndexes(db);
    for (const schema of pluginSchemas) await createPluginIndexes(db, schema);

    return { adapter: mongoAdapter(db, { client }), label: `mongodb ${redact(url)}` };
  }

  if (driver === "mysql") {
    const url = process.env.MYSQL_URL ?? "mysql://root:easyping@localhost:33069/easyping_demo";
    const pool = mysql.createPool({ uri: url, timezone: "Z", connectTimeout: 5000 });
    const query = mysql2Query(pool);

    try {
      await createMysqlTables(query, { plugins: pluginSchemas });
    } catch (error) {
      fail(`MySQL at ${redact(url)}`, error);
    }

    return {
      adapter: mysqlAdapter(query, { transaction: mysqlTransaction(pool) }),
      label: `mysql ${redact(url)}`,
    };
  }

  if (driver === "sqlite") {
    const path = process.env.SQLITE_PATH ?? ":memory:";
    const { DatabaseSync } = process.getBuiltinModule(
      "node:sqlite",
    ) as typeof import("node:sqlite");
    const db = new DatabaseSync(path);
    const query = sqliteQuery(db);
    await createSqliteTables(query, { plugins: pluginSchemas });

    return {
      adapter: sqliteAdapter(query, { transaction: sqliteTransaction(db) }),
      label: `sqlite ${path}`,
    };
  }

  const url =
    process.env.DATABASE_URL ?? "postgres://easyping:easyping@localhost:54329/easyping_test";
  const sql = postgres(url, { onnotice: () => {} });

  try {
    for (const schema of [coreSchema, ...pluginSchemas]) {
      for (const statement of renderPostgresDdl(schema)) await sql.unsafe(statement);
    }
  } catch (error) {
    fail(`Postgres at ${redact(url)}`, error);
  }

  return { adapter: drizzleAdapter(drizzle(sql)), label: `postgres ${redact(url)}` };
}

const redact = (url: string) => url.replace(/:[^:@]*@/, ":***@");

function fail(target: string, error: unknown): never {
  console.error("");
  console.error(`  Cannot reach ${target}`);
  console.error("  Start it with:  docker compose up -d   (from the repo root)");
  console.error("");
  console.error(`  ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
