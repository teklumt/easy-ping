import type { SqlExec } from "../adapters/sql/dialect";
import type { FieldDeclaration, SchemaDeclaration, TableDeclaration } from "../core/plugin";
import { toSnakeCase } from "./declaration";
import type { MigrationPlan } from "./migrate-sql";
import { mysqlColumnDefinition, renderMysqlDdl } from "./render-mysql";

/** Columns of every table in the connection's current database. */
export const MYSQL_INTROSPECT_COLUMNS_SQL = `
  SELECT TABLE_NAME AS table_name, COLUMN_NAME AS column_name, DATA_TYPE AS data_type
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
`;

/** Index names, because MySQL has no CREATE INDEX IF NOT EXISTS. */
export const MYSQL_INTROSPECT_INDEXES_SQL = `
  SELECT DISTINCT TABLE_NAME AS table_name, INDEX_NAME AS index_name
  FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
`;

/** What information_schema reports for each declared type. MariaDB reports JSON as longtext. */
const LIVE_TYPE: Record<FieldDeclaration["type"], readonly string[]> = {
  string: ["varchar", "char", "text", "tinytext", "mediumtext", "longtext"],
  number: ["int", "integer", "bigint", "smallint", "mediumint", "tinyint"],
  boolean: ["tinyint", "bit", "boolean"],
  date: ["datetime", "timestamp"],
  json: ["json", "longtext"],
};

const quote = (value: string) => `\`${value.split("`").join("``")}\``;

const indexName = (
  table: TableDeclaration,
  declaration: { on: readonly string[]; name?: string },
) => declaration.name ?? `${table.tableName}_${declaration.on.join("_")}_idx`;

const lower = (value: unknown) => String(value).toLowerCase();

/**
 * Diffs a live MySQL/MariaDB database against a declaration and emits only what
 * is missing: tables, columns, indexes. Additive only; anything that would need
 * a type change or a drop lands in `unsupported` for a human.
 */
export async function planMysqlMigration(
  query: SqlExec,
  schema: SchemaDeclaration,
  prefix = "",
): Promise<MigrationPlan> {
  const [columnRows, indexRows] = await Promise.all([
    query(MYSQL_INTROSPECT_COLUMNS_SQL, []),
    query(MYSQL_INTROSPECT_INDEXES_SQL, []),
  ]);

  const columns = new Map<string, Map<string, string>>();
  for (const row of columnRows.rows) {
    const table = lower(row.table_name ?? row.TABLE_NAME);
    const byColumn = columns.get(table) ?? new Map<string, string>();
    byColumn.set(lower(row.column_name ?? row.COLUMN_NAME), lower(row.data_type ?? row.DATA_TYPE));
    columns.set(table, byColumn);
  }
  const indexes = new Set(
    indexRows.rows.map(
      (row) =>
        `${lower(row.table_name ?? row.TABLE_NAME)}.${lower(row.index_name ?? row.INDEX_NAME)}`,
    ),
  );

  const statements: string[] = [];
  const unsupported: string[] = [];
  const createdTables: string[] = [];

  for (const table of Object.values(schema)) {
    const qualified = prefix + table.tableName;
    const existing = columns.get(qualified.toLowerCase());

    if (!existing || existing.size === 0) {
      createdTables.push(qualified);
      statements.push(...renderMysqlDdl({ [table.tableName]: table }, prefix));
      continue;
    }

    for (const [field, spec] of Object.entries(table.fields)) {
      const column = toSnakeCase(field);
      const found = existing.get(column.toLowerCase());

      if (found === undefined) {
        const canFill = spec.defaultNow || spec.default !== undefined;
        const definition = mysqlColumnDefinition(field, table, {
          ...spec,
          // A required column with nothing to fill existing rows with is added nullable.
          required: Boolean(spec.required && canFill),
        });
        statements.push(`ALTER TABLE ${quote(qualified)} ADD COLUMN ${definition}`);
        if (spec.required && !canFill) {
          unsupported.push(
            `${qualified}.${column} is declared required but has no default; it was added ` +
              "nullable. Backfill it, then ALTER TABLE ... MODIFY ... NOT NULL yourself.",
          );
        }
        continue;
      }

      if (!LIVE_TYPE[spec.type].includes(found)) {
        unsupported.push(
          `${qualified}.${column} is ${found} but ${spec.type} is declared. ` +
            "Changing a column type can lose data — do it yourself.",
        );
      }
    }

    for (const declaration of table.indexes ?? []) {
      const name = prefix + indexName(table, declaration);
      if (indexes.has(`${qualified.toLowerCase()}.${name.toLowerCase()}`)) continue;

      const textColumn = declaration.on.find((field) => {
        const live = existing.get(toSnakeCase(field).toLowerCase());
        return live?.endsWith("text") ?? false;
      });
      if (textColumn) {
        unsupported.push(
          `${qualified}: index ${name} needs ${toSnakeCase(textColumn)} as VARCHAR, but it is TEXT, ` +
            "which MySQL cannot index without a prefix length. Change the column type, then rerun.",
        );
        continue;
      }

      const cols = declaration.on.map((field) => quote(toSnakeCase(field))).join(", ");
      statements.push(
        `CREATE ${declaration.unique ? "UNIQUE " : ""}INDEX ${quote(name)} ON ${quote(qualified)} (${cols})`,
      );
    }

    for (const column of existing.keys()) {
      const declared = Object.keys(table.fields).some(
        (field) => toSnakeCase(field).toLowerCase() === column,
      );
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
