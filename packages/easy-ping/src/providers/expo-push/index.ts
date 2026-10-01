export type MobilePushMessage = {
  /** The device's push token as the app registered it. */
  token: string;
  title: string;
  body: string;
  data?: Record<string, unknown> | undefined;
  badge?: number | undefined;
  /** "default" plays the platform sound; null is silent. */
  sound?: "default" | null | undefined;
  /** Android notification channel id. */
  channelId?: string | undefined;
};

export type MobilePushTicket =
  | { ok: true; ticketId: string | null }
  | {
      ok: false;
      error: string;
      /** The token will never work again (app uninstalled, token rotated). Prune it. */
      gone: boolean;
      retryable: boolean;
    };

export type MobilePushReceipt =
  | { ticketId: string; ok: true }
  | { ticketId: string; ok: false; error: string; gone: boolean };

export type MobilePushProvider = {
  name: string;
  /** True for a token this provider can deliver to. Rejected at registration otherwise. */
  isValidToken(token: string): boolean;
  /** One result per message, in order. Never throws for a per-token failure. */
  send(messages: readonly MobilePushMessage[], signal?: AbortSignal): Promise<MobilePushTicket[]>;
  /**
   * Some services (Expo) accept a message, then learn from APNs/FCM later
   * that the device is gone. Receipts carry that late verdict.
   */
  receipts?(ticketIds: readonly string[], signal?: AbortSignal): Promise<MobilePushReceipt[]>;
};

export type ExpoPushOptions = {
  /** Expo "enhanced security" access token. Optional; when set, requests without it are refused by Expo. */
  accessToken?: string | undefined;
  fetch?: typeof globalThis.fetch | undefined;
  /** Default https://exp.host. A local fake for tests. */
  apiBase?: string | undefined;
  timeoutMs?: number | undefined;
};

type ExpoTicket =
  | { status: "ok"; id: string }
  | { status: "error"; message?: string; details?: { error?: string } };

type ExpoReceipt =
  | { status: "ok" }
  | { status: "error"; message?: string; details?: { error?: string } };

/** Expo tokens look like ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx] or ExpoPushToken[...]. */
export const isExpoPushToken = (token: string): boolean =>
  /^Expo(nent)?PushToken\[[A-Za-z0-9_-]{8,64}\]$/.test(token);

/** Expo's send endpoint takes at most this many messages per request. */
export const EXPO_SEND_BATCH = 100;
/** And its receipts endpoint at most this many ids. */
export const EXPO_RECEIPT_BATCH = 1000;

// Expo's error codes, per https://docs.expo.dev/push-notifications/sending-notifications/#individual-errors
const GONE = new Set(["DeviceNotRegistered"]);
const RETRYABLE = new Set(["MessageRateExceeded", "ProviderError", "ExpoError"]);

const classify = (
  code: string | undefined,
  message: string | undefined,
): { error: string; gone: boolean; retryable: boolean } => ({
  error: code ? `${code}: ${message ?? ""}`.trim() : (message ?? "expo push failed"),
  gone: code !== undefined && GONE.has(code),
  retryable: code !== undefined && RETRYABLE.has(code),
});

/** Expo Push over fetch, so it runs on edge runtimes. Batches, classifies, never throws per token. */
export function expoPush(options: ExpoPushOptions = {}): MobilePushProvider {
  const doFetch = options.fetch ?? globalThis.fetch;
  const base = (options.apiBase ?? "https://exp.host").replace(/\/$/, "");
  const timeoutMs = options.timeoutMs ?? 10_000;
  const redact = (text: string) =>
    options.accessToken ? text.split(options.accessToken).join("<token>") : text;

  async function post<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
    const timeout = AbortSignal.timeout(timeoutMs);
    const headers: Record<string, string> = {
      accept: "application/json",
      "content-type": "application/json",
    };
    if (options.accessToken) headers.authorization = `Bearer ${options.accessToken}`;
    const response = await doFetch(`${base}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!response.ok) {
      const text = redact((await response.text().catch(() => "")).slice(0, 200));
      const error = new Error(`expo push ${path} failed: HTTP ${response.status} ${text}`.trim());
      (error as { status?: number }).status = response.status;
      throw error;
    }
    return (await response.json()) as T;
  }

  const transportFailure = (error: unknown): MobilePushTicket => {
    const status = (error as { status?: number })?.status;
    const message = redact(error instanceof Error ? error.message : String(error));
    // 4xx from the service itself (bad access token, malformed request) cannot be fixed by retrying.
    const retryable = status === undefined || status === 429 || status >= 500;
    return { ok: false, error: message, gone: false, retryable };
  };

  return {
    name: "expo-push",
    isValidToken: isExpoPushToken,

    async send(messages, signal) {
      const results: MobilePushTicket[] = [];
      for (let start = 0; start < messages.length; start += EXPO_SEND_BATCH) {
        const batch = messages.slice(start, start + EXPO_SEND_BATCH);
        let tickets: ExpoTicket[];
        try {
          const response = await post<{ data: ExpoTicket[] }>(
            "/--/api/v2/push/send",
            batch.map((message) => ({
              to: message.token,
              title: message.title,
              body: message.body,
              ...(message.data ? { data: message.data } : {}),
              ...(message.badge === undefined ? {} : { badge: message.badge }),
              ...(message.sound === undefined ? { sound: "default" } : { sound: message.sound }),
              ...(message.channelId ? { channelId: message.channelId } : {}),
            })),
            signal,
          );
          tickets = response.data;
        } catch (error) {
          const failure = transportFailure(error);
          for (const _ of batch) results.push(failure);
          continue;
        }
        batch.forEach((_, index) => {
          const ticket = tickets[index];
          if (!ticket) {
            results.push({ ok: false, error: "no ticket returned", gone: false, retryable: true });
          } else if (ticket.status === "ok") {
            results.push({ ok: true, ticketId: ticket.id ?? null });
          } else {
            results.push({ ok: false, ...classify(ticket.details?.error, ticket.message) });
          }
        });
      }
      return results;
    },

    async receipts(ticketIds, signal) {
      const out: MobilePushReceipt[] = [];
      for (let start = 0; start < ticketIds.length; start += EXPO_RECEIPT_BATCH) {
        const ids = ticketIds.slice(start, start + EXPO_RECEIPT_BATCH);
        const response = await post<{ data: Record<string, ExpoReceipt> }>(
          "/--/api/v2/push/getReceipts",
          { ids },
          signal,
        );
        for (const [ticketId, receipt] of Object.entries(response.data ?? {})) {
          if (receipt.status === "ok") out.push({ ticketId, ok: true });
          else {
            const { error, gone } = classify(receipt.details?.error, receipt.message);
            out.push({ ticketId, ok: false, error, gone });
          }
        }
      }
      return out;
    },
  };
}
