import mysql from "mysql2/promise";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mysql2Query } from "../src/adapters/mysql/helpers";
import type { SchemaDeclaration } from "../src/core/plugin";
import { digests } from "../src/plugins/digests";
import { mobilePushSchema } from "../src/plugins/mobile-push";
import { preferences } from "../src/plugins/preferences";
import { pushSchema } from "../src/plugins/push";
import { telegramSchema } from "../src/plugins/telegram";
import { coreSchema } from "../src/schema/declaration";
import { planMysqlMigration } from "../src/schema/migrate-mysql";
import { mysqlReachable, TEST_MYSQL_URL } from "./helpers/mysql";

const available = await mysqlReachable();
const DATABASE = "test_migrate_mysql";

let pool: mysql.Pool;
let query: ReturnType<typeof mysql2Query>;

const apply = async (statements: readonly string[]) => {
  for (const statement of statements) await query(statement, []);
};
const rows = async (sql: string) => (await query(sql, [])).rows as Record<string, unknown>[];

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

describe.skipIf(!available)("planMysqlMigration", () => {
  beforeAll(async () => {
    const url = new URL(TEST_MYSQL_URL);
    url.pathname = `/${DATABASE}`;
    const admin = await mysql.createConnection({ uri: TEST_MYSQL_URL });
    await admin.query(`CREATE DATABASE IF NOT EXISTS \`${DATABASE}\``);
    await admin.end();
    pool = mysql.createPool({ uri: url.toString(), timezone: "Z", connectionLimit: 2 });
    query = mysql2Query(pool);
  });

  beforeEach(async () => {
    const tables = await rows(
      `SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()`,
    );
    for (const { t } of tables) await query(`DROP TABLE \`${String(t)}\``, []);
  });

  afterAll(async () => {
    await pool?.query(`DROP DATABASE IF EXISTS \`${DATABASE}\``);
    await pool?.end();
  });

  it("creates every table of an empty database, and a second plan is empty", async () => {
    for (const schema of ALL) {
      const plan = await planMysqlMigration(query, schema);
      expect(plan.unsupported).toEqual([]);
      await apply(plan.statements);
    }
    for (const schema of ALL) {
      expect(await planMysqlMigration(query, schema)).toEqual({
        statements: [],
        unsupported: [],
        createdTables: [],
      });
    }
  });

  it("upgrades a populated table: columns with defaults, a nullable fallback, new indexes", async () => {
    await apply((await planMysqlMigration(query, V1)).statements);
    await apply([
      "INSERT INTO widget (id, user_id) VALUES ('w1', 'u1')",
      "INSERT INTO widget (id, user_id) VALUES ('w2', 'u2')",
    ]);

    const plan = await planMysqlMigration(query, V2);
    expect(plan.createdTables).toEqual([]);
    expect(plan.unsupported).toEqual([
      expect.stringContaining("widget.owner is declared required"),
    ]);
    expect(plan.statements.filter((s) => s.startsWith("CREATE"))).toEqual([
      "CREATE INDEX `widget_status_idx` ON `widget` (`status`, `created_at`)",
    ]);
    await apply(plan.statements);

    const after = await rows("SELECT * FROM widget ORDER BY id");
    expect(after).toHaveLength(2);
    expect(after[0]).toMatchObject({ id: "w1", status: "active", pinned: 0, owner: null });
    expect(after[0]?.created_at).toBeInstanceOf(Date);

    await apply(["INSERT INTO widget (id, user_id) VALUES ('w3', 'u3')"]);
    expect(
      (await rows("SELECT created_at FROM widget WHERE id = 'w3'"))[0]?.created_at,
    ).toBeInstanceOf(Date);

    expect(await planMysqlMigration(query, V2)).toMatchObject({ statements: [] });
  });

  it("reports type mismatches, TEXT columns an index cannot use, and undeclared columns", async () => {
    await apply(["CREATE TABLE widget (id VARCHAR(768) PRIMARY KEY, user_id TEXT, legacy INT)"]);
    const typed = {
      widget: {
        ...V1.widget,
        fields: { ...V1.widget.fields, id: { type: "number", required: true } },
      },
    } satisfies SchemaDeclaration;
    const plan = await planMysqlMigration(query, typed);
    expect(plan.unsupported).toEqual(
      expect.arrayContaining([
        expect.stringContaining("widget.id is varchar but number"),
        expect.stringContaining("index widget_user_idx needs user_id as VARCHAR"),
        expect.stringContaining("widget.legacy exists but is not declared"),
      ]),
    );
    expect(plan.statements.some((s) => s.includes("widget_user_idx"))).toBe(false);
  });

  it("honours the table prefix", async () => {
    await apply((await planMysqlMigration(query, V1, "app_")).statements);
    const plan = await planMysqlMigration(query, V2, "app_");
    await apply(plan.statements);
    const indexes = await rows(
      "SELECT DISTINCT INDEX_NAME AS i FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'app_widget'",
    );
    expect(indexes.map((r) => r.i).sort()).toEqual([
      "PRIMARY",
      "app_widget_status_idx",
      "app_widget_user_idx",
    ]);
    expect(await planMysqlMigration(query, V2, "app_")).toMatchObject({ statements: [] });
  });
});
