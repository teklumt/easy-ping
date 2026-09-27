import type { SqlExec } from "../adapters/sql/dialect";
import type { SchemaDeclaration, TableDeclaration } from "../core/plugin";
import { toSnakeCase } from "./declaration";
import type { MigrationPlan } from "./migrate-sql";
import { renderSqliteDdl, SQLITE_TYPE, sqliteColumnDefinition } from "./render-sqlite";

/** Every column of every table. pragma_table_info needs SQLite 3.16+; node:sqlite and better-sqlite3 ship newer. */
export const SQLITE_INTROSPECT_SQL = `
  SELECT m.name AS table_name, p.name AS column_name, p.type AS data_type
  FROM sqlite_master AS m
  JOIN pragma_table_info(m.name) AS p
  WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%'
`;

const quote = (value: string) => `"${value.split('"').join('""')}"`;

const REBUILD_SUFFIX = "__easy_ping_rebuild";

/**
 * Diffs a live SQLite database against a declaration and emits only what is
 * missing. Run the statements inside one transaction.
 *
 * SQLite cannot ALTER TABLE ... ADD COLUMN with a non-constant default, which
 * every timestamp column has, so a table missing such a column is rebuilt: a
 * copy with the new shape, the rows moved across, the copy swapped in, the
 * indexes recreated. Everything else is a plain ADD COLUMN.
 */
export async function planSqliteMigration(
  query: SqlExec,
  schema: SchemaDeclaration,
  prefix = "",
): Promise<MigrationPlan> {
  const { rows } = await query(SQLITE_INTROSPECT_SQL, []);

  const live = new Map<string, Map<string, string>>();
  for (const row of rows) {
    const table = String(row.table_name);
    const columns = live.get(table) ?? new Map<string, string>();
    columns.set(String(row.column_name), String(row.data_type).toUpperCase());
    live.set(table, columns);
  }

  const statements: string[] = [];
  const unsupported: string[] = [];
  const createdTables: string[] = [];

  for (const table of Object.values(schema)) {
    const qualified = prefix + table.tableName;
    const existing = live.get(qualified);

    if (!existing || existing.size === 0) {
      createdTables.push(qualified);
      statements.push(...renderSqliteDdl({ [table.tableName]: table }, prefix));
      continue;
    }

    const missing = Object.entries(table.fields).filter(
      ([field]) => !existing.has(toSnakeCase(field)),
    );

    // Nothing can fill a required column with no default on existing rows: it goes in nullable.
    const relaxed: TableDeclaration = {
      ...table,
      fields: Object.fromEntries(
        Object.entries(table.fields).map(([field, spec]) => {
          const unfillable =
            !existing.has(toSnakeCase(field)) &&
            spec.required &&
            !spec.defaultNow &&
            spec.default === undefined;
          if (unfillable) {
            unsupported.push(
              `${qualified}.${toSnakeCase(field)} is declared required but has no default; it was ` +
                "added nullable. Backfill it; SQLite cannot add NOT NULL afterwards without a rebuild.",
            );
          }
          return [field, unfillable ? { ...spec, required: false } : spec];
        }),
      ),
    };

    if (missing.some(([, spec]) => spec.defaultNow)) {
      statements.push(...rebuild(relaxed, prefix, existing));
    } else {
      for (const [field] of missing) {
        const spec = relaxed.fields[field];
        if (!spec) continue;
        statements.push(
          `ALTER TABLE ${quote(qualified)} ADD COLUMN ${sqliteColumnDefinition(field, spec)}`,
        );
      }
      // CREATE INDEX IF NOT EXISTS makes re-issuing every index safe.
      statements.push(...renderSqliteDdl({ [table.tableName]: table }, prefix).slice(1));
    }

    for (const [field, spec] of Object.entries(table.fields)) {
      const found = existing.get(toSnakeCase(field));
      if (found !== undefined && found !== SQLITE_TYPE[spec.type]) {
        unsupported.push(
          `${qualified}.${toSnakeCase(field)} is ${found || "untyped"} but ${SQLITE_TYPE[spec.type]} ` +
            "is declared. Changing a column type needs a table rebuild — do it yourself.",
        );
      }
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

/** The documented SQLite way to change a table's shape: new table, copy, drop, rename, reindex. */
function rebuild(table: TableDeclaration, prefix: string, existing: Map<string, string>): string[] {
  const qualified = prefix + table.tableName;
  const temp = qualified + REBUILD_SUFFIX;

  // Only the CREATE TABLE: its indexes are created after the swap, under their real names.
  const [createTemp = ""] = renderSqliteDdl(
    { [table.tableName]: { ...table, tableName: table.tableName + REBUILD_SUFFIX, indexes: [] } },
    prefix,
  );
  const shared = Object.keys(table.fields)
    .map(toSnakeCase)
    .filter((column) => existing.has(column))
    .map(quote)
    .join(", ");

  return [
    `DROP TABLE IF EXISTS ${quote(temp)}`,
    createTemp,
    `INSERT INTO ${quote(temp)} (${shared}) SELECT ${shared} FROM ${quote(qualified)}`,
    `DROP TABLE ${quote(qualified)}`,
    `ALTER TABLE ${quote(temp)} RENAME TO ${quote(qualified)}`,
    ...renderSqliteDdl({ [table.tableName]: table }, prefix).slice(1),
  ];
}
