import postgres from "postgres";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { SchemaDeclaration } from "../src/core/plugin";
import { INTROSPECT_SQL, planPostgresMigration } from "../src/schema/migrate-sql";
import { renderPostgresDdl } from "../src/schema/render-sql";
import { postgresReachable, TEST_DATABASE_URL } from "./helpers/pg";

/**
 * The upgrade path for anyone who bootstrapped with raw SQL.
 *
 * renderPostgresDdl is CREATE TABLE IF NOT EXISTS, so on an existing database
 * it does nothing at all. A version that adds a column used to leave those
 * adopters with a table that silently lacked it.
 */

const available = await postgresReachable();
const SCHEMA = "test_migrate";

const client = available
  ? postgres(TEST_DATABASE_URL, {
      max: 2,
      onnotice: () => {},
      connection: { search_path: SCHEMA },
    })
  : null;

/** The describe below is skipped when this is null; the throw documents that. */
const db = () => {
  if (!client) throw new Error("postgres is unreachable — this suite should have been skipped");
  return client;
};

const introspect = async () => {
  const rows = await db().unsafe(INTROSPECT_SQL);
  return rows.map((row) => ({
    table: String(row.table_name),
    column: String(row.column_name),
    type: String(row.data_type),
    nullable: row.is_nullable === "YES",
  }));
};

const V1 = {
  widget: {
    tableName: "widget",
    fields: {
      id: { type: "string", required: true },
      userId: { type: "string", required: true },
    },
    primaryKey: ["id"],
  },
} satisfies SchemaDeclaration;

describe.skipIf(!available)("planPostgresMigration", () => {
  beforeEach(async () => {
    await db().unsafe(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await db().unsafe(`CREATE SCHEMA ${SCHEMA}`);
  });

  afterAll(async () => {
    await client?.unsafe(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await client?.end();
  });

  const apply = async (plan: { statements: readonly string[] }) => {
    for (const statement of plan.statements) await db().unsafe(statement);
  };

  it("creates a table that does not exist yet", async () => {
    const plan = await planPostgresMigration(introspect, V1);

    expect(plan.createdTables).toEqual(["widget"]);
    await apply(plan);

    const after = await planPostgresMigration(introspect, V1);
    expect(after.createdTables).toEqual([]);
    expect(after.statements.every((s) => s.startsWith("CREATE"))).toBe(true);
  });

  it("adds a column a later version introduced — the case DDL silently skipped", async () => {
    for (const statement of renderPostgresDdl(V1)) await db().unsafe(statement);
    await db().unsafe(`INSERT INTO widget (id, user_id) VALUES ('w1', 'u1')`);

    const V2 = {
      widget: {
        ...V1.widget,
        fields: {
          ...V1.widget.fields,
          archivedAt: { type: "date" },
          hits: { type: "number", required: true, default: 0 },
        },
        indexes: [{ on: ["userId"], name: "widget_user_idx" }],
      },
    } satisfies SchemaDeclaration;

    // The old path is a no-op on an existing table; that is the bug.
    for (const statement of renderPostgresDdl(V2)) await db().unsafe(statement);
    const stillMissing = await introspect();
    expect(stillMissing.some((c) => c.column === "archived_at")).toBe(false);

    await apply(await planPostgresMigration(introspect, V2));

    const columns = await introspect();
    expect(columns.some((c) => c.column === "archived_at")).toBe(true);
    expect(columns.some((c) => c.column === "hits")).toBe(true);

    // The existing row survived and picked up the default.
    const [row] = await db().unsafe(`SELECT id, hits FROM widget`);
    expect(row?.hits).toBe(0);

    const indexes = await db().unsafe(
      `SELECT indexname FROM pg_indexes WHERE schemaname = '${SCHEMA}'`,
    );
    expect(indexes.some((i) => i.indexname === "widget_user_idx")).toBe(true);
  });

  it("is idempotent — a second run emits nothing that changes anything", async () => {
    await apply(await planPostgresMigration(introspect, V1));
    const second = await planPostgresMigration(introspect, V1);

    await apply(second);
    expect(second.statements.some((s) => s.includes("ADD COLUMN"))).toBe(false);
  });

  it("adds a required column without a default as nullable, and says so", async () => {
    for (const statement of renderPostgresDdl(V1)) await db().unsafe(statement);
    await db().unsafe(`INSERT INTO widget (id, user_id) VALUES ('w1', 'u1')`);

    const V2 = {
      widget: {
        ...V1.widget,
        fields: { ...V1.widget.fields, label: { type: "string", required: true } },
      },
    } satisfies SchemaDeclaration;

    const plan = await planPostgresMigration(introspect, V2);
    expect(plan.unsupported.some((w) => w.includes("label") && w.includes("nullable"))).toBe(true);

    // NOT NULL here would abort against the existing row.
    await apply(plan);
    expect((await introspect()).some((c) => c.column === "label")).toBe(true);
  });

  it("reports a type change instead of guessing at it", async () => {
    for (const statement of renderPostgresDdl(V1)) await db().unsafe(statement);

    const V2 = {
      widget: {
        ...V1.widget,
        fields: { ...V1.widget.fields, userId: { type: "number", required: true } },
      },
    } satisfies SchemaDeclaration;

    const plan = await planPostgresMigration(introspect, V2);
    expect(plan.statements.some((s) => s.includes("user_id"))).toBe(false);
    expect(plan.unsupported.some((w) => w.includes("user_id") && w.includes("text"))).toBe(true);
  });

  it("leaves an undeclared column alone and flags it", async () => {
    for (const statement of renderPostgresDdl(V1)) await db().unsafe(statement);
    await db().unsafe(`ALTER TABLE widget ADD COLUMN mine text`);

    const plan = await planPostgresMigration(introspect, V1);
    expect(plan.statements.some((s) => s.includes("mine"))).toBe(false);
    expect(plan.unsupported.some((w) => w.includes("mine"))).toBe(true);
  });
});
