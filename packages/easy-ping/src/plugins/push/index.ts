import type { DeliveryOutcome } from "../../core/adapter";
import { decodeBase64UrlBytes } from "../../core/base64url";
import { readJsonBody } from "../../core/handler";
import type {
  DeliverContext,
  EasyPingPlugin,
  PluginInitContext,
  SchemaDeclaration,
} from "../../core/plugin";
import { redactErrorMessage } from "../../core/runner";

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
  /** True when the subscription can never work — bad keys, unusable endpoint. Pruned like expired. */
  invalid?: boolean;
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
  /** Registering past this evicts the user's least recently seen device. Default 20. */
  maxDevicesPerUser?: number;
  /** Hostnames an endpoint may point at, e.g. `["fcm.googleapis.com", "*.notify.windows.com"]`. Unset allows any public https host. */
  allowedEndpointHosts?: readonly string[];
  /** Accepts http and private hosts. For a local fake push service only; never in production. */
  allowInsecureEndpoints?: boolean;
};

/** The tables this plugin owns, exported so DDL needs no plugin instance. */
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
      // One row per endpoint: re-registering updates instead of duplicating.
      { on: ["endpoint"], unique: true, name: "push_device_endpoint_idx" },
    ],
  },
} as const satisfies SchemaDeclaration;

const PRIVATE_IPV4 =
  /^(0\.|10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/;

function isInternalHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === "localhost" || /\.(localhost|local|internal|lan)$/.test(host)) return true;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return PRIVATE_IPV4.test(host);
  if (host.startsWith("[")) {
    const v6 = host.slice(1, -1);
    return v6 === "::1" || v6 === "::" || /^(fc|fd|fe[89ab])/.test(v6) || v6.startsWith("::ffff:");
  }
  return false;
}

const hostAllowed = (host: string, allowed: readonly string[]) =>
  allowed.some((entry) =>
    entry.startsWith("*.") ? host.endsWith(entry.slice(1)) : host === entry.toLowerCase(),
  );

/** The SSRF boundary: the server POSTs to whatever is stored here. */
export function validateEndpoint(
  endpoint: string,
  allowedHosts?: readonly string[] | undefined,
  allowInsecure = false,
): string | null {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return "endpoint is not a valid URL";
  }
  if (url.username || url.password) return "endpoint must not carry credentials";
  if (!allowInsecure) {
    if (url.protocol !== "https:") return "endpoint must use https";
    if (isInternalHost(url.hostname)) return "endpoint must be a public host";
  } else if (url.protocol !== "https:" && url.protocol !== "http:") {
    return "endpoint must be an http(s) URL";
  }
  if (allowedHosts && !hostAllowed(url.hostname.toLowerCase(), allowedHosts)) {
    return "endpoint host is not an allowed push service";
  }
  return null;
}

/** RFC 8291: an uncompressed P-256 point and a 16-byte auth secret. */
export function validateSubscriptionKeys(keys: { p256dh: string; auth: string }): string | null {
  const p256dh = decodeBase64UrlBytes(keys.p256dh);
  if (p256dh?.length !== 65 || p256dh[0] !== 0x04) {
    return "keys.p256dh must be a 65-byte uncompressed EC point";
  }
  const auth = decodeBase64UrlBytes(keys.auth);
  if (auth?.length !== 16) return "keys.auth must be 16 bytes";
  return null;
}

const isDuplicate = (error: unknown): boolean => {
  const code = (error as { code?: unknown })?.code;
  if (code === "23505" || code === 11000) return true;
  const text = error instanceof Error ? error.message : String(error);
  return /duplicate|unique/i.test(text);
};

/** Web push over the device registry. Fans out per device; gone endpoints are pruned immediately. */
export function push(options: PushOptions): EasyPingPlugin<"push"> {
  let ctx: PluginInitContext;
  const staleAfterDays = options.staleAfterDays ?? 180;
  const maxDevices = Math.max(1, options.maxDevicesPerUser ?? 20);

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

        // In parallel: one dead endpoint must not hold the sweep to the timeout.
        const results = await Promise.allSettled(
          devices.map((device) =>
            options.provider.send({
              subscription: {
                endpoint: device.endpoint,
                keys: { p256dh: device.p256dh, auth: device.auth },
              },
              ...content,
              data: { notificationId: context.notification.id, type: context.notification.type },
              signal: context.signal,
            }),
          ),
        );

        const prune: string[] = [];
        let delivered = 0;
        let retryable = false;
        let lastError = "";

        results.forEach((result, index) => {
          const device = devices[index];
          if (!device) return;

          if (result.status === "rejected") {
            lastError = redactErrorMessage(
              result.reason instanceof Error ? result.reason.message : String(result.reason),
            );
            retryable = true;
            return;
          }

          if (result.value.expired || result.value.invalid) prune.push(device.id);
          else if (result.value.retryable) retryable = true;
          else delivered += 1;
        });

        if (prune.length > 0) await ctx.store.remove(DEVICE, { id: { in: prune } });

        if (delivered > 0) return { result: "sent" };

        // Every endpoint was gone: retrying cannot help, and the rows are
        // already deleted.
        if (prune.length === devices.length) {
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
          const parsed = await readJsonBody(request);
          if ("error" in parsed) return parsed.error;

          const { endpoint, keys } = parsed.body as Partial<PushSubscription>;
          if (
            typeof endpoint !== "string" ||
            typeof keys?.p256dh !== "string" ||
            typeof keys?.auth !== "string"
          ) {
            return Response.json({ error: "endpoint and keys are required" }, { status: 400 });
          }

          const problem =
            validateEndpoint(
              endpoint,
              options.allowedEndpointHosts,
              options.allowInsecureEndpoints ?? false,
            ) ?? validateSubscriptionKeys(keys);
          if (problem) return Response.json({ error: problem }, { status: 400 });

          const owner = userId ?? "";
          const now = new Date();
          const userAgent = request.headers.get("user-agent")?.slice(0, 512) ?? null;

          // An endpoint belongs to one account for life; upserting on endpoint alone let anyone re-home it.
          const [existing] = await ctx.store.find<PushDevice>(DEVICE, { endpoint }, { limit: 1 });

          if (existing && existing.userId !== owner) {
            return Response.json(
              { error: "endpoint is registered to another account" },
              { status: 409 },
            );
          }

          if (existing) {
            await ctx.store.update(
              DEVICE,
              { id: existing.id },
              { p256dh: keys.p256dh, auth: keys.auth, userAgent, lastSeenAt: now },
            );
            return Response.json({ ok: true });
          }

          const devices = await ctx.store.find<PushDevice>(
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
                endpoint,
                p256dh: keys.p256dh,
                auth: keys.auth,
                userAgent,
                createdAt: now,
                lastSeenAt: now,
              },
            ]);
          } catch (error) {
            // Lost the race to the unique index: someone registered it first.
            if (isDuplicate(error)) {
              return Response.json(
                { error: "endpoint is registered to another account" },
                { status: 409 },
              );
            }
            throw error;
          }

          return Response.json({ ok: true });
        },
      },

      {
        path: "/push/devices/remove",
        method: "POST",
        scope: { type: "user" },
        handler: async ({ request, userId }) => {
          const parsed = await readJsonBody(request);
          if ("error" in parsed) return parsed.error;

          const { endpoint } = parsed.body;
          if (typeof endpoint !== "string" || endpoint === "") {
            return Response.json({ error: "endpoint is required" }, { status: 400 });
          }

          // Scoped by userId too: an endpoint string is not a secret.
          const removed = await ctx.store.remove(DEVICE, { userId: userId ?? "", endpoint });

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
