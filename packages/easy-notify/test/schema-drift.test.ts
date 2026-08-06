import { getTableColumns, getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createSchema } from "../src/adapters/drizzle/schema";
import { coreSchema, toSnakeCase } from "../src/schema/declaration";

// Drizzle's inferred table types cost ~10k type instantiations to introspect,
// for two fields this test actually reads. Erase them at the boundary.
type ColumnShape = { name: string; notNull: boolean };

const readColumns = getTableColumns as unknown as (table: object) => Record<string, ColumnShape>;
const readTableName = getTableName as unknown as (table: object) => string;

const drizzle: Record<string, object> = createSchema();

const lookup = (key: string): object => {
  const table = drizzle[key];
  if (!table) throw new Error(`no Drizzle table for ${key}`);
  return table;
};

const PAIRS: readonly (readonly [keyof typeof coreSchema, object])[] = [
  ["notification", lookup("notification")],
  ["notificationDelivery", lookup("notificationDelivery")],
  ["notificationPreference", lookup("notificationPreference")],
];

describe.each(PAIRS)("%s stays in sync with its declaration", (key, table) => {
  const declaration = coreSchema[key];
  const byDbName = new Map(Object.values(readColumns(table)).map((c) => [c.name, c]));

  it("agrees on the table name", () => {
    expect(readTableName(table)).toBe(declaration.tableName);
  });

  it("declares every column the Drizzle table has", () => {
    const declared = new Set(Object.keys(declaration.fields).map(toSnakeCase));
    expect([...byDbName.keys()].filter((name) => !declared.has(name))).toEqual([]);
  });

  it.each(Object.entries(declaration.fields))("has column %s", (field, spec) => {
    const column = byDbName.get(toSnakeCase(field));
    expect(column, `missing column ${toSnakeCase(field)}`).toBeDefined();

    const isSinglePk = declaration.primaryKey?.length === 1 && declaration.primaryKey[0] === field;
    expect(column?.notNull).toBe(Boolean(spec.required) || isSinglePk);
  });
});
