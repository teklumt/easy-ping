import type { FieldDeclaration, SchemaDeclaration } from "../core/plugin";
import { toSnakeCase } from "./declaration";

const SQL_TYPE: Record<FieldDeclaration["type"], string> = {
  string: "TEXT",
  number: "INTEGER",
  boolean: "INTEGER",
  // ISO-8601 with milliseconds and a trailing Z, the same 24 characters
  // `Date#toISOString` writes, so `<=` on the text is `<=` on the instant.
  date: "TEXT",
  json: "TEXT",
};

const quote = (value: string) => `"${value.split('"').join('""')}"`;

const defaultClause = (spec: FieldDeclaration): string => {
  if (spec.defaultNow) return " DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))";
  if (spec.default === undefined) return "";
  if (typeof spec.default === "string") return ` DEFAULT '${spec.default.replace(/'/g, "''")}'`;
  if (typeof spec.default === "boolean") return ` DEFAULT ${spec.default ? 1 : 0}`;
  return ` DEFAULT ${spec.default}`;
};

/** SchemaDeclaration to SQLite DDL. Every statement is `IF NOT EXISTS`. */
export function renderSqliteDdl(schema: SchemaDeclaration, prefix = ""): string[] {
  const statements: string[] = [];

  for (const table of Object.values(schema)) {
    const name = quote(prefix + table.tableName);

    const columns = Object.entries(table.fields).map(([field, spec]) => {
      const nullability = spec.required ? " NOT NULL" : "";
      return `  ${quote(toSnakeCase(field))} ${SQL_TYPE[spec.type]}${nullability}${defaultClause(spec)}`;
    });

    if (table.primaryKey?.length) {
      columns.push(
        `  PRIMARY KEY (${table.primaryKey.map((f) => quote(toSnakeCase(f))).join(", ")})`,
      );
    }

    statements.push(`CREATE TABLE IF NOT EXISTS ${name} (\n${columns.join(",\n")}\n)`);

    for (const index of table.indexes ?? []) {
      const indexName = quote(
        prefix + (index.name ?? `${table.tableName}_${index.on.join("_")}_idx`),
      );
      const cols = index.on.map((f) => quote(toSnakeCase(f))).join(", ");
      statements.push(
        `CREATE ${index.unique ? "UNIQUE " : ""}INDEX IF NOT EXISTS ${indexName} ON ${name} (${cols})`,
      );
    }
  }

  return statements;
}
