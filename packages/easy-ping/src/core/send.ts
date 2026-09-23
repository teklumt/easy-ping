import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { DatabaseAdapter, InsertDelivery, InsertNotification } from "./adapter";
import type { ChannelsConfig, SendResult } from "./config";
import type { NotificationDefinitions } from "./definition";
import { type Logger, ValidationError } from "./errors";
import type { AnyPlugin, BeforeSendResult, ChannelDecision } from "./plugin";
import type { Channel, Recipient, SkipReason } from "./types";

export type SendPipelineDeps = {
  adapter: DatabaseAdapter;
  definitions: NotificationDefinitions;
  channels: ChannelsConfig;
  plugins: readonly AnyPlugin[];
  getRecipients: (userIds: readonly string[]) => Promise<readonly Recipient[]>;
  maxAttempts: number;
  logger: Logger;
  generateId?: () => string;
};

export type SendInput = {
  to: string | readonly string[];
  payload: unknown;
  actorId?: string | undefined;
  dedupeKey?: string | undefined;
  overrides?: { channels?: readonly Channel[] } | undefined;
};

async function validatePayload(type: string, schema: StandardSchemaV1, payload: unknown) {
  const result = await schema["~standard"].validate(payload);
  if (result.issues) {
    throw new ValidationError(
      type,
      result.issues.map((issue) => ({
        message: issue.message,
        ...(issue.path ? { path: issue.path.map(String).join(".") } : {}),
      })),
    );
  }
  return result.value;
}

/** inApp is on unless disabled; every other channel needs a provider or a plugin that delivers it. */
export function isChannelUsable(
  channel: Channel,
  channels: ChannelsConfig,
  plugins: readonly AnyPlugin[] = [],
): boolean {
  if (channel === "inApp") return channels.inApp?.enabled !== false;
  if (channel === "email") return Boolean(channels.email?.provider);
  // Anything else is usable only if a plugin claims it and can deliver it.
  return plugins.some((plugin) => plugin.channels?.includes(channel) && plugin.hooks?.deliver);
}

/** One prepare() per plugin per send, keyed by plugin id. */
async function runPrepare(
  plugins: readonly AnyPlugin[],
  ctx: { type: string; recipients: readonly Recipient[] },
  logger: Logger,
): Promise<Map<string, unknown>> {
  const prepared = new Map<string, unknown>();

  for (const plugin of plugins) {
    const hook = plugin.hooks?.prepare;
    if (!hook) continue;
    try {
      prepared.set(plugin.id, await hook(ctx));
    } catch (error) {
      // Fail closed: a failed bulk load must not decide with stale assumptions.
      logger.error(`plugin "${plugin.id}" prepare threw; its hooks will see undefined`, {
        type: ctx.type,
        error,
      });
      prepared.set(plugin.id, undefined);
    }
  }

  return prepared;
}

async function runBeforeSend(
  plugins: readonly AnyPlugin[],
  base: { type: string; recipient: Recipient; actorId: string | null },
  payload: unknown,
  dedupeKey: string | null,
  prepared: Map<string, unknown>,
  logger: Logger,
): Promise<BeforeSendResult> {
  let currentPayload = payload;
  let currentDedupeKey = dedupeKey;

  for (const plugin of plugins) {
    const hook = plugin.hooks?.beforeSend;
    if (!hook) continue;

    let result: BeforeSendResult;
    try {
      result = await hook({
        ...base,
        payload: currentPayload,
        dedupeKey: currentDedupeKey,
        prepared: prepared.get(plugin.id),
      });
    } catch (error) {
      // Fail closed: failing open would email people who opted out. RFC 0004 §5.
      logger.error(`plugin "${plugin.id}" beforeSend threw; cancelling send`, {
        type: base.type,
        userId: base.recipient.userId,
        error,
      });
      return { action: "cancel", reason: `plugin "${plugin.id}" beforeSend threw` };
    }

    if (result.action === "cancel") return result;
    if (result.payload !== undefined) currentPayload = result.payload;
    if (result.dedupeKey !== undefined) currentDedupeKey = result.dedupeKey;
  }

  return {
    action: "continue",
    payload: currentPayload,
    ...(currentDedupeKey === null ? {} : { dedupeKey: currentDedupeKey }),
  };
}

async function runResolveChannels(
  plugins: readonly AnyPlugin[],
  base: { type: string; recipient: Recipient; payload: unknown },
  initial: readonly ChannelDecision[],
  prepared: Map<string, unknown>,
  logger: Logger,
): Promise<readonly ChannelDecision[]> {
  let decisions = initial;

  for (const plugin of plugins) {
    const hook = plugin.hooks?.resolveChannels;
    if (!hook) continue;

    try {
      decisions = [...(await hook({ ...base, decisions, prepared: prepared.get(plugin.id) }))];
    } catch (error) {
      // Fail closed: keep the decisions already made. RFC 0004 §5.
      logger.error(`plugin "${plugin.id}" resolveChannels threw; keeping prior decisions`, {
        type: base.type,
        userId: base.recipient.userId,
        error,
      });
      return decisions;
    }
  }

  return decisions;
}

export async function runSend(
  type: string,
  input: SendInput,
  deps: SendPipelineDeps,
): Promise<SendResult> {
  const definition = deps.definitions[type];
  if (!definition) {
    throw new ValidationError(type, [{ message: `unknown notification type "${type}"` }]);
  }

  const payload = definition.schema
    ? await validatePayload(type, definition.schema, input.payload)
    : input.payload;

  const userIds = [...new Set(Array.isArray(input.to) ? input.to : [input.to as string])];
  const recipients = await deps.getRecipients(userIds);
  const byUserId = new Map(recipients.map((recipient) => [recipient.userId, recipient]));

  const newId = deps.generateId ?? (() => crypto.randomUUID());
  const skipped: { userId: string; reason: SkipReason }[] = [];
  const rows: InsertNotification[] = [];
  const actorId = input.actorId ?? null;

  const declared = input.overrides?.channels ?? definition.channels;
  const requested = declared.filter((channel) =>
    isChannelUsable(channel, deps.channels, deps.plugins),
  );

  // Distinct from "no-channels": a missing provider is not an opt-out.
  if (declared.length > 0 && requested.length === 0) {
    return {
      notifications: [],
      skipped: userIds.map((userId) => ({ userId, reason: "channel-unavailable" as const })),
    };
  }

  const prepared = await runPrepare(deps.plugins, { type, recipients }, deps.logger);

  for (const userId of userIds) {
    const recipient = byUserId.get(userId);
    if (!recipient) {
      skipped.push({ userId, reason: "no-recipient" });
      continue;
    }

    const before = await runBeforeSend(
      deps.plugins,
      { type, recipient, actorId },
      payload,
      input.dedupeKey ?? null,
      prepared,
      deps.logger,
    );

    if (before.action === "cancel") {
      skipped.push({ userId, reason: "no-channels" });
      continue;
    }

    const resolved = await runResolveChannels(
      deps.plugins,
      { type, recipient, payload: before.payload ?? payload },
      requested.map((channel) => ({ channel, action: "send" as const })),
      prepared,
      deps.logger,
    );

    const now = new Date();
    const deliveries: InsertDelivery[] = resolved
      .filter((decision) => decision.action !== "skip")
      .filter((decision) => isChannelUsable(decision.channel, deps.channels, deps.plugins))
      .map((decision) => ({
        id: newId(),
        channel: decision.channel,
        maxAttempts: definition.maxAttempts ?? deps.maxAttempts,
        // defer is just not_before; the claim query refuses rows whose time has not come. RFC 0004 §4.2.
        notBefore: decision.action === "defer" && decision.notBefore ? decision.notBefore : now,
      }));

    if (deliveries.length === 0) {
      skipped.push({ userId, reason: "no-channels" });
      continue;
    }

    const dedupeKey = before.action === "continue" ? before.dedupeKey : undefined;

    rows.push({
      id: newId(),
      userId,
      type,
      payload: before.payload ?? payload,
      ...(actorId ? { actorId } : {}),
      ...(dedupeKey ? { dedupeKey } : {}),
      deliveries,
    });
  }

  if (rows.length === 0) return { notifications: [], skipped };

  const { created, deduped } = await deps.adapter.createNotifications(rows);
  const createdSet = new Set(created);

  for (const row of rows) {
    if (deduped.includes(row.id)) skipped.push({ userId: row.userId, reason: "deduped" });
  }

  const notifications = rows
    .filter((row) => createdSet.has(row.id))
    .map((row) => ({
      id: row.id,
      userId: row.userId,
      deliveries: row.deliveries.map((delivery) => ({
        id: delivery.id,
        channel: delivery.channel,
      })),
    }));

  for (const plugin of deps.plugins) {
    const hook = plugin.hooks?.afterSend;
    if (!hook) continue;
    try {
      await hook({
        type,
        payload,
        notifications: notifications.map(({ id, userId }) => ({ id, userId })),
        prepared: prepared.get(plugin.id),
      });
    } catch (error) {
      // Fails open: the rows are committed.
      deps.logger.error(`plugin "${plugin.id}" afterSend threw; ignoring`, { type, error });
    }
  }

  return { notifications, skipped };
}
