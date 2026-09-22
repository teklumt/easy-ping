import type { FieldDeclaration, SchemaDeclaration } from "../../core/plugin";
import { coreSchema } from "../../schema/declaration";

type IndexSpec = Record<string, 1 | -1>;

type IndexOptions = {
  name: string;
  unique?: boolean;
  partialFilterExpression?: Record<string, unknown>;
};

type IndexableDb = {
  collection(name: string): {
    createIndex(spec: IndexSpec, options: IndexOptions): Promise<string>;
  };
};

const BSON_TYPE: Record<FieldDeclaration["type"], string> = {
  string: "string",
  number: "number",
  boolean: "bool",
  date: "date",
  json: "object",
};

/**
 * Applies a SchemaDeclaration's indexes to Mongo. The document counterpart of
 * renderPostgresDdl — there are no tables to create, only indexes, and the
 * declaration is the same source of truth.
 *
 * A unique index over a nullable field gets a partial filter. Postgres treats
 * every NULL as distinct, so unlimited rows may leave dedupeKey unset; a plain
 * Mongo unique index treats them as one value and would allow exactly one.
 */
export async function createPluginIndexes(
  db: unknown,
  schema: SchemaDeclaration,
  prefix = "",
): Promise<void> {
  const database = db as IndexableDb;

  for (const table of Object.values(schema)) {
    const collection = database.collection(prefix + table.tableName);

    // A single "id" key is stored as _id, which is already unique.
    if (table.primaryKey && table.primaryKey.length > 0 && table.primaryKey[0] !== "id") {
      const spec: IndexSpec = {};
      for (const field of table.primaryKey) spec[field] = 1;
      await collection.createIndex(spec, {
        name: `${table.tableName}_pk`,
        unique: true,
      });
    }

    for (const declaration of table.indexes ?? []) {
      const spec: IndexSpec = {};
      for (const field of declaration.on) spec[field] = 1;

      const options: IndexOptions = {
        name: prefix + (declaration.name ?? `${table.tableName}_${declaration.on.join("_")}_idx`),
      };

      if (declaration.unique) {
        options.unique = true;

        const partial: Record<string, unknown> = {};
        for (const field of declaration.on) {
          const spec = table.fields[field];
          if (spec && !spec.required) partial[field] = { $type: BSON_TYPE[spec.type] };
        }
        if (Object.keys(partial).length > 0) options.partialFilterExpression = partial;
      }

      await collection.createIndex(spec, options);
    }
  }
}

/** Creates the indexes the core tables need. Call once at startup. */
export const createMongoIndexes = (db: unknown, options: { prefix?: string } = {}) =>
  createPluginIndexes(db, coreSchema, options.prefix ?? "");
