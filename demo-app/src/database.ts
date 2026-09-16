import { drizzle } from "drizzle-orm/postgres-js";
import type { DatabaseAdapter, SchemaDeclaration } from "easy-notify";
import { drizzleAdapter } from "easy-notify/adapters/drizzle";
import {
  createMongoIndexes,
  createPluginIndexes,
  mongoAdapter,
} from "easy-notify/adapters/mongodb";
import { coreSchema, renderPostgresDdl } from "easy-notify/schema";
import { MongoClient } from "mongodb";
import postgres from "postgres";

export type Driver = "postgres" | "mongodb";

/**
 * The same demo against either database. Everything above this file is
 * identical for both — that is the point of the exercise.
 */
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

    const db = client.db(process.env.MONGO_DB ?? "easynotify_demo");
    await createMongoIndexes(db);
    for (const schema of pluginSchemas) await createPluginIndexes(db, schema);

    // The client, not just the db: it is what makes createNotifications
    // transactional, which needs the replica set docker compose sets up.
    return { adapter: mongoAdapter(db, { client }), label: `mongodb ${redact(url)}` };
  }

  const url =
    process.env.DATABASE_URL ?? "postgres://easynotify:easynotify@localhost:54329/easynotify_test";
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
