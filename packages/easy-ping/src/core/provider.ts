export type ProviderSendResult = {
  providerMessageId?: string | undefined;
};

export type EmailMessage = {
  to: string;
  subject: string;
  html: string;
  text?: string | undefined;
  headers?: Record<string, string> | undefined;
  /** Derived from the delivery id. Delivery is at-least-once; see RFC 0003. */
  idempotencyKey: string;
  /** Aborted on timeout; honour it or the request outlives the recorded failure. */
  signal?: AbortSignal | undefined;
};

export type EmailProvider = {
  name: string;
  timeoutMs?: number;
  send(message: EmailMessage): Promise<ProviderSendResult>;
  /** False fails the delivery outright; a revoked key is not worth 45min of backoff. */
  isRetryable(error: unknown): boolean;
};
