/**
 * Builds a parameterised statement: SQL text with `$1, $2 …` placeholders plus
 * the values to bind, which is the one calling convention every Postgres
 * driver agrees on.
 *
 * Values are never interpolated. Identifiers are quoted, and the only
 * identifiers that reach here are either constants in this file or names the
 * PluginStore has already validated against the plugin's own schema.
 */
export class Statement {
  #text = "";
  readonly params: unknown[] = [];

  /** Raw SQL. Never pass user input through this — use `value`. */
  raw(fragment: string): this {
    this.#text += fragment;
    return this;
  }

  /** Binds a value and writes its placeholder. */
  value(value: unknown): this {
    // Dates bind as ISO strings: every driver accepts that for timestamptz,
    // whereas a Date object is only handled by some of them.
    this.params.push(value instanceof Date ? value.toISOString() : value);
    this.#text += `$${this.params.length}`;
    return this;
  }

  /** `$1, $2, $3` — a comma-separated run of bound values. */
  list(values: readonly unknown[], separator = ", "): this {
    values.forEach((value, index) => {
      if (index > 0) this.raw(separator);
      this.value(value);
    });
    return this;
  }

  /** `($1::text, $2::timestamptz)` — one VALUES tuple with explicit casts. */
  tuple(cells: readonly (readonly [unknown, string])[]): this {
    this.raw("(");
    cells.forEach(([value, cast], index) => {
      if (index > 0) this.raw(", ");
      this.value(value).raw(`::${cast}`);
    });
    return this.raw(")");
  }

  get text(): string {
    return this.#text;
  }
}

/** Double-quoted so a table or column name can never be read as SQL. */
export const quote = (identifier: string): string => `"${identifier.replace(/"/g, '""')}"`;
