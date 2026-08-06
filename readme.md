# easy-notify

**Own your notifications.** Your database, your users, no per-notification pricing.

A framework-agnostic, type-safe, self-hosted notifications library for TypeScript — in-app inbox, transactional email, and a plugin system for the rest.

> **Status: pre-release (v0.0.0).** The core pipeline, Postgres adapter, and React client work and are covered by tests against a real database. Preferences, digests, push, and realtime are not built yet. APIs may still move.

---

## Why

Every app past the weekend-project stage needs a notification bell, transactional email, and user preferences. The options are a platform you deploy (Novu), a SaaS you rent per notification (Knock, Courier), a workflow platform plus your own table (Inngest + Resend), or hand-rolling it badly.

easy-notify runs **inside your app**, stores notifications in **your database**, and never charges per send.

**Scale target:** thousands to low-millions of notifications per month. Not Slack-scale fan-out. Every "no queue required" decision below follows from that.

---

## Quickstart

### 1. Install

```bash
pnpm add easy-notify drizzle-orm postgres zod
```

### 2. Create the tables

```ts
// db/schema.ts
import { createSchema } from "easy-notify/adapters/drizzle";

export const { notification, notificationDelivery, notificationPreference } = createSchema();
```

Push them with `drizzle-kit`, or generate raw SQL:

```ts
import { coreSchema, renderPostgresDdl } from "easy-notify/schema";

for (const statement of renderPostgresDdl(coreSchema)) await sql.unsafe(statement);
```

### 3. Configure

```ts
// notify.ts
import { defineNotification, easyNotify } from "easy-notify";
import { drizzleAdapter } from "easy-notify/adapters/drizzle";
import { resend } from "easy-notify/providers/resend";
import { after } from "next/server";
import { inArray } from "drizzle-orm";
import { z } from "zod";
import { auth } from "./auth";
import { db, users } from "./db";

export const notify = easyNotify({
  database: drizzleAdapter(db),

  secret: process.env.NOTIFY_SECRET!,
  cron: { secret: process.env.NOTIFY_CRON_SECRET! },

  // Required. The mounted endpoints serve a user's private inbox.
  session: {
    getUserId: async (request) =>
      (await auth.api.getSession({ headers: request.headers }))?.user.id ?? null,
  },

  // Batched — one call per send, never one per recipient.
  getRecipients: async (userIds) =>
    (await db.select().from(users).where(inArray(users.id, [...userIds]))).map((u) => ({
      userId: u.id,
      email: u.email,
      timezone: u.timezone,
      locale: u.locale,
    })),

  channels: {
    inApp: { enabled: true },
    email: { provider: resend({ apiKey: process.env.RESEND_API_KEY!, from: "Acme <hi@acme.dev>" }) },
  },

  delivery: { mode: "deferred", waitUntil: after },

  notifications: {
    commentReply: defineNotification({
      schema: z.object({ authorName: z.string(), commentId: z.string() }),
      channels: ["inApp", "email"],
      email: {
        subject: (p) => `${p.authorName} replied to you`,
        template: (p) => `<p>${p.authorName} replied. <a href="/c/${p.commentId}">View</a></p>`,
      },
    }),
  },
});
```

### 4. Mount the endpoints

```ts
// app/api/notifications/[...notify]/route.ts
import { notify } from "@/notify";

export const { GET, POST } = notify.handler;
```

### 5. Send

```ts
await notify.send("commentReply", {
  to: threadOwnerId,
  payload: { authorName: "Dana", commentId: "c_123" }, // typed against the schema
  dedupeKey: `commentReply:c_123:${threadOwnerId}`,    // optional, makes retries safe
});
```

### 6. Render the bell

```tsx
"use client";
import { useNotifications } from "easy-notify/react";

export function Bell() {
  const { notifications, unseenCount, markAsRead, markSeen } = useNotifications();

  return (
    <button onClick={() => markSeen()}>
      {unseenCount}
      {notifications.map((n) => (
        <div key={n.id} onClick={() => markAsRead(n.id)}>
          {n.type} {n.readAt ? "" : "•"}
        </div>
      ))}
    </button>
  );
}
```

### 7. Wire the cron

```
POST /api/notifications/cron
Authorization: Bearer $NOTIFY_CRON_SECRET
```

Every 1–5 minutes, from Vercel Cron, GitHub Actions, or anything else. This is the durability floor beneath every delivery mode — **required** for `cron` and `deferred`.

---

## How delivery works

`send()` validates, resolves recipients, runs hooks, writes the notification and delivery rows in one transaction, and returns. **It never waits for Resend.** A 200–800ms provider round trip has no business on a comment POST.

Delivery then happens according to `delivery.mode`:

| mode | delivery happens | latency | needs cron |
| --- | --- | --- | --- |
| `inline` | before `send()` resolves | in-request | recommended |
| `deferred` | after the response, via `waitUntil` | ~1s | **yes** |
| `worker` | in-process poller | ~1s | optional |
| `cron` | when the sweep runs | up to the interval | **yes** |

Modes are **additive**. `deferred` and `worker` are latency optimisations layered over the cron sweep — the rows are already committed, so a missing platform primitive or a crashed process costs latency, never a notification.

```ts
const worker = notify.startWorker({ intervalMs: 1000 });
process.on("SIGTERM", () => worker.stop()); // drains in-flight work, releases leases
```

**Delivery is at-least-once.** Providers receive an idempotency key derived from the delivery id. Retries use exponential backoff with jitter (30s → 2m → 8m → 32m, five attempts), floored by your cron interval. Non-retryable failures — a revoked API key, an invalid recipient — fail immediately rather than burning all five attempts.

**Not for OTP or 2FA codes.** Use your auth library's own sender. A retry-and-sweep model is wrong for a 60-second TTL.

---

## Channels

| channel | state |
| --- | --- |
| `inApp` | ✅ built in, on by default, needs no provider |
| `email` | ✅ Resend provider; the interface is open for others |
| `push` | ⬜ not implemented |
| `sms` | ⬜ not implemented |
| `slack` | ⬜ not implemented |

The unimplemented ones exist in the `Channel` union so plugins can add them later. Declaring one today **warns at startup** and reports `skipped: "channel-unavailable"` — deliberately distinct from `"no-channels"`, so a missing provider never looks like a user opt-out.

## Security notes

- **`session.getUserId` is mandatory.** There is no default and no dev bypass — an insecure default ships, a startup crash doesn't. Returning `null` yields 401; *throwing* yields 500, because a broken session store and an absent session are different bugs.
- **Every query is scoped server-side.** No route accepts a user id from the client. Marking someone else's notification read returns 404, not 403 — a 403 confirms the row exists.
- **`cron.secret` is required** for modes that rely on the sweep. Unauthenticated, that endpoint is a free flush-everything trigger against your email provider. Compared in constant time.
- **In-app payloads are served to the browser verbatim.** Never put anything in `payload` the recipient shouldn't read.

---

## Status

| | |
| --- | --- |
| ✅ Core `send()` pipeline, hooks, dedupe | |
| ✅ Postgres via Drizzle, with a conformance suite | |
| ✅ Delivery runner, all four modes, retry + backoff | |
| ✅ Resend provider | |
| ✅ Route handler, session scoping, cron | |
| ✅ React client, polling, optimistic updates | |
| ⬜ preferences plugin + `<PreferenceCenter />` | the wedge |
| ⬜ digests, push, realtime, batching | |
| ⬜ Prisma / Kysely adapters, Vue / Svelte bindings | |

---

## Writing an adapter

The one operation with no equivalent in other libraries is atomic claiming — without it, two concurrent sweeps send the same email twice. Verify yours:

```ts
import { adapterConformanceCases } from "easy-notify/testing";

for (const testCase of adapterConformanceCases) {
  it(testCase.name, () => testCase.run({ adapter, exec, reset, lockRow }));
}
```

Thirteen cases. The one that matters asserts a row locked by another transaction is *skipped*, not waited on.

---

## Development

```bash
pnpm install
docker compose up -d     # Postgres on :54329 for the test suite
pnpm test
```

Database tests skip locally when Postgres is unreachable, and **fail** in CI — a green build that ran none of them is worse than a red one.

## License

MIT
