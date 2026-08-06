import { inArray } from "drizzle-orm";
import { defineNotification, easyNotify } from "easy-notify";
import { drizzleAdapter } from "easy-notify/adapters/drizzle";
import { resend } from "easy-notify/providers/resend";
import { after } from "next/server";
import { z } from "zod";
import { db, schema } from "./db";
import { getSession } from "./session";

export const notify = easyNotify({
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
      provider: resend({
        apiKey: process.env.RESEND_API_KEY ?? "",
        from: "Acme <notifications@acme.dev>",
      }),
    },
  },

  delivery: {
    // send() writes rows and returns; delivery happens after the response.
    mode: "deferred",
    // Supplied explicitly rather than sniffed for — see RFC 0001.
    waitUntil: after,
  },

  notifications: {
    commentReply: defineNotification({
      schema: z.object({ authorName: z.string(), commentId: z.string() }),
      channels: ["inApp", "email"],
      email: {
        // payload is inferred from the schema above
        subject: (payload) => `${payload.authorName} replied to you`,
        template: (payload) =>
          `<p><strong>${payload.authorName}</strong> replied to your comment.</p>
           <p><a href="https://acme.dev/c/${payload.commentId}">View the thread</a></p>`,
      },
    }),

    invoicePaid: defineNotification({
      schema: z.object({ amount: z.number() }),
      channels: ["inApp"],
    }),
  },
});
