import type { EmailProvider } from "../../core/provider";

export type ResendOptions = {
  apiKey: string;
  /** Verified sender, e.g. "Acme <notifications@acme.dev>". */
  from: string;
  replyTo?: string;
  timeoutMs?: number;
  /** Overridable for tests. */
  fetch?: typeof globalThis.fetch;
  baseUrl?: string;
};

export class ResendError extends Error {
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "ResendError";
    this.status = status;
  }
}

/** Rate limits, timeouts and 5xx may work later. Auth and validation never will. */
function classify(status: number): boolean {
  if (status === 408 || status === 429) return true;
  return status >= 500;
}

/** Plain fetch, no SDK: it is one POST, and adapters should not add deps. */
export function resend(options: ResendOptions): EmailProvider {
  const doFetch = options.fetch ?? globalThis.fetch;
  const baseUrl = options.baseUrl ?? "https://api.resend.com";

  return {
    name: "resend",
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),

    async send(message) {
      let response: Response;
      try {
        response = await doFetch(`${baseUrl}/emails`, {
          method: "POST",
          ...(message.signal ? { signal: message.signal } : {}),
          headers: {
            Authorization: `Bearer ${options.apiKey}`,
            "Content-Type": "application/json",
            // Delivery is at-least-once; a retry must not send twice.
            "Idempotency-Key": message.idempotencyKey,
          },
          body: JSON.stringify({
            from: options.from,
            to: message.to,
            subject: message.subject,
            html: message.html,
            ...(message.text ? { text: message.text } : {}),
            ...(options.replyTo ? { reply_to: options.replyTo } : {}),
            ...(message.headers ? { headers: message.headers } : {}),
          }),
        });
      } catch (error) {
        // Network-level failure — no status, always worth retrying.
        throw new ResendError(error instanceof Error ? error.message : String(error));
      }

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new ResendError(
          `resend responded ${response.status}${body ? `: ${body.slice(0, 500)}` : ""}`,
          response.status,
        );
      }

      const payload = (await response.json().catch(() => null)) as { id?: string } | null;
      return payload?.id ? { providerMessageId: payload.id } : {};
    },

    isRetryable(error) {
      if (error instanceof ResendError) {
        // No status means the request never landed: DNS, socket, timeout.
        return error.status === undefined ? true : classify(error.status);
      }
      // Timeouts from the runner's own guard arrive as plain Errors.
      return error instanceof Error && error.message.includes("timed out");
    },
  };
}
