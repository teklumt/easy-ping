import type { DeliveryOutcome } from "./adapter";
import type { Channel, Recipient } from "./types";

export type Promisable<T> = T | Promise<T>;

export type PrepareContext = {
  type: string;
  recipients: readonly Recipient[];
};

export type BeforeSendContext = {
  type: string;
  recipient: Recipient;
  payload: unknown;
  actorId: string | null;
  dedupeKey: string | null;
  /** Whatever this plugin's own prepare() returned for this send. */
  prepared: unknown;
};

export type BeforeSendResult =
  | { action: "continue"; payload?: unknown; dedupeKey?: string }
  | { action: "cancel"; reason: string };

export type ChannelDecision = {
  channel: Channel;
  action: "send" | "skip" | "defer";
  /** defer only. Written to notification_delivery.not_before. */
  notBefore?: Date | undefined;
};

export type ResolveChannelsContext = {
  type: string;
  recipient: Recipient;
  payload: unknown;
  decisions: readonly ChannelDecision[];
  /** Whatever this plugin's own prepare() returned for this send. */
  prepared: unknown;
};

export type AfterDeliverContext = {
  deliveryId: string;
  notificationId: string;
  userId: string;
  channel: Channel;
  outcome: DeliveryOutcome;
  attempt: number;
  isTerminal: boolean;
};

/** beforeSend and resolveChannels fail closed; afterDeliver fails open. */
export type PluginHooks = {
  /** Once per send, for bulk loading — the per-recipient hooks would be an N+1. */
  prepare?: (ctx: PrepareContext) => Promisable<unknown>;
  beforeSend?: (ctx: BeforeSendContext) => Promisable<BeforeSendResult>;
  resolveChannels?: (ctx: ResolveChannelsContext) => Promisable<readonly ChannelDecision[]>;
  afterDeliver?: (ctx: AfterDeliverContext) => Promisable<void>;
};

export type FieldType = "string" | "number" | "boolean" | "date" | "json";

export type FieldDeclaration = {
  type: FieldType;
  required?: boolean;
  default?: string | number | boolean;
  /** date fields only. Renders as defaultNow() / CURRENT_TIMESTAMP. */
  defaultNow?: boolean;
};

export type IndexDeclaration = {
  on: readonly string[];
  unique?: boolean;
  name?: string;
};

export type TableDeclaration = {
  tableName: string;
  fields: Record<string, FieldDeclaration>;
  primaryKey?: readonly string[];
  indexes?: readonly IndexDeclaration[];
};

export type SchemaDeclaration = Record<string, TableDeclaration>;

export type RouteScope =
  | { type: "user" }
  | { type: "machine" }
  | { type: "signed"; purpose: string }
  | { type: "custom"; justification: string };

export type RouteContext = {
  request: Request;
  /** Resolved for user-scoped routes, so a handler cannot forget to scope. */
  userId: string | null;
  /** Verified before dispatch, so a handler cannot forget to check. */
  claims: { uid: string; purpose: string; exp: number; data?: Record<string, string> } | null;
  params: Record<string, string>;
};

export type RouteDefinition = {
  path: string;
  method: "GET" | "POST";
  scope: RouteScope;
  handler: (ctx: RouteContext) => Promise<Response>;
};

export type EasyNotifyPlugin<
  TId extends string = string,
  TSchema extends SchemaDeclaration = SchemaDeclaration,
> = {
  id: TId;
  dependsOn?: readonly string[];
  schema?: TSchema;
  routes?: readonly RouteDefinition[];
  hooks?: PluginHooks;
};

export type AnyPlugin = EasyNotifyPlugin<string, SchemaDeclaration>;

export function definePlugin<TId extends string, TSchema extends SchemaDeclaration>(
  plugin: EasyNotifyPlugin<TId, TSchema>,
): EasyNotifyPlugin<TId, TSchema> {
  return plugin;
}

export type ClientFetch = (path: string, init?: RequestInit) => Promise<unknown>;

export type ClientPlugin<
  TId extends string = string,
  TActions extends Record<string, unknown> = Record<string, unknown>,
> = {
  id: TId;
  /** Phantom. Links client types to the server plugin so a mismatch is a type error. */
  $InferServerPlugin?: AnyPlugin;
  actions: (fetch: ClientFetch) => TActions;
};

export type AnyClientPlugin = ClientPlugin<string, Record<string, unknown>>;

export function defineClientPlugin<TId extends string, TActions extends Record<string, unknown>>(
  plugin: ClientPlugin<TId, TActions>,
): ClientPlugin<TId, TActions> {
  return plugin;
}

export type UnionToIntersection<U> = (U extends unknown ? (k: U) => void : never) extends (
  k: infer I,
) => void
  ? I
  : never;

/** Naked type parameter, so the conditional distributes over the union. */
type ExtractActions<TPlugin> = TPlugin extends { actions: (fetch: never) => infer TActions }
  ? TActions
  : never;

/** Indexes the tuple rather than recursing: a fold blows the instantiation depth limit. */
export type ActionsOf<TPlugins extends readonly AnyClientPlugin[]> = UnionToIntersection<
  ExtractActions<TPlugins[number]>
>;
