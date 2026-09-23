import { readJsonBody } from "../../core/handler";
import type {
  ChannelDecision,
  EasyPingPlugin,
  PluginInitContext,
  PrepareContext,
  ResolveChannelsContext,
} from "../../core/plugin";
import { DEFAULT_TOKEN_TTL_SECONDS, expiresIn, signToken } from "../../core/tokens";
import type { Channel, Frequency } from "../../core/types";

export const UNSUBSCRIBE_PURPOSE = "unsubscribe";

const TABLE = "notification_preference";

const CHANNELS: readonly Channel[] = ["inApp", "email", "push", "sms", "slack"];
const FREQUENCIES: readonly Frequency[] = ["instant", "daily", "weekly", "off"];

const isChannel = (value: unknown): value is Channel => CHANNELS.includes(value as Channel);
const isFrequency = (value: unknown): value is Frequency =>
  FREQUENCIES.includes(value as Frequency);

export type PreferenceRow = {
  userId: string;
  type: string;
  channel: Channel;
  enabled: boolean;
  frequency: Frequency;
  /** Last explicit change. An unsubscribe token issued before it is refused. */
  updatedAt?: Date;
};

export type PreferencesOptions = {
  /** What an absent row means. Flip to false for opt-in-only notifications. */
  defaultEnabled?: boolean;
  /** Types that ignore preferences entirely: receipts, security alerts. */
  alwaysSend?: readonly string[];
  unsubscribeTtlSeconds?: number;
};

const key = (userId: string, type: string, channel: string) => `${userId} ${type} ${channel}`;

type PreparedPreferences = Map<string, PreferenceRow>;

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

export function preferences(options: PreferencesOptions = {}): EasyPingPlugin<"preferences"> {
  const defaultEnabled = options.defaultEnabled ?? true;
  const alwaysSend = new Set(options.alwaysSend ?? []);

  // Assigned by init(), which easyPing() runs before any hook or route.
  let ctx: PluginInitContext;

  const isAllowed = (userId: string, type: string, channel: Channel, rows: PreparedPreferences) => {
    const row = rows.get(key(userId, type, channel));
    return row ? row.enabled && row.frequency !== "off" : defaultEnabled;
  };

  const load = (userIds: readonly string[]) =>
    ctx.store.find<PreferenceRow>(TABLE, { userId: { in: [...userIds] } });

  const save = (row: PreferenceRow) =>
    ctx.store.upsert(TABLE, [{ ...row, updatedAt: new Date() }], {
      onConflict: ["userId", "type", "channel"],
    });

  return {
    id: "preferences",

    init: (context) => {
      ctx = context;
    },

    schema: {
      notificationPreference: {
        tableName: TABLE,
        fields: {
          userId: { type: "string", required: true },
          type: { type: "string", required: true },
          channel: { type: "string", required: true },
          enabled: { type: "boolean", required: true, default: true },
          frequency: { type: "string", required: true, default: "instant" },
          updatedAt: { type: "date", required: true, defaultNow: true },
        },
        primaryKey: ["userId", "type", "channel"],
      },
    },

    hooks: {
      /** One query per send; doing this per recipient would be an N+1. */
      prepare: async (context: PrepareContext): Promise<PreparedPreferences> => {
        if (alwaysSend.has(context.type)) return new Map();

        const rows = await load(context.recipients.map((recipient) => recipient.userId));
        return new Map(rows.map((row) => [key(row.userId, row.type, row.channel), row]));
      },

      resolveChannels: (context: ResolveChannelsContext) => {
        if (alwaysSend.has(context.type)) return context.decisions;

        // prepare() failed: fail closed rather than assume everyone opted in.
        if (!(context.prepared instanceof Map)) {
          return context.decisions.map((decision) => ({ ...decision, action: "skip" as const }));
        }

        const rows = context.prepared as PreparedPreferences;

        return context.decisions.map<ChannelDecision>((decision) =>
          isAllowed(context.recipient.userId, context.type, decision.channel, rows)
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
          const rows = await load([userId ?? ""]);
          return Response.json({ preferences: rows, defaultEnabled });
        },
      },

      {
        path: "/preferences",
        method: "POST",
        scope: { type: "user" },
        handler: async ({ request, userId }) => {
          const parsed = await readJsonBody(request);
          if ("error" in parsed) return parsed.error;
          const body = parsed.body;

          const bad = (error: string) => Response.json({ error }, { status: 400 });

          // Only configured types, or every invented string becomes a row.
          if (typeof body.type !== "string" || !ctx.notificationTypes.includes(body.type)) {
            return bad("type must be a configured notification type");
          }
          if (!isChannel(body.channel)) return bad(`channel must be one of ${CHANNELS.join(", ")}`);
          if (body.enabled !== undefined && typeof body.enabled !== "boolean") {
            return bad("enabled must be a boolean");
          }
          if (body.frequency !== undefined && !isFrequency(body.frequency)) {
            return bad(`frequency must be one of ${FREQUENCIES.join(", ")}`);
          }

          // userId comes from the resolved session, never from the body.
          await save({
            userId: userId ?? "",
            type: body.type,
            channel: body.channel,
            enabled: body.enabled ?? true,
            frequency: body.frequency ?? "instant",
          });

          return Response.json({ ok: true });
        },
      },

      {
        // No session in a mail client; the link carries the proof.
        path: "/unsubscribe",
        method: "POST",
        scope: { type: "signed", purpose: UNSUBSCRIBE_PURPOSE },
        handler: async ({ claims }) => {
          const type = claims?.data?.type;
          const channel = claims?.data?.channel;
          if (!claims || !type || !isChannel(channel)) {
            return Response.json({ error: "invalid token" }, { status: 400 });
          }

          const [current] = await ctx.store.find<PreferenceRow>(
            TABLE,
            { userId: claims.uid, type, channel },
            { limit: 1 },
          );

          // Already off: a second click, or a mail client retrying, is fine.
          if (current && !current.enabled && current.frequency === "off") {
            return Response.json({ ok: true, unsubscribed: { type, channel } });
          }

          // Changed after the email went out: an old link must not undo a newer decision.
          if (
            current?.updatedAt &&
            claims.iat !== undefined &&
            current.updatedAt.getTime() > (claims.iat + 1) * 1000
          ) {
            return Response.json({ error: "invalid token" }, { status: 400 });
          }

          await save({
            userId: claims.uid,
            type,
            channel,
            enabled: false,
            frequency: "off",
          });

          // One-click (Gmail, Yahoo) requires the POST itself to unsubscribe.
          return Response.json({ ok: true, unsubscribed: { type, channel } });
        },
      },
    ],
  };
}
