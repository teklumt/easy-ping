import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { defineNotification, easyPing, escapeHtml } from "easy-ping";
import {
  createSqliteTables,
  sqliteAdapter,
  sqliteQuery,
  sqliteTransaction,
} from "easy-ping/adapters/sqlite";
import { toNodeHandler } from "easy-ping/node";
import { push } from "easy-ping/plugins/push";
import { webPush } from "easy-ping/providers/web-push";
import express from "express";
import { z } from "zod";
import { emailsTo, outbox } from "./outbox.ts";
import { loadVapidKeys } from "./vapid.ts";

// Identity is a header the page sets, standing in for your auth. Anyone can set it,
// so this must never face the internet.
if (process.env.NODE_ENV === "production") {
  throw new Error("this example trusts an x-demo-user header for identity; do not deploy it");
}

const PORT = Number(process.env.PORT ?? 3001);
const root = join(import.meta.dirname, "..");
const userOf = (header: string | null | undefined) => header || "you";
const emailOf = (userId: string) => `${userId}@example.com`;

const vapid = await loadVapidKeys(join(root, ".vapid-keys.json"));

const pushPlugin = push({
  provider: webPush({ subject: process.env.VAPID_SUBJECT ?? "mailto:you@example.com", vapid }),
  render: ({ payload }) => {
    const { from, text } = payload as { from: string; text: string };
    return { title: `${from} sent you a message`, body: text };
  },
});

const db = new DatabaseSync(process.env.SQLITE_PATH || join(root, "easy-ping.db"));
const query = sqliteQuery(db);
await createSqliteTables(query, { plugins: [pushPlugin.schema ?? {}] });

const notify = easyPing({
  database: sqliteAdapter(query, { transaction: sqliteTransaction(db) }),
  // A random secret only invalidates links it signed when the process restarts.
  secret: process.env.NOTIFY_SECRET || randomBytes(32).toString("base64url"),
  session: { getUserId: (request) => userOf(request.headers.get("x-demo-user")) },
  getRecipients: async (ids) =>
    ids.map((userId) => ({ userId, email: emailOf(userId), timezone: "UTC", locale: "en" })),
  channels: { inApp: { enabled: true }, email: { provider: outbox } },
  // A long-running server: an in-process worker delivers as soon as send() commits.
  delivery: { mode: "worker" },
  notifications: {
    message: defineNotification({
      schema: z.object({ from: z.string(), text: z.string() }),
      channels: ["inApp", "push", "email"],
      email: {
        subject: (payload) => `${payload.from} sent you a message`,
        // Sent as-is, so anything a user typed is escaped.
        template: (payload) =>
          `<p><strong>${escapeHtml(payload.from)}</strong> wrote:</p>
           <blockquote>${escapeHtml(payload.text)}</blockquote>
           <p><a href="http://localhost:${PORT}">Open Acme</a></p>`,
      },
    }),
  },
  plugins: [pushPlugin],
});

const worker = notify.startWorker();

const app = express();

// Before any body parser: the handler reads the raw request itself.
app.all("/api/notifications{/*path}", toNodeHandler(notify.handler.handle));

const MessageBody = z.object({
  to: z.string().trim().min(1).max(40),
  text: z.string().trim().min(1).max(280),
});

app.post("/api/messages", express.json(), async (req, res) => {
  const from = userOf(req.get("x-demo-user"));
  const body = MessageBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: "to and text are required" });
    return;
  }

  const result = await notify.send("message", {
    to: body.data.to,
    payload: { from, text: body.data.text },
    actorId: from,
  });
  res.json(result);
});

app.get("/api/outbox", (req, res) => {
  res.json({ emails: emailsTo(emailOf(userOf(req.get("x-demo-user")))) });
});

app.get("/api/config", (_req, res) => {
  res.json({ vapidPublicKey: vapid.publicKey });
});

// The browser half ships as plain ES modules, so the page needs no bundler.
const dist = join(
  dirname(createRequire(import.meta.url).resolve("easy-ping/package.json")),
  "dist",
);
for (const file of ["client.js", "browser.js"]) {
  // `root`, because pnpm installs under node_modules/.pnpm and sendFile refuses dot-folders.
  app.get(`/vendor/easy-ping/${file}`, (_req, res) => res.sendFile(file, { root: dist }));
}

app.use(express.static(join(root, "public")));

const server = app.listen(PORT, "127.0.0.1", () => {
  console.log(`\n  easy-ping + Express + SQLite -> http://localhost:${PORT}\n`);
});

process.on("SIGINT", async () => {
  server.close();
  await worker.stop();
  process.exit(0);
});
