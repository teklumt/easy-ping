import { randomUUID } from "node:crypto";
import type { EmailProvider } from "easy-ping";

export type SentEmail = { id: string; to: string; subject: string; html: string; sentAt: string };

// On globalThis because Next can evaluate this module once per route bundle in development;
// one shared list means the outbox route sees what the send routes delivered.
const store = globalThis as { easyPingOutbox?: SentEmail[] };
store.easyPingOutbox ??= [];
const sent = store.easyPingOutbox;

/**
 * An email provider that keeps messages in memory instead of sending them, so the page can show
 * the email channel end to end without an account. Set RESEND_API_KEY to send for real instead.
 */
export const outbox: EmailProvider = {
  name: "outbox",
  async send(message) {
    const id = randomUUID();
    sent.unshift({
      id,
      to: message.to,
      subject: message.subject,
      html: message.html,
      sentAt: new Date().toISOString(),
    });
    sent.length = Math.min(sent.length, 50);
    return { providerMessageId: id };
  },
  isRetryable: () => false,
};

export const emailsTo = (address: string) => sent.filter((email) => email.to === address);
