import type { DeliveryOutcome } from "./adapter";
import type { Logger } from "./errors";
import type { PluginStore } from "./store";
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

export type DeliverContext = {
  channel: Channel;
  deliveryId: string;
  attempt: number;
  recipient: Recipient;
  notification: { id: string; userId: string; type: string; payload: unknown };
  /** Aborted on the runner's timeout. */
  signal: AbortSignal;
};

export type AfterSendContext = {
  type: string;
  payload: unknown;
  /** Committed rows. Ids exist only at this point. */
  notifications: readonly { id: string; userId: string }[];
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
  /**
   * Once per send, after the rows are committed. The only hook that sees
   * notification ids, which digests needs to bucket an entry against one.
   * Fails open: the notification is already written.
   */
  afterSend?: (ctx: AfterSendContext) => Promisable<void>;
  /**
   * Delivers one of the plugin's declared `channels`. Core carries inApp and
   * email; everything else arrives here, which is how push, sms and slack are
   * added without core learning about them.
   */
  deliver?: (ctx: DeliverContext) => Promisable<DeliveryOutcome>;
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

/** Handed to a plugin at startup so it need not be given the database twice. */
export type PluginInitContext = {
  /** Scoped to the tables this plugin declares in schema(). */
  store: PluginStore;
  /** The top-level signing secret, for plugins issuing signed links. */
  secret: string;
  logger: Logger;
  /** The app's resolver, for plugins that need timezones or addresses. */
  getRecipients: (userIds: readonly string[]) => Promise<readonly Recipient[]>;
  /**
   * The instance's own send(). A plugin composing a message (a digest, say)
   * routes it back through the pipeline rather than reaching for a provider,
   * so it inherits retry, backoff and idempotency for free.
   */
  send: (
    type: string,
    args: { to: string | readonly string[]; payload: unknown; dedupeKey?: string },
  ) => Promise<unknown>;
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
  /** Channels this plugin delivers. Makes them usable in a notification. */
  channels?: readonly Channel[];
  /** Called once by easyNotify() before any hook or route can run. */
  init?: (ctx: PluginInitContext) => void;
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
