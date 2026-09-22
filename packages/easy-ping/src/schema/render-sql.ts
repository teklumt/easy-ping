import type { FieldDeclaration, SchemaDeclaration } from "../core/plugin";
import { toSnakeCase } from "./declaration";

const SQL_TYPE: Record<FieldDeclaration["type"], string> = {
  string: "text",
  number: "integer",
  boolean: "boolean",
  date: "timestamptz",
  json: "jsonb",
};

const quote = (value: string) => `"${value.replace(/"/g, '""')}"`;

const defaultClause = (field: FieldDeclaration): string => {
  if (field.defaultNow) return " DEFAULT now()";
  if (field.default === undefined) return "";
  if (typeof field.default === "string") return ` DEFAULT '${field.default.replace(/'/g, "''")}'`;
  return ` DEFAULT ${field.default}`;
};

/** SchemaDeclaration to Postgres DDL, from the same source as the Drizzle renderer. */
export function renderPostgresDdl(schema: SchemaDeclaration, prefix = ""): string[] {
  const statements: string[] = [];

  for (const table of Object.values(schema)) {
    const name = quote(prefix + table.tableName);

    const columns = Object.entries(table.fields).map(([field, spec]) => {
      const nullability = spec.required ? " NOT NULL" : "";
      return `  ${quote(toSnakeCase(field))} ${SQL_TYPE[spec.type]}${nullability}${defaultClause(spec)}`;
    });

    if (table.primaryKey?.length) {
      const key = table.primaryKey.map((field) => quote(toSnakeCase(field))).join(", ");
      columns.push(`  PRIMARY KEY (${key})`);
    }

    statements.push(`CREATE TABLE IF NOT EXISTS ${name} (\n${columns.join(",\n")}\n)`);

    for (const declaration of table.indexes ?? []) {
      const indexName = quote(
        prefix + (declaration.name ?? `${table.tableName}_${declaration.on.join("_")}_idx`),
      );
      const columns = declaration.on.map((field) => quote(toSnakeCase(field))).join(", ");
      const unique = declaration.unique ? "UNIQUE " : "";
      statements.push(`CREATE ${unique}INDEX IF NOT EXISTS ${indexName} ON ${name} (${columns})`);
    }
  }

  return statements;
}
