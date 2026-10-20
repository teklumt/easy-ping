import { join } from "node:path";
import { inArray } from "drizzle-orm";
import { defineNotification, easyPing, escapeHtml } from "easy-ping";
import { drizzleAdapter } from "easy-ping/adapters/drizzle";
import { push } from "easy-ping/plugins/push";
import { resend } from "easy-ping/providers/resend";
import { webPush } from "easy-ping/providers/web-push";
import { after } from "next/server";
import { z } from "zod";
import { db, schema } from "./db";
import { outbox } from "./outbox";
import { getSession } from "./session";
import { loadVapidKeys } from "./vapid";

export const vapid = await loadVapidKeys(join(process.cwd(), ".vapid-keys.json"));

const pushPlugin = push({
  provider: webPush({ subject: process.env.VAPID_SUBJECT ?? "mailto:you@example.com", vapid }),
  render: ({ type, payload }) => {
    const data = payload as Record<string, unknown>;
    if (type === "commentReply") {
      return {
        title: `${String(data.authorName)} replied to you`,
        body: "Open the thread to read it",
      };
    }
    return {
      title: `Invoice paid: $${(Number(data.amount) / 100).toFixed(2)}`,
      body: "Acme billing",
    };
  },
});

export const notify = easyPing({
  database: drizzleAdapter(db),

  // Signs unsubscribe links and other session-less URLs.
  secret: process.env.NOTIFY_SECRET ?? "",

  // The cron endpoint is a machine route with no user to authenticate.
  cron: { secret: process.env.NOTIFY_CRON_SECRET ?? "" },

  session: {
    getUserId: async (request) => (await getSession(request))?.userId ?? null,
  },

  // One batched call per send, never one per recipient.
  getRecipients: async (userIds) => {
    const rows = await db
      .select()
      .from(schema.user)
      .where(inArray(schema.user.id, [...userIds]));

    return rows.map((row) => ({
      userId: row.id,
      email: row.email,
      timezone: row.timezone,
      locale: row.locale,
    }));
  },

  channels: {
    inApp: { enabled: true },
    email: {
      // Real email with a Resend key; otherwise the outbox shows what would have been sent.
      provider: process.env.RESEND_API_KEY
        ? resend({
            apiKey: process.env.RESEND_API_KEY,
            from: process.env.RESEND_FROM ?? "Acme <notifications@acme.dev>",
          })
        : outbox,
    },
  },

  delivery: {
    // send() writes rows and returns; delivery happens after the response.
    mode: "deferred",
    // Supplied explicitly rather than sniffed for: importing next/server inside the
    // library would break every other framework's bundler.
    waitUntil: after,
  },

  notifications: {
    commentReply: defineNotification({
      schema: z.object({ authorName: z.string(), commentId: z.string() }),
      channels: ["inApp", "push", "email"],
      email: {
        // payload is inferred from the schema above. authorName is user input:
        // unescaped, a display name becomes markup sent from your domain.
        subject: (payload) => `${payload.authorName} replied to you`,
        template: (payload) =>
          `<p><strong>${escapeHtml(payload.authorName)}</strong> replied to your comment.</p>
           <p><a href="http://localhost:3004/c/${encodeURIComponent(payload.commentId)}">View the thread</a></p>`,
      },
    }),

    invoicePaid: defineNotification({
      schema: z.object({ amount: z.number() }),
      channels: ["inApp", "push", "email"],
      email: {
        subject: (payload) => `Invoice paid: $${(payload.amount / 100).toFixed(2)}`,
        template: (payload) =>
          `<p>Thanks! We received <strong>$${(payload.amount / 100).toFixed(2)}</strong>.</p>`,
      },
    }),
  },

  plugins: [pushPlugin],
});
