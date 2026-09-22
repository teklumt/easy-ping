import { drizzle } from "drizzle-orm/postgres-js";
import { MongoClient } from "mongodb";
import postgres from "postgres";
import { drizzleAdapter } from "../../src/adapters/drizzle/adapter";
import { mongoAdapter } from "../../src/adapters/mongodb/adapter";
import { createMongoIndexes, createPluginIndexes } from "../../src/adapters/mongodb/indexes";
import { postgresAdapter } from "../../src/adapters/postgres/adapter";
import type { DatabaseAdapter } from "../../src/core/adapter";
import type { SchemaDeclaration } from "../../src/core/plugin";
import { coreSchema } from "../../src/schema/declaration";
import { renderPostgresDdl } from "../../src/schema/render-sql";
import { mongoReachable, TEST_MONGO_URL } from "./mongo";
import { postgresReachable, TEST_DATABASE_URL } from "./pg";

/**
 * One database-shaped surface, so a behaviour test can be written once and run
 * against every adapter. Anything that differs between backends lives here;
 * a test that reaches past it is testing Postgres, not the library.
 */
export type Backend = {
  adapter: DatabaseAdapter;
  /** Creates whatever a plugin's declared tables need. DDL, or indexes. */
  applySchema: (schema: SchemaDeclaration) => Promise<void>;
  /** Empties every table, including ones plugins added. */
  truncate: () => Promise<void>;
  /** Raw read for assertions the public API cannot make. */
  rows: (table: string) => Promise<Record<string, unknown>[]>;
  /** Forces a delivery's attempt count past what the public API can reach. */
  setAttempts: (deliveryId: string, attempts: number) => Promise<void>;
  /** Only where a claim can block on another transaction's lock. */
  lockRow?: (deliveryId: string, fn: () => Promise<void>) => Promise<void>;
  end: () => Promise<void>;
};

export type BackendFactory = {
  name: string;
  /** Whether a claim can block on a lock another transaction holds. */
  rowLock: boolean;
  create: (namespace: string) => Promise<Backend>;
};

/** Builds the adapter under test from a live postgres.js client. */
type PostgresAdapterFactory = (client: ReturnType<typeof postgres>) => DatabaseAdapter;

async function createPostgresBackend(
  namespace: string,
  makeAdapter: PostgresAdapterFactory,
): Promise<Backend> {
  // Backend names carry hyphens ("postgres-raw"), which are a syntax error in
  // an unquoted identifier.
  const schema = `test_${namespace.replace(/\W/g, "_")}`;

  const bootstrap = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} });
  await bootstrap.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await bootstrap.unsafe(`CREATE SCHEMA ${schema}`);
  await bootstrap.end();

  const client = postgres(TEST_DATABASE_URL, {
    max: 8,
    onnotice: () => {},
    connection: { search_path: schema },
  });

  const applySchema = async (declaration: SchemaDeclaration) => {
    for (const statement of renderPostgresDdl(declaration)) await client.unsafe(statement);
  };

  await applySchema(coreSchema);

  return {
    adapter: makeAdapter(client),
    applySchema,
    truncate: async () => {
      // Discovered rather than listed: a plugin's tables must be cleared too,
      // and naming them here means every new plugin silently leaks fixtures.
      const tables = await client<{ tablename: string }[]>`
        SELECT tablename FROM pg_tables WHERE schemaname = ${schema}
      `;
      if (tables.length === 0) return;
      const names = tables.map((row) => `${schema}."${row.tablename}"`).join(", ");
      await client.unsafe(`TRUNCATE ${names} RESTART IDENTITY CASCADE`);
    },
    rows: async (table) =>
      (await client.unsafe(`SELECT * FROM ${schema}."${table}"`)) as unknown as Record<
        string,
        unknown
      >[],
    setAttempts: async (deliveryId, attempts) => {
      await client`UPDATE notification_delivery SET attempts = ${attempts} WHERE id = ${deliveryId}`;
    },
    lockRow: async (deliveryId, fn) => {
      // A separate connection: the lock must outlive the statement and be held
      // by someone the claim cannot be waiting on itself.
      const holder = postgres(TEST_DATABASE_URL, {
        max: 1,
        onnotice: () => {},
        connection: { search_path: schema },
      });
      try {
        await holder.begin(async (tx) => {
          await tx`SELECT id FROM notification_delivery WHERE id = ${deliveryId} FOR UPDATE`;
          await fn();
        });
      } finally {
        await holder.end();
      }
    },
    end: async () => {
      await client.end();
    },
  };
}

async function createMongoBackend(namespace: string): Promise<Backend> {
  const client = new MongoClient(TEST_MONGO_URL, { serverSelectionTimeoutMS: 5000 });
  await client.connect();

  const db = client.db(`easyping_test_${namespace.replace(/\W/g, "_")}`);
  await db.dropDatabase();
  await createMongoIndexes(db);

  return {
    adapter: mongoAdapter(db, { client }),
    applySchema: (declaration) => createPluginIndexes(db, declaration),
    truncate: async () => {
      const collections = await db.collections();
      for (const collection of collections) await collection.deleteMany({});
    },
    rows: async (table) => {
      const docs = await db.collection(table).find({}).toArray();
      return docs.map(({ _id, ...rest }) => ({ id: _id, ...rest }));
    },
    setAttempts: async (deliveryId, attempts) => {
      // Typed explicitly: our _id is a string, not the driver's default ObjectId.
      await db
        .collection<{ _id: string; attempts: number }>("notification_delivery")
        .updateOne({ _id: deliveryId }, { $set: { attempts } });
    },
    // No lockRow: a Mongo claim is one atomic findOneAndUpdate, so there is no
    // lock held across statements for a concurrent claimer to skip.
    end: async () => {
      await client.close();
    },
  };
}

/** Drizzle used purely as a SQL builder — the original adapter. */
const withDrizzle: PostgresAdapterFactory = (client) => drizzleAdapter(drizzle(client));

/**
 * The same database with no ORM at all: postgres.js's `unsafe(text, params)`
 * is exactly the `SqlQuery` contract, and `begin` supplies the transaction.
 * If this passes the same 13 cases as the Drizzle backend, the ORM genuinely
 * was not carrying any weight.
 */
const withRawSql: PostgresAdapterFactory = (client) =>
  postgresAdapter(
    async (text, params) =>
      (await client.unsafe(text, [...params] as never[])) as unknown as Record<string, unknown>[],
    {
      transaction: (fn) =>
        client.begin((tx) =>
          fn(
            async (text, params) =>
              (await tx.unsafe(text, [...params] as never[])) as unknown as Record<
                string,
                unknown
              >[],
          ),
        ) as never,
    },
  );

/**
 * The backends this machine can actually reach. Empty in CI is impossible —
 * both reachability probes throw there rather than quietly skipping.
 */
export const availableBackends: readonly BackendFactory[] = [
  ...((await postgresReachable())
    ? [
        {
          name: "postgres-drizzle",
          rowLock: true,
          create: (namespace: string) => createPostgresBackend(namespace, withDrizzle),
        },
        {
          name: "postgres-raw",
          rowLock: true,
          create: (namespace: string) => createPostgresBackend(namespace, withRawSql),
        },
      ]
    : []),
  ...((await mongoReachable())
    ? [{ name: "mongodb", rowLock: false, create: createMongoBackend }]
    : []),
];
