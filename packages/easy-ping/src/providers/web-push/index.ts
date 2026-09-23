import type { PushMessage, PushProvider, PushSendResult } from "../../plugins/push";
import {
  encryptPayload,
  InvalidSubscriptionError,
  MAX_PAYLOAD_BYTES,
  type VapidKeys,
  vapidAuthorization,
} from "./crypto";

export type WebPushOptions = {
  /** "mailto:you@example.com" or an https URL. Push services require it. */
  subject: string;
  vapid: VapidKeys;
  /** How long the service should hold an undelivered message. */
  ttlSeconds?: number;
  urgency?: "very-low" | "low" | "normal" | "high";
  fetch?: typeof globalThis.fetch;
  /** Lets an http endpoint through. For a local fake push service only; never in production. */
  allowInsecureEndpoints?: boolean;
};

/** Web push over Web Crypto. Gone endpoints surface as `expired`; transport failures as `retryable`. */
export function webPush(options: WebPushOptions): PushProvider {
  const doFetch = options.fetch ?? globalThis.fetch;
  const ttl = options.ttlSeconds ?? 12 * 3600;

  return {
    name: "web-push",

    async send(message: PushMessage): Promise<PushSendResult> {
      const payload = new TextEncoder().encode(
        JSON.stringify({
          title: message.title,
          body: message.body,
          data: message.data ?? {},
        }),
      );

      if (payload.length > MAX_PAYLOAD_BYTES) {
        // Truncating would deliver a broken notification; retrying cannot help.
        throw new Error(
          `push payload is ${payload.length} bytes, over the ${MAX_PAYLOAD_BYTES} byte limit`,
        );
      }

      // Unusable subscription: report invalid so it is pruned, not retried.
      let endpoint: URL;
      try {
        endpoint = new URL(message.subscription.endpoint);
      } catch {
        return { invalid: true };
      }
      const secure = endpoint.protocol === "https:";
      if (!secure && !(options.allowInsecureEndpoints && endpoint.protocol === "http:")) {
        return { invalid: true };
      }

      let encrypted: Awaited<ReturnType<typeof encryptPayload>>;
      try {
        encrypted = await encryptPayload(
          payload,
          message.subscription.keys.p256dh,
          message.subscription.keys.auth,
        );
      } catch (error) {
        if (error instanceof InvalidSubscriptionError) return { invalid: true };
        throw error;
      }

      const authorization = await vapidAuthorization(endpoint.href, {
        subject: options.subject,
        keys: options.vapid,
      });

      let response: Response;
      try {
        response = await doFetch(message.subscription.endpoint, {
          method: "POST",
          headers: {
            Authorization: authorization,
            "Content-Encoding": "aes128gcm",
            "Content-Type": "application/octet-stream",
            TTL: String(ttl),
            ...(options.urgency ? { Urgency: options.urgency } : {}),
          },
          body: encrypted.body,
          ...(message.signal ? { signal: message.signal } : {}),
        });
      } catch (error) {
        // Never reached the service: DNS, socket, timeout.
        throw new Error(error instanceof Error ? error.message : String(error));
      }

      // 201 is the documented success; 200/202 appear in the wild.
      if (response.ok) return {};

      // The subscription is permanently gone and must be pruned.
      if (response.status === 404 || response.status === 410) return { expired: true };

      if (response.status === 429 || response.status === 408 || response.status >= 500) {
        return { retryable: true };
      }

      const detail = await response.text().catch(() => "");
      throw new Error(
        `push service responded ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`,
      );
    },
  };
}

export type { VapidKeys } from "./crypto";
export { generateVapidKeys, InvalidSubscriptionError, MAX_PAYLOAD_BYTES } from "./crypto";
