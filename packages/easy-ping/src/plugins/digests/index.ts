import type {
  AfterSendContext,
  EasyPingPlugin,
  PluginInitContext,
  PrepareContext,
  ResolveChannelsContext,
} from "../../core/plugin";
import type { Frequency } from "../../core/types";
import { coreSchema } from "../../schema/declaration";
import { type DigestWindow, isDue, localMoment, periodKey } from "./schedule";

const ENTRY = "notification_digest_entry";
const STATE = "notification_digest_state";

export type DigestEntry = {
  id: string;
  userId: string;
  type: string;
  notificationId: string;
  payload: unknown;
  window: DigestWindow;
  createdAt: Date;
};

export type DigestsOptions = {
  /** The type the composed digest is sent as; the app defines its template over `{ items }`. */
  digestType?: string;
  /** Local hour at which a digest becomes due. */
  sendHour?: number;
  /** Weekly digests only; 0 = Sunday. */
  sendWeekday?: number;
  /** Channels a digest defers. Only email makes sense today. */
  channel?: "email";
  /** Safety valve on one cron run. */
  maxUsersPerRun?: number;
};

type Prepared = {
  /** userId -> window, for recipients whose preference defers this type. */
  deferred: Map<string, DigestWindow>;
};

const isDigestWindow = (frequency: Frequency): frequency is DigestWindow =>
  frequency === "daily" || frequency === "weekly";

/** One email containing N items, rather than N deferred emails at 9am. Depends on `preferences` for the frequency. */
export function digests(options: DigestsOptions = {}): EasyPingPlugin<"digests"> {
  const digestType = options.digestType ?? "digest";
  const sendHour = options.sendHour ?? 9;
  const sendWeekday = options.sendWeekday ?? 1;
  const channel = options.channel ?? "email";
  const maxUsersPerRun = options.maxUsersPerRun ?? 500;

  let ctx: PluginInitContext;

  /** Reads the frequency the preferences plugin stored for this type. */
  async function windowFor(
    userIds: readonly string[],
    type: string,
  ): Promise<Map<string, DigestWindow>> {
    const rows = await ctx.store.find<{
      userId: string;
      type: string;
      channel: string;
      frequency: Frequency;
      enabled: boolean;
    }>("notification_preference", { userId: { in: [...userIds] }, type, channel });

    const windows = new Map<string, DigestWindow>();
    for (const row of rows) {
      if (row.enabled && isDigestWindow(row.frequency)) windows.set(row.userId, row.frequency);
    }
    return windows;
  }

  return {
    id: "digests",
    dependsOn: ["preferences"],

    init: (context) => {
      ctx = context;
    },

    schema: {
      digestEntry: {
        tableName: ENTRY,
        fields: {
          id: { type: "string", required: true },
          userId: { type: "string", required: true },
          type: { type: "string", required: true },
          notificationId: { type: "string", required: true },
          payload: { type: "json" },
          window: { type: "string", required: true },
          createdAt: { type: "date", required: true, defaultNow: true },
        },
        primaryKey: ["id"],
        indexes: [{ on: ["userId", "window"], name: "digest_entry_user_idx" }],
      },

      digestState: {
        tableName: STATE,
        fields: {
          userId: { type: "string", required: true },
          window: { type: "string", required: true },
          /** Last period actually sent. The idempotency key for the schedule. */
          lastPeriod: { type: "string", required: true },
          updatedAt: { type: "date", required: true, defaultNow: true },
        },
        primaryKey: ["userId", "window"],
      },

      // Read-only here. The full core declaration, not a subset, so migration planners
      // comparing it against the live table do not see updated_at as undeclared.
      notificationPreference: { ...coreSchema.notificationPreference, readOnly: true },
    },

    hooks: {
      prepare: async (context: PrepareContext): Promise<Prepared> => {
        if (context.type === digestType) return { deferred: new Map() };

        return {
          deferred: await windowFor(
            context.recipients.map((recipient) => recipient.userId),
            context.type,
          ),
        };
      },

      resolveChannels: (context: ResolveChannelsContext) => {
        const prepared = context.prepared as Prepared | undefined;
        if (!prepared?.deferred.has(context.recipient.userId)) return context.decisions;

        return context.decisions.map((decision) =>
          decision.channel === channel ? { ...decision, action: "skip" as const } : decision,
        );
      },

      // The only hook that sees notification ids.
      afterSend: async (context: AfterSendContext) => {
        const prepared = context.prepared as Prepared | undefined;
        if (!prepared || prepared.deferred.size === 0) return;

        const entries = context.notifications
          .filter((notification) => prepared.deferred.has(notification.userId))
          .map((notification) => ({
            id: crypto.randomUUID(),
            userId: notification.userId,
            type: context.type,
            notificationId: notification.id,
            payload: context.payload,
            window: prepared.deferred.get(notification.userId) as DigestWindow,
            createdAt: new Date(),
          }));

        if (entries.length > 0) await ctx.store.insert(ENTRY, entries);
      },
    },

    routes: [
      {
        /** Point an hourly cron here: "9am" is 24 different UTC moments that shift with DST. */
        path: "/digests/cron",
        method: "POST",
        scope: { type: "machine" },
        handler: async () => {
          const now = new Date();

          const pending = await ctx.store.find<DigestEntry>(ENTRY, {}, { limit: 10_000 });
          if (pending.length === 0) return Response.json({ sent: 0, users: 0 });

          const byUser = new Map<string, DigestEntry[]>();
          for (const entry of pending) {
            const bucket = byUser.get(entry.userId);
            if (bucket) bucket.push(entry);
            else byUser.set(entry.userId, [entry]);
          }

          const userIds = [...byUser.keys()].slice(0, maxUsersPerRun);
          const recipients = await ctx.getRecipients(userIds);
          const zones = new Map(recipients.map((r) => [r.userId, r.timezone]));

          const states = await ctx.store.find<{
            userId: string;
            window: DigestWindow;
            lastPeriod: string;
          }>(STATE, { userId: { in: userIds } });

          const lastPeriods = new Map(states.map((s) => [`${s.userId} ${s.window}`, s.lastPeriod]));

          let sent = 0;

          for (const userId of userIds) {
            const entries = byUser.get(userId) ?? [];
            const moment = localMoment(zones.get(userId) ?? "UTC", now);

            for (const window of ["daily", "weekly"] as const) {
              const forWindow = entries.filter((entry) => entry.window === window);
              if (forWindow.length === 0) continue;

              const period = periodKey(window, moment, sendWeekday);
              // Idempotent on the period key, so a cron that runs twice cannot send twice.
              if (lastPeriods.get(`${userId} ${window}`) === period) continue;
              if (!isDue(window, moment, sendHour, sendWeekday)) continue;

              await ctx.send(digestType, {
                to: userId,
                payload: {
                  window,
                  period,
                  items: forWindow.map((entry) => ({
                    type: entry.type,
                    payload: entry.payload,
                    createdAt: entry.createdAt,
                  })),
                },
                dedupeKey: `digest:${window}:${period}:${userId}`,
              });

              await ctx.store.upsert(
                STATE,
                [{ userId, window, lastPeriod: period, updatedAt: new Date() }],
                { onConflict: ["userId", "window"] },
              );

              // Only after the send is recorded: a crash re-sends rather than drops.
              await ctx.store.remove(ENTRY, {
                id: { in: forWindow.map((entry) => entry.id) },
              });

              sent += 1;
            }
          }

          return Response.json({ sent, users: userIds.length });
        },
      },
    ],
  };
}

export type { DigestWindow, LocalMoment } from "./schedule";
export { isDue, localMoment, periodKey } from "./schedule";
