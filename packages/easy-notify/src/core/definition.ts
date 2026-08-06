import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { Channel } from "./types";

export type PayloadFromSchema<TSchema> = TSchema extends StandardSchemaV1
  ? StandardSchemaV1.InferOutput<TSchema>
  : Record<string, unknown>;

export type EmailTemplate<TPayload> = {
  subject: (payload: TPayload) => string;
  /** Rendered HTML. react-email users wrap: `(p) => render(<Email {...p} />)`. */
  template: (payload: TPayload) => string | Promise<string>;
};

export type NotificationDefinition<
  TSchema extends StandardSchemaV1 | undefined = StandardSchemaV1 | undefined,
> = {
  schema?: TSchema;
  channels: readonly Channel[];
  maxAttempts?: number;
  email?: EmailTemplate<PayloadFromSchema<TSchema>>;
};

/** Binds TSchema so email callbacks infer the payload; TS cannot infer from a sibling property. */
export function defineNotification<TSchema extends StandardSchemaV1 | undefined = undefined>(
  definition: NotificationDefinition<TSchema>,
): NotificationDefinition<TSchema> {
  return definition;
}

/**
 * Erased form. `EmailTemplate<never>` because callbacks are contravariant —
 * anything else makes every schema-typed definition fail to assign.
 */
export type AnyNotificationDefinition = {
  schema?: StandardSchemaV1 | undefined;
  channels: readonly Channel[];
  maxAttempts?: number | undefined;
  email?: EmailTemplate<never> | undefined;
};

export type NotificationDefinitions = Record<string, AnyNotificationDefinition>;

export type PayloadOf<TDef> = TDef extends { schema: infer TSchema extends StandardSchemaV1 }
  ? StandardSchemaV1.InferOutput<TSchema>
  : Record<string, unknown>;
