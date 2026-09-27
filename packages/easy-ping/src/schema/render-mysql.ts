import type { FieldDeclaration, SchemaDeclaration, TableDeclaration } from "../core/plugin";
import { toSnakeCase } from "./declaration";

const quote = (value: string) => `\`${value.split("`").join("``")}\``;

/** InnoDB caps a key at 3072 bytes: 768 utf8mb4 chars for one column, 255 each for three. TEXT cannot be a key or carry a default. */
function stringType(field: string, table: TableDeclaration, spec: FieldDeclaration): string {
  const keys = [
    ...(table.primaryKey ? [table.primaryKey] : []),
    ...(table.indexes ?? []).map((index) => index.on),
  ].filter((columns) => columns.includes(field));

  if (keys.some((columns) => columns.length > 1)) return "VARCHAR(255)";
  if (keys.length > 0) return "VARCHAR(768)";
  if (spec.default !== undefined) return "VARCHAR(255)";
  return "TEXT";
}

function columnType(field: string, table: TableDeclaration, spec: FieldDeclaration): string {
  switch (spec.type) {
    case "string":
      return stringType(field, table, spec);
    case "number":
      return "INT";
    case "boolean":
      return "TINYINT(1)";
    case "date":
      return "DATETIME(3)";
    case "json":
      return "JSON";
  }
}

const defaultClause = (spec: FieldDeclaration): string => {
  if (spec.defaultNow) return " DEFAULT CURRENT_TIMESTAMP(3)";
  if (spec.default === undefined) return "";
  if (typeof spec.default === "string") return ` DEFAULT '${spec.default.replace(/'/g, "''")}'`;
  if (typeof spec.default === "boolean") return ` DEFAULT ${spec.default ? 1 : 0}`;
  return ` DEFAULT ${spec.default}`;
};

/** One column's definition, as CREATE TABLE and ALTER TABLE ... ADD COLUMN both need it. */
export function mysqlColumnDefinition(
  field: string,
  table: TableDeclaration,
  spec: FieldDeclaration,
): string {
  const nullability = spec.required ? " NOT NULL" : "";
  return `${quote(toSnakeCase(field))} ${columnType(field, table, spec)}${nullability}${defaultClause(spec)}`;
}

/** MySQL DDL, one CREATE TABLE IF NOT EXISTS per table with indexes inline (no CREATE INDEX IF NOT EXISTS). */
export function renderMysqlDdl(schema: SchemaDeclaration, prefix = ""): string[] {
  const statements: string[] = [];

  for (const table of Object.values(schema)) {
    const lines = Object.entries(table.fields).map(
      ([field, spec]) => `  ${mysqlColumnDefinition(field, table, spec)}`,
    );

    if (table.primaryKey?.length) {
      lines.push(
        `  PRIMARY KEY (${table.primaryKey.map((f) => quote(toSnakeCase(f))).join(", ")})`,
      );
    }

    for (const index of table.indexes ?? []) {
      const name = quote(prefix + (index.name ?? `${table.tableName}_${index.on.join("_")}_idx`));
      const columns = index.on.map((f) => quote(toSnakeCase(f))).join(", ");
      lines.push(`  ${index.unique ? "UNIQUE " : ""}INDEX ${name} (${columns})`);
    }

    statements.push(
      `CREATE TABLE IF NOT EXISTS ${quote(prefix + table.tableName)} (\n${lines.join(",\n")}\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    );
  }

  return statements;
}
