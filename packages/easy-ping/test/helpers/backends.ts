import type * as NodeSqlite from "node:sqlite";
import { drizzle } from "drizzle-orm/postgres-js";
import { MongoClient } from "mongodb";
import mysql from "mysql2/promise";
import postgres from "postgres";
import { drizzleAdapter } from "../../src/adapters/drizzle/adapter";
import { mongoAdapter } from "../../src/adapters/mongodb/adapter";
import { createMongoIndexes, createPluginIndexes } from "../../src/adapters/mongodb/indexes";
import { mysqlAdapter } from "../../src/adapters/mysql/adapter";
import { mysql2Query, mysqlTransaction } from "../../src/adapters/mysql/helpers";
import { postgresAdapter } from "../../src/adapters/postgres/adapter";
import { sqliteAdapter } from "../../src/adapters/sqlite/adapter";
import { sqliteQuery, sqliteTransaction } from "../../src/adapters/sqlite/helpers";
import type { DatabaseAdapter } from "../../src/core/adapter";
import type { SchemaDeclaration } from "../../src/core/plugin";
import { coreSchema } from "../../src/schema/declaration";
import { renderMysqlDdl } from "../../src/schema/render-mysql";
import { renderPostgresDdl } from "../../src/schema/render-sql";
import { renderSqliteDdl } from "../../src/schema/render-sqlite";
import { mongoReachable, TEST_MONGO_URL } from "./mongo";
import { mysqlReachable, TEST_MYSQL_URL } from "./mysql";
import { postgresReachable, TEST_DATABASE_URL } from "./pg";

/** One database-shaped surface so a behaviour test runs against every adapter. */
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

const safeName = (namespace: string) => `test_${namespace.replace(/\W/g, "_")}`;

// node:sqlite announces itself as experimental once per process. That is
// known; the suite output should show test results, not four copies of it.
const defaultPrinters = process.listeners("warning");
process.removeAllListeners("warning");
process.on("warning", (warning) => {
  if (warning.name === "ExperimentalWarning" && /SQLite/.test(warning.message)) return;
  for (const printer of defaultPrinters) printer.call(process, warning);
});

// Not an import: vite-node's builtin list predates node:sqlite and would try
// to resolve it from node_modules. getBuiltinModule bypasses the module graph.
const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as typeof NodeSqlite;

/** Builds the adapter under test from a live postgres.js client. */
type PostgresAdapterFactory = (client: ReturnType<typeof postgres>) => DatabaseAdapter;

async function createPostgresBackend(
  namespace: string,
  makeAdapter: PostgresAdapterFactory,
): Promise<Backend> {
  // Backend names carry hyphens ("postgres-raw"), which are a syntax error in
  // an unquoted identifier.
  const schema = safeName(namespace);

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

  const db = client.db(`easyping_${safeName(namespace)}`);
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

/** MySQL, one database per namespace; `transactional` selects the SKIP LOCKED claim path. */
async function createMysqlBackend(namespace: string, transactional: boolean): Promise<Backend> {
  const database = safeName(namespace);

  const admin = await mysql.createConnection({ uri: TEST_MYSQL_URL });
  await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
  await admin.query(`CREATE DATABASE \`${database}\``);
  await admin.end();

  const url = new URL(TEST_MYSQL_URL);
  url.pathname = `/${database}`;
  // timezone "Z": the adapter writes DATETIME as UTC and must read it back unshifted.
  const pool = mysql.createPool({ uri: url.toString(), timezone: "Z", connectionLimit: 8 });
  const exec = mysql2Query(pool);

  const applySchema = async (declaration: SchemaDeclaration) => {
    for (const statement of renderMysqlDdl(declaration)) await exec(statement, []);
  };
  await applySchema(coreSchema);

  return {
    adapter: mysqlAdapter(exec, transactional ? { transaction: mysqlTransaction(pool) } : {}),
    applySchema,
    truncate: async () => {
      const { rows } = await exec(
        "SELECT table_name AS t FROM information_schema.tables WHERE table_schema = ?",
        [database],
      );
      for (const row of rows) await exec(`TRUNCATE TABLE \`${String(row.t)}\``, []);
    },
    rows: async (table) => [...(await exec(`SELECT * FROM \`${table}\``, [])).rows],
    setAttempts: async (deliveryId, attempts) => {
      await exec("UPDATE notification_delivery SET attempts = ? WHERE id = ?", [
        attempts,
        deliveryId,
      ]);
    },
    ...(transactional
      ? {
          lockRow: async (deliveryId: string, fn: () => Promise<void>) => {
            const holder = await mysql.createConnection({ uri: url.toString(), timezone: "Z" });
            try {
              await holder.beginTransaction();
              await holder.query("SELECT id FROM notification_delivery WHERE id = ? FOR UPDATE", [
                deliveryId,
              ]);
              await fn();
              await holder.commit();
            } finally {
              await holder.end();
            }
          },
        }
      : {}),
    end: async () => {
      await pool.end();
    },
  };
}

/** SQLite in memory, through Node's own driver. One writer, so no lockRow. */
async function createSqliteBackend(): Promise<Backend> {
  const db = new DatabaseSync(":memory:");
  const exec = sqliteQuery(db);

  const applySchema = async (declaration: SchemaDeclaration) => {
    for (const statement of renderSqliteDdl(declaration)) await exec(statement, []);
  };
  await applySchema(coreSchema);

  return {
    adapter: sqliteAdapter(exec, { transaction: sqliteTransaction(db) }),
    applySchema,
    truncate: async () => {
      const { rows } = await exec(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
        [],
      );
      for (const row of rows) await exec(`DELETE FROM "${String(row.name)}"`, []);
    },
    rows: async (table) => [...(await exec(`SELECT * FROM "${table}"`, [])).rows],
    setAttempts: async (deliveryId, attempts) => {
      await exec("UPDATE notification_delivery SET attempts = ? WHERE id = ?", [
        attempts,
        deliveryId,
      ]);
    },
    end: async () => {
      db.close();
    },
  };
}

/** Drizzle used purely as a SQL builder — the original adapter. */
const withDrizzle: PostgresAdapterFactory = (client) => drizzleAdapter(drizzle(client));

/** The same database with no ORM: postgres.js `unsafe` is exactly the SqlQuery contract. */
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

/** The backends this machine can reach. Probes throw in CI rather than skip; SQLite is always present. */
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
  ...((await mysqlReachable())
    ? [
        {
          name: "mysql",
          rowLock: true,
          create: (namespace: string) => createMysqlBackend(namespace, true),
        },
        {
          name: "mysql-lockfree",
          rowLock: false,
          create: (namespace: string) => createMysqlBackend(namespace, false),
        },
      ]
    : []),
  { name: "sqlite", rowLock: false, create: () => createSqliteBackend() },
];
