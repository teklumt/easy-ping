import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { drizzleAdapter } from "../../src/adapters/drizzle/adapter";
import type { DatabaseAdapter } from "../../src/core/adapter";
import type { SchemaDeclaration } from "../../src/core/plugin";
import { createPluginStore, type PluginStore } from "../../src/core/store";
import { coreSchema } from "../../src/schema/declaration";
import { renderPostgresDdl } from "../../src/schema/render-sql";

export const TEST_DATABASE_URL =
  process.env.EASY_NOTIFY_TEST_DATABASE_URL ??
  "postgres://easynotify:easynotify@localhost:54329/easynotify_test";

export async function postgresReachable(): Promise<boolean> {
  let reachable = false;
  try {
    const probe = postgres(TEST_DATABASE_URL, {
      max: 1,
      connect_timeout: 3,
      onnotice: () => {},
    });
    await probe`SELECT 1`;
    await probe.end();
    reachable = true;
  } catch {
    reachable = false;
  }

  // Skipping is a local convenience. In CI it would mean a green build that
  // ran none of the database tests — strictly worse than a red one.
  if (!reachable && process.env.CI) {
    throw new Error(
      `Postgres unreachable at ${TEST_DATABASE_URL} and CI is set. ` +
        "Database tests must not be skipped in CI — start the service before running the suite.",
    );
  }

  if (!reachable) {
    console.warn(
      `\n[easy-notify] Postgres unreachable at ${TEST_DATABASE_URL} — database tests skipped.\n` +
        "Run `docker compose up -d` from the repo root to exercise them.\n",
    );
  }

  return reachable;
}

export type TestDatabase = {
  client: ReturnType<typeof postgres>;
  adapter: DatabaseAdapter;
  /** Same store the preferences plugin gets, for seeding and assertions. */
  preferences: PluginStore;
  truncate: () => Promise<void>;
  end: () => Promise<void>;
};

const PREFERENCE_SCHEMA = {
  notificationPreference: {
    tableName: "notification_preference",
    fields: {
      userId: { type: "string", required: true },
      type: { type: "string", required: true },
      channel: { type: "string", required: true },
      enabled: { type: "boolean", required: true },
      frequency: { type: "string", required: true },
    },
    primaryKey: ["userId", "type", "channel"],
  },
} satisfies SchemaDeclaration;

/**
 * One Postgres schema per test file.
 *
 * Vitest runs files in parallel, so a shared set of tables means one file's
 * TRUNCATE wipes another's fixtures mid-run. Isolating by schema keeps the
 * parallelism instead of paying for it with `fileParallelism: false`.
 */
export async function createTestDatabase(namespace: string): Promise<TestDatabase> {
  const schema = `test_${namespace}`;

  const bootstrap = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} });
  await bootstrap.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await bootstrap.unsafe(`CREATE SCHEMA ${schema}`);
  await bootstrap.end();

  const client = postgres(TEST_DATABASE_URL, {
    max: 8,
    onnotice: () => {},
    connection: { search_path: schema },
  });

  for (const statement of renderPostgresDdl(coreSchema)) {
    await client.unsafe(statement);
  }

  const adapter = drizzleAdapter(drizzle(client));

  return {
    client,
    adapter,
    preferences: createPluginStore("test", PREFERENCE_SCHEMA, adapter, ""),
    truncate: async () => {
      await client.unsafe(
        `TRUNCATE ${schema}.notification_delivery, ${schema}.notification, ${schema}.notification_preference RESTART IDENTITY CASCADE`,
      );
    },
    end: async () => {
      await client.end();
    },
  };
}
