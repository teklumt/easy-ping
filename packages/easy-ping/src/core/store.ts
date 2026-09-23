import { toSnakeCase } from "../schema/declaration";
import { ConfigError } from "./errors";
import type { FieldDeclaration, SchemaDeclaration, TableDeclaration } from "./plugin";

export type Scalar = string | number | boolean | Date | null;

/** Operators are tagged objects so a bare value is always equality; json columns cannot be filtered. */
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

/** Table access for plugins, scoped to the tables the plugin declared. */
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
  readonly naming?: "snake_case" | "preserve";
  readonly serializesJson?: boolean;

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
  OPERATORS.some((op) => Object.hasOwn(value, op));

const isScalar = (value: unknown): value is Scalar =>
  value === null ||
  typeof value === "string" ||
  typeof value === "number" ||
  typeof value === "boolean" ||
  value instanceof Date;

/** A forwarded JSON body can carry `{ $ne: … }`; refuse anything that is not a scalar or a known operator. */
function assertCondition(pluginId: string, field: string, condition: unknown): void {
  if (isScalar(condition)) return;

  if (isOperator(condition)) {
    const operator = condition as Record<string, unknown>;
    const keys = Object.keys(operator);
    const [op] = keys;
    if (keys.length !== 1 || op === undefined) {
      throw new ConfigError(`plugin "${pluginId}" gave field "${field}" more than one operator.`);
    }
    const payload = operator[op];
    const valid =
      op === "in"
        ? Array.isArray(payload) &&
          payload.every((item) => typeof item === "string" || typeof item === "number")
        : isScalar(payload);
    if (valid) return;
  }

  throw new ConfigError(
    `plugin "${pluginId}" passed a non-scalar value for field "${field}"; ` +
      "validate request bodies before querying with them.",
  );
}

function assertValue(pluginId: string, field: string, spec: FieldDeclaration, value: unknown) {
  if (value === undefined || isScalar(value)) return;
  if (spec.type === "json" && typeof value === "object") return;
  throw new ConfigError(
    `plugin "${pluginId}" passed a non-scalar value for ${spec.type} field "${field}".`,
  );
}

/** Every table and column is checked against the plugin's own declaration. */
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
      // hasOwn, not a lookup: `constructor` and `__proto__` are not columns.
      const spec = Object.hasOwn(table.fields, field) ? table.fields[field] : undefined;
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

  function checkWhere(table: TableDeclaration, where: WhereClause) {
    checkFields(table, Object.keys(where), "where");
    for (const [field, condition] of Object.entries(where)) {
      assertCondition(pluginId, field, condition);
    }
  }

  function checkRow(table: TableDeclaration, row: Record<string, unknown>, context: string) {
    checkFields(table, Object.keys(row), context);
    for (const [field, value] of Object.entries(row)) {
      const spec = table.fields[field];
      if (spec) assertValue(pluginId, field, spec, value);
    }
  }

  const qualified = (table: TableDeclaration) => prefix + table.tableName;

  // A document store keeps the declared names; a SQL adapter wants columns.
  const column = (field: string) => (storage.naming === "preserve" ? field : toSnakeCase(field));

  // json must reach postgres-js as text.
  const serialize = (table: TableDeclaration, row: Record<string, unknown>) => {
    if (storage.serializesJson === false) return row;

    const out: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(row)) {
      out[field] =
        table.fields[field]?.type === "json" && value !== null && value !== undefined
          ? JSON.stringify(value)
          : value;
    }
    return out;
  };

  return {
    async find(table, where = {}, options = {}) {
      const declaration = resolve(table);
      checkWhere(declaration, where);
      if (options.orderBy) checkFields(declaration, [options.orderBy.field], "orderBy");

      const rows = await storage.queryTable(qualified(declaration), where, options);

      // SELECT * returns snake_case; plugins read camelCase.
      return rows.map((row) => {
        const mapped: Record<string, unknown> = {};
        for (const field of Object.keys(declaration.fields)) {
          const value = row[column(field)];
          const type = declaration.fields[field]?.type;
          // Drivers differ on jsonb (parsed or text) and timestamptz (Date or text).
          if (type === "json" && typeof value === "string") mapped[field] = JSON.parse(value);
          else if (type === "date" && typeof value === "string") mapped[field] = new Date(value);
          // MySQL and SQLite have no boolean column; they hand back 0 and 1.
          else if (type === "boolean" && typeof value === "number") mapped[field] = value !== 0;
          else mapped[field] = value;
        }
        return mapped;
      }) as never;
    },

    async insert(table, rows) {
      const declaration = resolve(table);
      for (const row of rows) checkRow(declaration, row, "insert");
      return storage.insertRows(
        qualified(declaration),
        rows.map((row) => serialize(declaration, row)),
      );
    },

    async upsert(table, rows, options) {
      const declaration = resolve(table);
      for (const row of rows) checkRow(declaration, row, "upsert");
      checkFields(declaration, options.onConflict, "onConflict");
      return storage.insertRows(
        qualified(declaration),
        rows.map((row) => serialize(declaration, row)),
        options.onConflict,
      );
    },

    async update(table, where, set) {
      const declaration = resolve(table);
      checkWhere(declaration, where);
      checkRow(declaration, set, "update");
      return storage.updateRows(qualified(declaration), where, serialize(declaration, set));
    },

    async remove(table, where) {
      const declaration = resolve(table);
      checkWhere(declaration, where);
      return storage.deleteRows(qualified(declaration), where);
    },
  };
}
