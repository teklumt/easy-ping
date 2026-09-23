export type Placeholder = "dollar" | "question";

export type StatementOptions = {
  /** `$1, $2` for Postgres; `?` for MySQL and SQLite. */
  placeholder?: Placeholder;
  /** What the driver is handed for a JS value. Dates become ISO strings by default. */
  bind?: (value: unknown) => unknown;
};

const defaultBind = (value: unknown) => (value instanceof Date ? value.toISOString() : value);

/** SQL text plus bound values. Values are never interpolated; identifiers arrive pre-validated. */
export class Statement {
  #text = "";
  readonly params: unknown[] = [];
  readonly #placeholder: Placeholder;
  readonly #bind: (value: unknown) => unknown;

  constructor(options: StatementOptions = {}) {
    this.#placeholder = options.placeholder ?? "dollar";
    this.#bind = options.bind ?? defaultBind;
  }

  /** Raw SQL. Never user input; use `value`. */
  raw(fragment: string): this {
    this.#text += fragment;
    return this;
  }

  value(value: unknown): this {
    this.params.push(this.#bind(value));
    this.#text += this.#placeholder === "dollar" ? `$${this.params.length}` : "?";
    return this;
  }

  list(values: readonly unknown[], separator = ", "): this {
    values.forEach((value, index) => {
      if (index > 0) this.raw(separator);
      this.value(value);
    });
    return this;
  }

  /** `($1::text, $2::timestamptz)`. Casts are Postgres-only and dropped elsewhere. */
  tuple(cells: readonly (readonly [unknown, string])[]): this {
    this.raw("(");
    cells.forEach(([value, cast], index) => {
      if (index > 0) this.raw(", ");
      this.value(value);
      if (this.#placeholder === "dollar") this.raw(`::${cast}`);
    });
    return this.raw(")");
  }

  get text(): string {
    return this.#text;
  }
}

export const quoteWith =
  (quoteChar: '"' | "`") =>
  (identifier: string): string =>
    `${quoteChar}${identifier.split(quoteChar).join(quoteChar + quoteChar)}${quoteChar}`;

/** Double-quoted: Postgres and SQLite. */
export const quote = quoteWith('"');
