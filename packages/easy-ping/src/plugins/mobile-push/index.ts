import type { DeliveryOutcome } from "../../core/adapter";
import { readJsonBody } from "../../core/handler";
import type {
  DeliverContext,
  EasyPingPlugin,
  PluginInitContext,
  RouteDefinition,
  SchemaDeclaration,
} from "../../core/plugin";
import type { MobilePushMessage, MobilePushProvider } from "../../providers/expo-push";

const DEVICE = "notification_mobile_push_device";
const TICKET = "notification_mobile_push_ticket";

export type MobilePushPlatform = "ios" | "android" | "web";

export type MobilePushDevice = {
  id: string;
  userId: string;
  token: string;
  platform: MobilePushPlatform;
  deviceName: string | null;
  createdAt: Date;
  lastSeenAt: Date;
};

export type MobilePushTicketRow = {
  id: string;
  deviceId: string;
  createdAt: Date;
};

export type MobilePushRendered = Omit<MobilePushMessage, "token">;

export type MobilePushOptions = {
  provider: MobilePushProvider;
  /** What the OS notification shows. `data` rides along to the app's tap handler. */
  render: (input: { type: string; payload: unknown }) => MobilePushRendered;
  /** Devices untouched for this long are pruned by POST /mobile-push/prune. Default 180 days. */
  staleAfterDays?: number | undefined;
  /** Registering past this evicts the user's least recently seen device. Default 20. */
  maxDevicesPerUser?: number | undefined;
};

const PLATFORMS: readonly MobilePushPlatform[] = ["ios", "android", "web"];

const MAX_TOKEN_LENGTH = 512;

/** The tables this plugin owns, exported so DDL needs no plugin instance. */
export const mobilePushSchema = {
  mobilePushDevice: {
    tableName: DEVICE,
    fields: {
      id: { type: "string", required: true },
      userId: { type: "string", required: true },
      token: { type: "string", required: true },
      platform: { type: "string", required: true },
      deviceName: { type: "string" },
      createdAt: { type: "date", required: true, defaultNow: true },
      lastSeenAt: { type: "date", required: true, defaultNow: true },
    },
    primaryKey: ["id"],
    indexes: [
      { on: ["userId"], name: "mobile_push_device_user_idx" },
      // One row per token: re-registering updates instead of duplicating.
      { on: ["token"], unique: true, name: "mobile_push_device_token_idx" },
    ],
  },
  mobilePushTicket: {
    tableName: TICKET,
    fields: {
      id: { type: "string", required: true },
      deviceId: { type: "string", required: true },
      createdAt: { type: "date", required: true, defaultNow: true },
    },
    primaryKey: ["id"],
    indexes: [{ on: ["createdAt"], name: "mobile_push_ticket_created_idx" }],
  },
} as const satisfies SchemaDeclaration;

const isDuplicate = (error: unknown): boolean => {
  const code = (error as { code?: unknown })?.code;
  if (code === "23505" || code === 11000) return true;
  const text = error instanceof Error ? error.message : String(error);
  return /duplicate|unique/i.test(text);
};

export type MobilePushPlugin = EasyPingPlugin<"mobilePush", typeof mobilePushSchema> & {
  /**
   * Asks the provider for the verdict on accepted messages and prunes devices
   * it reports gone. Expo learns "device not registered" from APNs/FCM only
   * after accepting the message, so this is where uninstalls are caught.
   * Also mounted as POST /mobile-push/receipts for the cron.
   */
  checkReceipts(): Promise<{ checked: number; pruned: number }>;
};

/** Native push through a token registry. Fans out per device; dead tokens are pruned on the spot or by receipt. */
export function mobilePush(options: MobilePushOptions): MobilePushPlugin {
  let ctx: PluginInitContext;
  const staleAfterDays = options.staleAfterDays ?? 180;
  const maxDevices = Math.max(1, options.maxDevicesPerUser ?? 20);

  async function checkReceipts() {
    if (!options.provider.receipts) return { checked: 0, pruned: 0 };
    const tickets = await ctx.store.find<MobilePushTicketRow>(
      TICKET,
      {},
      { orderBy: { field: "createdAt", direction: "asc" }, limit: 1000 },
    );
    if (tickets.length === 0) return { checked: 0, pruned: 0 };

    const receipts = await options.provider.receipts(tickets.map((ticket) => ticket.id));
    const byTicket = new Map(tickets.map((ticket) => [ticket.id, ticket.deviceId]));
    const gone = receipts.flatMap((receipt) =>
      !receipt.ok && receipt.gone ? [byTicket.get(receipt.ticketId) ?? ""] : [],
    );
    const settled = receipts.map((receipt) => receipt.ticketId);

    if (gone.length > 0) await ctx.store.remove(DEVICE, { id: { in: gone.filter(Boolean) } });
    if (settled.length > 0) await ctx.store.remove(TICKET, { id: { in: settled } });
    // Receipts the service has already forgotten (older than a day) would sit forever.
    const cutoff = new Date(Date.now() - 24 * 3_600_000);
    await ctx.store.remove(TICKET, { createdAt: { lt: cutoff } });

    return { checked: settled.length, pruned: gone.length };
  }

  const routes: RouteDefinition[] = [
    {
      path: "/mobile-push/devices",
      method: "POST",
      scope: { type: "user" },
      handler: async ({ request, userId }) => {
        const parsed = await readJsonBody(request);
        if ("error" in parsed) return parsed.error;

        const { token, platform, deviceName } = parsed.body as {
          token?: unknown;
          platform?: unknown;
          deviceName?: unknown;
        };
        if (
          typeof token !== "string" ||
          token.length > MAX_TOKEN_LENGTH ||
          !options.provider.isValidToken(token)
        ) {
          return Response.json(
            { error: `token is not a valid ${options.provider.name} push token` },
            { status: 400 },
          );
        }
        if (typeof platform !== "string" || !PLATFORMS.includes(platform as MobilePushPlatform)) {
          return Response.json(
            { error: `platform must be one of ${PLATFORMS.join(", ")}` },
            { status: 400 },
          );
        }
        const name = typeof deviceName === "string" ? deviceName.slice(0, 120) : null;
        const owner = userId ?? "";
        const now = new Date();

        // A token belongs to one account for life; upserting on token alone would let anyone re-home it.
        const [existing] = await ctx.store.find<MobilePushDevice>(DEVICE, { token }, { limit: 1 });
        if (existing && existing.userId !== owner) {
          return Response.json(
            { error: "token is registered to another account" },
            { status: 409 },
          );
        }
        if (existing) {
          await ctx.store.update(
            DEVICE,
            { id: existing.id },
            { platform, deviceName: name, lastSeenAt: now },
          );
          return Response.json({ ok: true });
        }

        const devices = await ctx.store.find<MobilePushDevice>(
          DEVICE,
          { userId: owner },
          { orderBy: { field: "lastSeenAt", direction: "asc" } },
        );
        const excess = devices.length - maxDevices + 1;
        if (excess > 0) {
          await ctx.store.remove(DEVICE, {
            id: { in: devices.slice(0, excess).map((device) => device.id) },
          });
        }
        try {
          await ctx.store.insert(DEVICE, [
            {
              id: crypto.randomUUID(),
              userId: owner,
              token,
              platform,
              deviceName: name,
              createdAt: now,
              lastSeenAt: now,
            },
          ]);
        } catch (error) {
          if (isDuplicate(error)) {
            return Response.json(
              { error: "token is registered to another account" },
              { status: 409 },
            );
          }
          throw error;
        }
        return Response.json({ ok: true });
      },
    },
    {
      path: "/mobile-push/devices",
      method: "GET",
      scope: { type: "user" },
      handler: async ({ userId }) => {
        const devices = await ctx.store.find<MobilePushDevice>(
          DEVICE,
          { userId: userId ?? "" },
          { orderBy: { field: "lastSeenAt", direction: "desc" } },
        );
        return Response.json({
          devices: devices.map((device) => ({
            platform: device.platform,
            deviceName: device.deviceName,
            // The token itself is not returned: it is a capability, not a label.
            tokenSuffix: device.token.slice(-6),
            lastSeenAt: device.lastSeenAt.toISOString(),
          })),
        });
      },
    },
    {
      path: "/mobile-push/devices/remove",
      method: "POST",
      scope: { type: "user" },
      handler: async ({ request, userId }) => {
        const parsed = await readJsonBody(request);
        if ("error" in parsed) return parsed.error;
        const { token } = parsed.body;
        if (typeof token !== "string" || token === "") {
          return Response.json({ error: "token is required" }, { status: 400 });
        }
        const removed = await ctx.store.remove(DEVICE, { userId: userId ?? "", token });
        return removed === 0 ? new Response(null, { status: 404 }) : Response.json({ ok: true });
      },
    },
    {
      path: "/mobile-push/receipts",
      method: "POST",
      scope: { type: "machine" },
      handler: async () => Response.json(await checkReceipts()),
    },
    {
      path: "/mobile-push/prune",
      method: "POST",
      scope: { type: "machine" },
      handler: async () => {
        const cutoff = new Date(Date.now() - staleAfterDays * 86_400_000);
        const removed = await ctx.store.remove(DEVICE, { lastSeenAt: { lt: cutoff } });
        return Response.json({ removed });
      },
    },
  ];

  return {
    id: "mobilePush",
    channels: ["mobilePush"],
    schema: mobilePushSchema,

    init: (context) => {
      ctx = context;
    },

    hooks: {
      deliver: async (context: DeliverContext): Promise<DeliveryOutcome> => {
        const devices = await ctx.store.find<MobilePushDevice>(DEVICE, {
          userId: context.notification.userId,
        });
        if (devices.length === 0) return { result: "skipped", reason: "no registered devices" };

        const rendered = options.render({
          type: context.notification.type,
          payload: context.notification.payload,
        });
        const data = {
          ...rendered.data,
          notificationId: context.notification.id,
          type: context.notification.type,
        };

        const tickets = await options.provider.send(
          devices.map((device) => ({ ...rendered, data, token: device.token })),
          context.signal,
        );

        const prune: string[] = [];
        const accepted: { id: string; deviceId: string; createdAt: Date }[] = [];
        let delivered = 0;
        let retryable = false;
        let lastError = "";
        const now = new Date();

        tickets.forEach((ticket, index) => {
          const device = devices[index];
          if (!device) return;
          if (ticket.ok) {
            delivered += 1;
            if (ticket.ticketId)
              accepted.push({ id: ticket.ticketId, deviceId: device.id, createdAt: now });
            return;
          }
          lastError = ticket.error;
          if (ticket.gone) prune.push(device.id);
          else if (ticket.retryable) retryable = true;
        });

        if (prune.length > 0) await ctx.store.remove(DEVICE, { id: { in: prune } });
        if (accepted.length > 0 && options.provider.receipts) {
          // Best effort: a failed bookkeeping insert must not fail a delivered push.
          await ctx.store
            .insert(TICKET, accepted)
            .catch((error) =>
              ctx.logger.warn(`mobile push: could not record tickets: ${String(error)}`),
            );
        }

        if (delivered > 0) return { result: "sent" };
        if (prune.length === devices.length) {
          return { result: "failed", error: "every device token is gone", retryable: false };
        }
        return { result: "failed", error: lastError || "no device accepted the push", retryable };
      },
    },

    routes,
    checkReceipts,
  };
}
