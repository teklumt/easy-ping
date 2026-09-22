import type { DeliveryOutcome } from "../../core/adapter";
import type {
  DeliverContext,
  EasyPingPlugin,
  PluginInitContext,
  SchemaDeclaration,
} from "../../core/plugin";

const DEVICE = "notification_push_device";

export type PushSubscription = {
  endpoint: string;
  keys: { p256dh: string; auth: string };
};

export type PushMessage = {
  subscription: PushSubscription;
  title: string;
  body: string;
  data?: Record<string, unknown> | undefined;
  signal?: AbortSignal | undefined;
};

export type PushSendResult = {
  /** True when the endpoint is permanently gone (404/410) and must be pruned. */
  expired?: boolean;
  retryable?: boolean;
};

export type PushProvider = {
  name: string;
  send(message: PushMessage): Promise<PushSendResult>;
};

export type PushDevice = {
  id: string;
  userId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent: string | null;
  createdAt: Date;
  lastSeenAt: Date;
};

export type PushOptions = {
  provider: PushProvider;
  /** Builds the notification shown on the device. */
  render: (input: { type: string; payload: unknown }) => { title: string; body: string };
  /** Devices untouched for this long are pruned on next delivery. */
  staleAfterDays?: number;
};

/**
 * Web push over the device registry.
 *
 * Tokens are per device, not per user, so a delivery fans out and succeeds if
 * any endpoint accepts. Endpoints that report themselves gone are deleted
 * immediately: an unpruned registry accumulates dead subscriptions forever and
 * every send slows down behind them.
 */
/**
 * The tables this plugin owns, as a standalone value.
 *
 * Exported separately from `push()` so DDL can be rendered without building a
 * plugin instance — otherwise creating the tables means inventing a provider
 * and a render function you never intend to call.
 */
export const pushSchema = {
  pushDevice: {
    tableName: DEVICE,
    fields: {
      id: { type: "string", required: true },
      userId: { type: "string", required: true },
      endpoint: { type: "string", required: true },
      p256dh: { type: "string", required: true },
      auth: { type: "string", required: true },
      userAgent: { type: "string" },
      createdAt: { type: "date", required: true, defaultNow: true },
      lastSeenAt: { type: "date", required: true, defaultNow: true },
    },
    primaryKey: ["id"],
    indexes: [
      { on: ["userId"], name: "push_device_user_idx" },
      // One row per endpoint: re-registering the same browser must update,
      // not duplicate, or every send goes out N times to one device.
      { on: ["endpoint"], unique: true, name: "push_device_endpoint_idx" },
    ],
  },
} as const satisfies SchemaDeclaration;

export function push(options: PushOptions): EasyPingPlugin<"push"> {
  let ctx: PluginInitContext;
  const staleAfterDays = options.staleAfterDays ?? 180;

  return {
    id: "push",
    channels: ["push"],

    init: (context) => {
      ctx = context;
    },

    schema: pushSchema,

    hooks: {
      deliver: async (context: DeliverContext): Promise<DeliveryOutcome> => {
        const devices = await ctx.store.find<PushDevice>(DEVICE, {
          userId: context.notification.userId,
        });

        if (devices.length === 0) {
          // Not a failure: this person has simply not enabled push anywhere.
          return { result: "skipped", reason: "no registered devices" };
        }

        const content = options.render({
          type: context.notification.type,
          payload: context.notification.payload,
        });

        const expired: string[] = [];
        let delivered = 0;
        let retryable = false;
        let lastError = "";

        for (const device of devices) {
          try {
            const result = await options.provider.send({
              subscription: {
                endpoint: device.endpoint,
                keys: { p256dh: device.p256dh, auth: device.auth },
              },
              ...content,
              data: { notificationId: context.notification.id, type: context.notification.type },
              signal: context.signal,
            });

            if (result.expired) expired.push(device.id);
            else {
              delivered += 1;
              if (result.retryable) retryable = true;
            }
          } catch (error) {
            lastError = error instanceof Error ? error.message : String(error);
            retryable = true;
          }
        }

        if (expired.length > 0) await ctx.store.remove(DEVICE, { id: { in: expired } });

        if (delivered > 0) return { result: "sent" };

        // Every endpoint was gone: retrying cannot help, and the rows are
        // already deleted.
        if (expired.length === devices.length) {
          return { result: "failed", error: "all devices expired", retryable: false };
        }

        return {
          result: "failed",
          error: lastError || "no device accepted the push",
          retryable,
        };
      },
    },

    routes: [
      {
        path: "/push/devices",
        method: "POST",
        scope: { type: "user" },
        handler: async ({ request, userId }) => {
          const body = (await request.json().catch(() => null)) as PushSubscription | null;
          if (!body?.endpoint || !body.keys?.p256dh || !body.keys?.auth) {
            return Response.json({ error: "endpoint and keys are required" }, { status: 400 });
          }

          // Upsert on endpoint: the same browser re-registering after a
          // service-worker update must not create a second row.
          await ctx.store.upsert(
            DEVICE,
            [
              {
                id: crypto.randomUUID(),
                userId: userId ?? "",
                endpoint: body.endpoint,
                p256dh: body.keys.p256dh,
                auth: body.keys.auth,
                userAgent: request.headers.get("user-agent"),
                createdAt: new Date(),
                lastSeenAt: new Date(),
              },
            ],
            { onConflict: ["endpoint"] },
          );

          return Response.json({ ok: true });
        },
      },

      {
        path: "/push/devices/remove",
        method: "POST",
        scope: { type: "user" },
        handler: async ({ request, userId }) => {
          const body = (await request.json().catch(() => null)) as { endpoint?: string } | null;
          if (!body?.endpoint) {
            return Response.json({ error: "endpoint is required" }, { status: 400 });
          }

          // Scoped by userId as well as endpoint: an endpoint string is not a
          // secret, and must not let one user unregister another's device.
          const removed = await ctx.store.remove(DEVICE, {
            userId: userId ?? "",
            endpoint: body.endpoint,
          });

          return removed === 0 ? new Response(null, { status: 404 }) : Response.json({ ok: true });
        },
      },

      {
        path: "/push/prune",
        method: "POST",
        scope: { type: "machine" },
        handler: async () => {
          const cutoff = new Date(Date.now() - staleAfterDays * 86_400_000);
          const removed = await ctx.store.remove(DEVICE, { lastSeenAt: { lt: cutoff } });
          return Response.json({ removed });
        },
      },
    ],
  };
}
