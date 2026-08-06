import { toSnakeCase } from "../schema/declaration";
import { ConfigError } from "./errors";
import type { SchemaDeclaration, TableDeclaration } from "./plugin";

export type Scalar = string | number | boolean | Date | null;

/**
 * One operator per condition. Operators are tagged objects so a bare value is
 * always an equality test; json columns therefore cannot be filtered, since an
 * object value would be ambiguous.
 */
export type WhereCondition =
  | Scalar
  | { in: readonly (string | number)[] }
  | { lt: Date | number }
  | { lte: Date | number }
  | { gt: Date | number }
  | { gte: Date | number }
  | { not: Scalar };

export type WhereClause = Record<string, WhereCondition>;

export type QueryOptions = {
  limit?: number;
  orderBy?: { field: string; direction: "asc" | "desc" };
};

export type UpsertOptions = { onConflict: readonly string[] };

/**
 * Table access for plugins, scoped to the tables that plugin declared.
 *
 * Plugins could always declare tables via schema() but had no way to read
 * them, so preferences had to bolt its queries onto the core adapter. That
 * does not generalise to digests or push.
 */
export type PluginStore = {
  find<T = Record<string, unknown>>(
    table: string,
    where?: WhereClause,
    options?: QueryOptions,
  ): Promise<T[]>;
  insert(table: string, rows: readonly Record<string, unknown>[]): Promise<number>;
  upsert(
    table: string,
    rows: readonly Record<string, unknown>[],
    options: UpsertOptions,
  ): Promise<number>;
  update(table: string, where: WhereClause, set: Record<string, unknown>): Promise<number>;
  remove(table: string, where: WhereClause): Promise<number>;
};

export type TableStorage = {
  queryTable(
    table: string,
    where: WhereClause,
    options: QueryOptions,
  ): Promise<Record<string, unknown>[]>;
  insertRows(
    table: string,
    rows: readonly Record<string, unknown>[],
    onConflict?: readonly string[],
  ): Promise<number>;
  updateRows(table: string, where: WhereClause, set: Record<string, unknown>): Promise<number>;
  deleteRows(table: string, where: WhereClause): Promise<number>;
};

const OPERATORS = ["in", "lt", "lte", "gt", "gte", "not"] as const;

export const isOperator = (value: unknown): boolean =>
  typeof value === "object" &&
  value !== null &&
  !(value instanceof Date) &&
  OPERATORS.some((op) => op in value);

/**
 * Every table and column a plugin touches is checked against its own
 * declaration. Without this a plugin could read the notification table, and
 * unvalidated identifiers would reach the SQL builder.
 */
export function createPluginStore(
  pluginId: string,
  schema: SchemaDeclaration | undefined,
  storage: TableStorage,
  prefix: string,
): PluginStore {
  const byTableName = new Map<string, TableDeclaration>();
  for (const declaration of Object.values(schema ?? {})) {
    byTableName.set(declaration.tableName, declaration);
  }

  function resolve(table: string): TableDeclaration {
    const declaration = byTableName.get(table);
    if (!declaration) {
      throw new ConfigError(
        `plugin "${pluginId}" accessed table "${table}", which it does not declare in schema().`,
      );
    }
    return declaration;
  }

  function checkFields(table: TableDeclaration, fields: Iterable<string>, context: string) {
    for (const field of fields) {
      const spec = table.fields[field];
      if (!spec) {
        throw new ConfigError(
          `plugin "${pluginId}" used unknown field "${field}" on "${table.tableName}" (${context}).`,
        );
      }
      if (context === "where" && spec.type === "json") {
        throw new ConfigError(
          `plugin "${pluginId}" cannot filter on json field "${field}"; ` +
            "a bare object value is indistinguishable from an operator.",
        );
      }
    }
  }

  const qualified = (table: TableDeclaration) => prefix + table.tableName;

  return {
    async find(table, where = {}, options = {}) {
      const declaration = resolve(table);
      checkFields(declaration, Object.keys(where), "where");
      if (options.orderBy) checkFields(declaration, [options.orderBy.field], "orderBy");

      const rows = await storage.queryTable(qualified(declaration), where, options);

      // SELECT * returns snake_case columns; plugins declare camelCase fields
      // and type their reads that way. Without this every property is
      // undefined at runtime while typechecking perfectly.
      return rows.map((row) => {
        const mapped: Record<string, unknown> = {};
        for (const field of Object.keys(declaration.fields)) {
          mapped[field] = row[toSnakeCase(field)];
        }
        return mapped;
      }) as never;
    },

    async insert(table, rows) {
      const declaration = resolve(table);
      for (const row of rows) checkFields(declaration, Object.keys(row), "insert");
      return storage.insertRows(qualified(declaration), rows);
    },

    async upsert(table, rows, options) {
      const declaration = resolve(table);
      for (const row of rows) checkFields(declaration, Object.keys(row), "upsert");
      checkFields(declaration, options.onConflict, "onConflict");
      return storage.insertRows(qualified(declaration), rows, options.onConflict);
    },

    async update(table, where, set) {
      const declaration = resolve(table);
      checkFields(declaration, Object.keys(where), "where");
      checkFields(declaration, Object.keys(set), "update");
      return storage.updateRows(qualified(declaration), where, set);
    },

    async remove(table, where) {
      const declaration = resolve(table);
      checkFields(declaration, Object.keys(where), "where");
      return storage.deleteRows(qualified(declaration), where);
    },
  };
}
