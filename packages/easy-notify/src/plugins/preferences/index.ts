import type { DatabaseAdapter, PreferenceRecord } from "../../core/adapter";
import type {
  ChannelDecision,
  EasyNotifyPlugin,
  PrepareContext,
  ResolveChannelsContext,
} from "../../core/plugin";
import { DEFAULT_TOKEN_TTL_SECONDS, expiresIn, signToken } from "../../core/tokens";
import type { Channel, Frequency } from "../../core/types";

export const UNSUBSCRIBE_PURPOSE = "unsubscribe";

export type PreferencesOptions = {
  database: DatabaseAdapter;
  /** Signs unsubscribe links. Use the same value as the top-level config. */
  secret: string;
  /** What an absent row means. Flip to false for opt-in-only notifications. */
  defaultEnabled?: boolean;
  /** Types that ignore preferences entirely: receipts, security alerts. */
  alwaysSend?: readonly string[];
  unsubscribeTtlSeconds?: number;
};

const key = (userId: string, type: string, channel: string) => `${userId} ${type} ${channel}`;

type PreparedPreferences = Map<string, PreferenceRecord>;

export function buildUnsubscribeToken(
  secret: string,
  userId: string,
  type: string,
  channel: Channel,
  ttlSeconds = DEFAULT_TOKEN_TTL_SECONDS,
): Promise<string> {
  return signToken(secret, {
    uid: userId,
    purpose: UNSUBSCRIBE_PURPOSE,
    exp: expiresIn(ttlSeconds),
    data: { type, channel },
  });
}

export function preferences(options: PreferencesOptions): EasyNotifyPlugin<"preferences"> {
  const defaultEnabled = options.defaultEnabled ?? true;
  const alwaysSend = new Set(options.alwaysSend ?? []);

  const isAllowed = (userId: string, type: string, channel: Channel, rows: PreparedPreferences) => {
    const row = rows.get(key(userId, type, channel));
    return row ? row.enabled && row.frequency !== "off" : defaultEnabled;
  };

  return {
    id: "preferences",

    schema: {
      notificationPreference: {
        tableName: "notification_preference",
        fields: {
          userId: { type: "string", required: true },
          type: { type: "string", required: true },
          channel: { type: "string", required: true },
          enabled: { type: "boolean", required: true, default: true },
          frequency: { type: "string", required: true, default: "instant" },
        },
        primaryKey: ["userId", "type", "channel"],
      },
    },

    hooks: {
      /** One query per send; doing this per recipient would be an N+1. */
      prepare: async (ctx: PrepareContext): Promise<PreparedPreferences> => {
        if (alwaysSend.has(ctx.type)) return new Map();

        const rows = await options.database.listPreferences(
          ctx.recipients.map((recipient) => recipient.userId),
        );

        return new Map(rows.map((row) => [key(row.userId, row.type, row.channel), row]));
      },

      resolveChannels: (ctx: ResolveChannelsContext) => {
        if (alwaysSend.has(ctx.type)) return ctx.decisions;

        // prepare() failing leaves this undefined. Fail closed rather than
        // assuming everyone opted in: that is exactly how people who
        // unsubscribed get emailed anyway. RFC 0004 section 5.
        if (!(ctx.prepared instanceof Map)) {
          return ctx.decisions.map((decision) => ({ ...decision, action: "skip" as const }));
        }

        const rows = ctx.prepared as PreparedPreferences;

        return ctx.decisions.map<ChannelDecision>((decision) =>
          isAllowed(ctx.recipient.userId, ctx.type, decision.channel, rows)
            ? decision
            : { ...decision, action: "skip" },
        );
      },
    },

    routes: [
      {
        path: "/preferences",
        method: "GET",
        scope: { type: "user" },
        handler: async ({ userId }) => {
          const rows = await options.database.listPreferences([userId ?? ""]);
          return Response.json({ preferences: rows, defaultEnabled });
        },
      },

      {
        path: "/preferences",
        method: "POST",
        scope: { type: "user" },
        handler: async ({ request, userId }) => {
          const body = (await request.json().catch(() => null)) as {
            type?: string;
            channel?: Channel;
            enabled?: boolean;
            frequency?: Frequency;
          } | null;

          if (!body?.type || !body.channel) {
            return Response.json({ error: "type and channel are required" }, { status: 400 });
          }

          // userId comes from the resolved session, never from the body.
          await options.database.upsertPreferences([
            {
              userId: userId ?? "",
              type: body.type,
              channel: body.channel,
              enabled: body.enabled ?? true,
              frequency: body.frequency ?? "instant",
            },
          ]);

          return Response.json({ ok: true });
        },
      },

      {
        // Reached from a mail client with no session, so it is authenticated
        // by the signature on the link itself. RFC 0002 section 5.
        path: "/unsubscribe",
        method: "POST",
        scope: { type: "signed", purpose: UNSUBSCRIBE_PURPOSE },
        handler: async ({ claims }) => {
          // The router verified signature, purpose and expiry before dispatch,
          // so this handler is unreachable without valid claims.
          const type = claims?.data?.type;
          const channel = claims?.data?.channel as Channel | undefined;
          if (!claims || !type || !channel) {
            return Response.json({ error: "invalid token" }, { status: 400 });
          }

          await options.database.upsertPreferences([
            { userId: claims.uid, type, channel, enabled: false, frequency: "off" },
          ]);

          // Gmail and Yahoo one-click requires the POST itself to unsubscribe,
          // with no confirmation page.
          return Response.json({ ok: true, unsubscribed: { type, channel } });
        },
      },
    ],
  };
}
