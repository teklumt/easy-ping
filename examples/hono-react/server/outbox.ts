import { randomUUID } from "node:crypto";
import type { EmailProvider } from "easy-ping";

export type SentEmail = { id: string; to: string; subject: string; html: string; sentAt: string };

const sent: SentEmail[] = [];

/**
 * An email provider that keeps messages in memory instead of sending them, so the page can show
 * the email channel end to end without an account. Swap in `resend({ apiKey, from })` from
 * `easy-ping/providers/resend` to send for real; nothing else changes.
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
