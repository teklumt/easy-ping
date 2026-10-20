import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { defineNotification, easyPing, escapeHtml } from "easy-ping";
import { createPostgresTables, postgresAdapter, type SqlQuery } from "easy-ping/adapters/postgres";
import { push } from "easy-ping/plugins/push";
import { webPush } from "easy-ping/providers/web-push";
import { Hono } from "hono";
import postgres from "postgres";
import { z } from "zod";
import { emailsTo, outbox } from "./outbox.ts";
import { loadVapidKeys } from "./vapid.ts";

// Identity is a header the page sets, standing in for your auth. Never deploy this.
if (process.env.NODE_ENV === "production") {
  throw new Error("this example trusts an x-demo-user header for identity; do not deploy it");
}

const userOf = (header: string | null | undefined) => header || "you";
const emailOf = (userId: string) => `${userId}@example.com`;

const url =
  process.env.DATABASE_URL ?? "postgres://easyping:easyping@localhost:54329/easyping_test";
const sql = postgres(url, { onnotice: () => {} });

// easy-ping needs only (text, params) => rows, so any driver works without an ORM.
const query: SqlQuery = async (text, params) => await sql.unsafe(text, [...params] as never[]);

// What each notification says, shared by the push notification and the email subject.
type Payloads = {
  commentReply: { from: string; excerpt: string };
  taskAssigned: { from: string; task: string };
  invoicePaid: { amountCents: number };
};
const headline = {
  commentReply: (p: Payloads["commentReply"]) => `${p.from} replied to your comment`,
  taskAssigned: (p: Payloads["taskAssigned"]) => `${p.from} assigned you a task`,
  invoicePaid: (p: Payloads["invoicePaid"]) => `Invoice paid: $${(p.amountCents / 100).toFixed(2)}`,
};

const vapid = await loadVapidKeys(join(import.meta.dirname, "..", ".vapid-keys.json"));

const pushPlugin = push({
  provider: webPush({ subject: process.env.VAPID_SUBJECT ?? "mailto:you@example.com", vapid }),
  render: ({ type, payload }) => {
    if (type === "commentReply") {
      const p = payload as Payloads["commentReply"];
      return { title: headline.commentReply(p), body: p.excerpt };
    }
    if (type === "taskAssigned") {
      const p = payload as Payloads["taskAssigned"];
      return { title: headline.taskAssigned(p), body: p.task };
    }
    return {
      title: headline.invoicePaid(payload as Payloads["invoicePaid"]),
      body: "Acme billing",
    };
  },
});

try {
  await createPostgresTables(query, { plugins: [pushPlugin.schema ?? {}] });
} catch (error) {
  console.error(`\n  Cannot reach Postgres at ${url.replace(/:[^:@]*@/, ":***@")}`);
  console.error("  Start one with `docker compose up -d postgres` from the repo root,");
  console.error("  or point DATABASE_URL in .env at your own.\n");
  console.error(`  ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}

const link = `<p><a href="http://localhost:3002">Open Acme</a></p>`;

const notify = easyPing({
  database: postgresAdapter(query, {
    // Makes a send atomic: the notification and its deliveries commit together.
    // postgres.js types begin() as resolving to an unwrapped array type; fn's result passes
    // through unchanged at runtime.
    transaction: <T>(fn: (tx: SqlQuery) => Promise<T>) =>
      sql.begin((tx) => fn((t, p) => tx.unsafe(t, [...p] as never[]))) as Promise<T>,
  }),
  secret: process.env.NOTIFY_SECRET || randomBytes(32).toString("base64url"),
  session: { getUserId: (request) => userOf(request.headers.get("x-demo-user")) },
  getRecipients: async (ids) =>
    ids.map((userId) => ({ userId, email: emailOf(userId), timezone: "UTC", locale: "en" })),
  channels: { inApp: { enabled: true }, email: { provider: outbox } },
  // Delivery finishes before send() returns: no cron, no worker.
  delivery: { mode: "inline" },
  notifications: {
    commentReply: defineNotification({
      schema: z.object({ from: z.string(), excerpt: z.string() }),
      channels: ["inApp", "push", "email"],
      email: {
        subject: headline.commentReply,
        // Sent as-is, so anything a user typed is escaped.
        template: (p) =>
          `<p><strong>${escapeHtml(p.from)}</strong> replied to your comment:</p>
           <blockquote>${escapeHtml(p.excerpt)}</blockquote>${link}`,
      },
    }),
    taskAssigned: defineNotification({
      schema: z.object({ from: z.string(), task: z.string() }),
      channels: ["inApp", "push", "email"],
      email: {
        subject: headline.taskAssigned,
        template: (p) =>
          `<p><strong>${escapeHtml(p.from)}</strong> assigned you:</p>
           <p><strong>${escapeHtml(p.task)}</strong></p>${link}`,
      },
    }),
    invoicePaid: defineNotification({
      schema: z.object({ amountCents: z.number().int() }),
      channels: ["inApp", "push", "email"],
      email: {
        subject: headline.invoicePaid,
        template: (p) =>
          `<p>Thanks! We received <strong>$${(p.amountCents / 100).toFixed(2)}</strong>.</p>${link}`,
      },
    }),
  },
  plugins: [pushPlugin],
});

const app = new Hono();

// The handler speaks Request/Response, so mounting it is one line.
app.all("/api/notifications", (c) => notify.handler.handle(c.req.raw));
app.all("/api/notifications/*", (c) => notify.handler.handle(c.req.raw));

const EventBody = z.object({
  type: z.enum(["commentReply", "taskAssigned", "invoicePaid"]),
  to: z.string().trim().min(1).max(40),
});

app.post("/api/events", async (c) => {
  const from = userOf(c.req.header("x-demo-user"));
  const body = EventBody.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "type and to are required" }, 400);

  const { type, to } = body.data;

  // Each payload is checked against its own schema above; a wrong field is a compile error.
  const result =
    type === "commentReply"
      ? await notify.send(type, {
          to,
          actorId: from,
          payload: { from, excerpt: "Looks good. Ship it!" },
        })
      : type === "taskAssigned"
        ? await notify.send(type, {
            to,
            actorId: from,
            payload: { from, task: "Write the launch post" },
          })
        : await notify.send(type, { to, payload: { amountCents: 4900 } });

  return c.json(result);
});

app.get("/api/outbox", (c) =>
  c.json({ emails: emailsTo(emailOf(userOf(c.req.header("x-demo-user")))) }),
);
app.get("/api/config", (c) => c.json({ vapidPublicKey: vapid.publicKey }));

serve({ fetch: app.fetch, port: 3003, hostname: "127.0.0.1" }, () => {
  console.log("\n  easy-ping API (Hono + Postgres) on http://127.0.0.1:3003");
  console.log("  open the page at http://localhost:3002\n");
});
