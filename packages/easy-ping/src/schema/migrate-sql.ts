import type { FieldDeclaration, SchemaDeclaration, TableDeclaration } from "../core/plugin";
import { toSnakeCase } from "./declaration";
import { renderPostgresDdl } from "./render-sql";

/** Introspects a live Postgres schema and emits only what is missing. Additive only: drops and type changes land in `unsupported`. */

const SQL_TYPE: Record<FieldDeclaration["type"], string> = {
  string: "text",
  number: "integer",
  boolean: "boolean",
  date: "timestamptz",
  json: "jsonb",
};

/** What information_schema reports for each of our declared types. */
const LIVE_TYPE: Record<FieldDeclaration["type"], readonly string[]> = {
  string: ["text", "character varying", "character"],
  number: ["integer", "bigint", "smallint"],
  boolean: ["boolean"],
  date: ["timestamp with time zone", "timestamp without time zone"],
  json: ["jsonb", "json"],
};

const quote = (value: string) => `"${value.replace(/"/g, '""')}"`;

const defaultClause = (field: FieldDeclaration): string => {
  if (field.defaultNow) return " DEFAULT now()";
  if (field.default === undefined) return "";
  if (typeof field.default === "string") return ` DEFAULT '${field.default.replace(/'/g, "''")}'`;
  return ` DEFAULT ${field.default}`;
};

const indexName = (
  table: TableDeclaration,
  declaration: { on: readonly string[]; name?: string },
) => declaration.name ?? `${table.tableName}_${declaration.on.join("_")}_idx`;

export type LiveColumn = { table: string; column: string; type: string; nullable: boolean };

/** A row as INTROSPECT_SQL returns it; `LiveColumn` uses the short forms and both are accepted. */
export type LiveColumnRow =
  | LiveColumn
  | {
      table_name: string;
      column_name: string;
      data_type: string;
      is_nullable: string | boolean;
    };

/** Accepts either shape, so raw rows and hand-mapped rows both work. */
function normaliseColumn(row: LiveColumnRow): LiveColumn {
  if ("table" in row) return row;
  return {
    table: String(row.table_name),
    column: String(row.column_name),
    type: String(row.data_type),
    nullable: typeof row.is_nullable === "boolean" ? row.is_nullable : row.is_nullable === "YES",
  };
}

export type MigrationPlan = {
  /** Run in order. Empty means the live schema already matches. */
  statements: readonly string[];
  /** Differences this cannot express safely. Read them; they need a human. */
  unsupported: readonly string[];
  /** Tables that do not exist yet — these get a full CREATE TABLE. */
  createdTables: readonly string[];
};

/** Reads the live column list; a function, so this module stays driver-agnostic. */
export type Introspector = () => Promise<readonly LiveColumnRow[]>;

/** The query an Introspector should run; raw rows are accepted as they come back. */
export const INTROSPECT_SQL = `
  SELECT table_name, column_name, data_type, is_nullable
  FROM information_schema.columns
  WHERE table_schema = current_schema()
`;

export async function planPostgresMigration(
  introspect: Introspector,
  schema: SchemaDeclaration,
  prefix = "",
): Promise<MigrationPlan> {
  const live = await introspect();

  const byTable = new Map<string, Map<string, LiveColumn>>();
  for (const row of live) {
    const column = normaliseColumn(row);
    const columns = byTable.get(column.table) ?? new Map<string, LiveColumn>();
    columns.set(column.column, column);
    byTable.set(column.table, columns);
  }

  const statements: string[] = [];
  const unsupported: string[] = [];
  const createdTables: string[] = [];

  for (const table of Object.values(schema)) {
    const qualified = prefix + table.tableName;
    const existing = byTable.get(qualified);

    // Absent entirely: the ordinary bootstrap path still applies.
    if (!existing || existing.size === 0) {
      createdTables.push(qualified);
      statements.push(...renderPostgresDdl({ [table.tableName]: table }, prefix));
      continue;
    }

    for (const [field, spec] of Object.entries(table.fields)) {
      const column = toSnakeCase(field);
      const found = existing.get(column);

      if (!found) {
        // NOT NULL fails on a populated table without a default: added nullable and flagged.
        const canFill = spec.defaultNow || spec.default !== undefined;
        const nullability = spec.required && canFill ? " NOT NULL" : "";

        statements.push(
          `ALTER TABLE ${quote(qualified)} ADD COLUMN IF NOT EXISTS ` +
            `${quote(column)} ${SQL_TYPE[spec.type]}${nullability}${defaultClause(spec)}`,
        );

        if (spec.required && !canFill) {
          unsupported.push(
            `${qualified}.${column} is declared required but has no default; ` +
              "it was added nullable. Backfill it, then ALTER ... SET NOT NULL yourself.",
          );
        }
        continue;
      }

      if (!LIVE_TYPE[spec.type].includes(found.type)) {
        unsupported.push(
          `${qualified}.${column} is ${found.type} but ${spec.type} is declared ` +
            `(${SQL_TYPE[spec.type]}). Changing a column type can lose data — do it yourself.`,
        );
      }
    }

    // Indexes are cheap and idempotent, so they are re-issued unconditionally.
    for (const declaration of table.indexes ?? []) {
      const name = quote(prefix + indexName(table, declaration));
      const columns = declaration.on.map((field) => quote(toSnakeCase(field))).join(", ");
      statements.push(
        `CREATE ${declaration.unique ? "UNIQUE " : ""}INDEX IF NOT EXISTS ${name} ` +
          `ON ${quote(qualified)} (${columns})`,
      );
    }

    for (const column of existing.keys()) {
      const declared = Object.keys(table.fields).some((field) => toSnakeCase(field) === column);
      if (!declared) {
        unsupported.push(
          `${qualified}.${column} exists but is not declared. Left alone — ` +
            "drop it yourself if it is ours and no longer needed.",
        );
      }
    }
  }

  return { statements, unsupported, createdTables };
}
