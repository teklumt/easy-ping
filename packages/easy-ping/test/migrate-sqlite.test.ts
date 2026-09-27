import type * as NodeSqlite from "node:sqlite";
import { describe, expect, it } from "vitest";
import { sqliteQuery } from "../src/adapters/sqlite/helpers";
import type { SchemaDeclaration } from "../src/core/plugin";
import { digests } from "../src/plugins/digests";
import { mobilePushSchema } from "../src/plugins/mobile-push";
import { preferences } from "../src/plugins/preferences";
import { pushSchema } from "../src/plugins/push";
import { telegramSchema } from "../src/plugins/telegram";
import { coreSchema } from "../src/schema/declaration";
import { planSqliteMigration } from "../src/schema/migrate-sqlite";

const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as typeof NodeSqlite;

function open() {
  const db = new DatabaseSync(":memory:");
  const query = sqliteQuery(db);
  const apply = async (statements: readonly string[]) => {
    db.exec("BEGIN");
    try {
      for (const statement of statements) db.exec(statement);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };
  const rows = (sql: string) => db.prepare(sql).all() as Record<string, unknown>[];
  return { db, query, apply, rows };
}

const V1 = {
  widget: {
    tableName: "widget",
    fields: {
      id: { type: "string", required: true },
      userId: { type: "string", required: true },
    },
    primaryKey: ["id"],
    indexes: [{ on: ["userId"], name: "widget_user_idx" }],
  },
} satisfies SchemaDeclaration;

const V2 = {
  widget: {
    tableName: "widget",
    fields: {
      id: { type: "string", required: true },
      userId: { type: "string", required: true },
      status: { type: "string", required: true, default: "active" },
      score: { type: "number" },
      pinned: { type: "boolean", required: true, default: false },
      createdAt: { type: "date", required: true, defaultNow: true },
      owner: { type: "string", required: true },
    },
    primaryKey: ["id"],
    indexes: [
      { on: ["userId"], name: "widget_user_idx" },
      { on: ["status", "createdAt"], name: "widget_status_idx" },
    ],
  },
} satisfies SchemaDeclaration;

const ALL = [
  coreSchema,
  pushSchema,
  telegramSchema,
  mobilePushSchema,
  preferences().schema ?? {},
  digests().schema ?? {},
];

describe("planSqliteMigration", () => {
  it("creates every table of an empty database, and a second plan changes nothing", async () => {
    const { query, apply, rows } = open();
    for (const schema of ALL) {
      const plan = await planSqliteMigration(query, schema);
      expect(plan.unsupported).toEqual([]);
      await apply(plan.statements);
    }
    const tables = rows("SELECT name FROM sqlite_master WHERE type = 'table'").map((r) => r.name);
    expect(tables).toEqual(expect.arrayContaining(["notification", "notification_push_device"]));

    for (const schema of ALL) {
      const again = await planSqliteMigration(query, schema);
      expect(again.createdTables).toEqual([]);
      expect(again.unsupported).toEqual([]);
      // Only idempotent index re-issues remain.
      expect(
        again.statements.every((s) => s.startsWith("CREATE") && s.includes("IF NOT EXISTS")),
      ).toBe(true);
      expect(again.statements.some((s) => s.includes("ALTER") || s.includes("TABLE"))).toBe(false);
    }
  });

  it("upgrades a populated table: rebuilds for a timestamp column, keeps every row", async () => {
    const { query, apply, rows } = open();
    await apply((await planSqliteMigration(query, V1)).statements);
    await apply([
      `INSERT INTO widget (id, user_id) VALUES ('w1', 'u1')`,
      `INSERT INTO widget (id, user_id) VALUES ('w2', 'u2')`,
    ]);

    const plan = await planSqliteMigration(query, V2);
    expect(plan.createdTables).toEqual([]);
    expect(plan.statements.some((s) => s.includes("RENAME TO"))).toBe(true);
    expect(plan.unsupported).toEqual([
      expect.stringContaining("widget.owner is declared required"),
    ]);
    await apply(plan.statements);

    const after = rows("SELECT * FROM widget ORDER BY id");
    expect(after).toHaveLength(2);
    expect(after[0]).toMatchObject({
      id: "w1",
      user_id: "u1",
      status: "active",
      pinned: 0,
      owner: null,
    });
    expect(String(after[0]?.created_at)).toMatch(/^\d{4}-\d\d-\d\dT.*Z$/);

    // The default applies to new rows too, which a plain ADD COLUMN could not have given.
    await apply([`INSERT INTO widget (id, user_id) VALUES ('w3', 'u3')`]);
    expect(rows("SELECT created_at FROM widget WHERE id = 'w3'")[0]?.created_at).toBeTruthy();

    const indexes = rows("SELECT name FROM sqlite_master WHERE type = 'index'").map((r) => r.name);
    expect(indexes).toEqual(expect.arrayContaining(["widget_user_idx", "widget_status_idx"]));
    expect(rows("SELECT name FROM sqlite_master WHERE name LIKE '%rebuild%'")).toEqual([]);
  });

  it("adds constant-default columns in place, without a rebuild", async () => {
    const { query, apply, rows } = open();
    await apply((await planSqliteMigration(query, V1)).statements);
    await apply([`INSERT INTO widget (id, user_id) VALUES ('w1', 'u1')`]);

    const noTimestamp = {
      widget: { ...V1.widget, fields: { ...V1.widget.fields, status: V2.widget.fields.status } },
    } satisfies SchemaDeclaration;
    const plan = await planSqliteMigration(query, noTimestamp);
    expect(plan.statements.some((s) => s.includes("RENAME TO"))).toBe(false);
    expect(plan.statements).toContainEqual(
      expect.stringMatching(/ALTER TABLE "widget" ADD COLUMN "status"/),
    );
    await apply(plan.statements);
    expect(rows("SELECT status FROM widget")[0]?.status).toBe("active");
  });

  it("reports type mismatches and undeclared columns instead of touching them", async () => {
    const { query, apply } = open();
    await apply([`CREATE TABLE widget (id TEXT PRIMARY KEY, user_id INTEGER, legacy TEXT)`]);
    const plan = await planSqliteMigration(query, V1);
    expect(plan.unsupported).toEqual(
      expect.arrayContaining([
        expect.stringContaining("widget.user_id is INTEGER but TEXT"),
        expect.stringContaining("widget.legacy exists but is not declared"),
      ]),
    );
  });

  it("honours the table prefix", async () => {
    const { query, apply, rows } = open();
    await apply((await planSqliteMigration(query, V1, "app_")).statements);
    const plan = await planSqliteMigration(query, V2, "app_");
    await apply(plan.statements);
    const tables = rows("SELECT name FROM sqlite_master WHERE type = 'table'").map((r) => r.name);
    expect(tables).toEqual(["app_widget"]);
    const indexes = rows(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%'",
    );
    expect(indexes.map((r) => r.name).sort()).toEqual([
      "app_widget_status_idx",
      "app_widget_user_idx",
    ]);
  });
});
