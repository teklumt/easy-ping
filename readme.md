# easy-ping

**Own your notifications.** Your database, your users, no per-notification pricing.

A framework-agnostic, type-safe, self-hosted notifications library for TypeScript — in-app inbox, transactional email, and a plugin system for the rest.

> **Status: pre-release (v0.0.0).** The core pipeline, both adapters (Postgres and MongoDB), the React client, and the preferences, digests and push plugins all work and are covered by tests against real databases. Web push is verified end to end against Mozilla's production push service and cross-checked against `http_ece`. Realtime and batching are not built, and the Resend provider has still only been exercised against a stub. APIs may still move.

---

## Why

Every app past the weekend-project stage needs a notification bell, transactional email, and user preferences. The options are a platform you deploy (Novu), a SaaS you rent per notification (Knock, Courier), a workflow platform plus your own table (Inngest + Resend), or hand-rolling it badly.

easy-ping runs **inside your app**, stores notifications in **your database**, and never charges per send.

**Scale target:** thousands to low-millions of notifications per month. Not Slack-scale fan-out. Every "no queue required" decision below follows from that.

---

## Quickstart

### 1. Install

```bash
pnpm add easy-ping drizzle-orm postgres zod
```

### 2. Create the tables

```ts
// db/schema.ts
import { createSchema } from "easy-ping/adapters/drizzle";

export const { notification, notificationDelivery, notificationPreference } = createSchema();
```

Push them with `drizzle-kit`, or generate raw SQL:

```ts
import { coreSchema, renderPostgresDdl } from "easy-ping/schema";

for (const statement of renderPostgresDdl(coreSchema)) await sql.unsafe(statement);
```

<details>
<summary>Without an ORM (plain pg, postgres.js, Kysely…)</summary>

```bash
pnpm add easy-ping pg zod
```

```ts
import { postgresAdapter } from "easy-ping/adapters/postgres";
import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const database = postgresAdapter(
  async (text, params) => (await pool.query(text, params as unknown[])).rows,
  {
    // Optional, but it is what makes createNotifications atomic.
    transaction: async (fn) => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await fn(async (t, p) => (await client.query(t, p as unknown[])).rows);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  },
);
```

One function — run a parameterised statement, return rows — is the entire contract.
Anything that can do that works: `pg`, `postgres.js`, Kysely, Neon or PlanetScale's
serverless drivers, or Prisma's `$queryRawUnsafe`.

</details>

<details>
<summary>On MongoDB instead</summary>

```bash
pnpm add easy-ping mongodb zod
```

```ts
import { createMongoIndexes, mongoAdapter } from "easy-ping/adapters/mongodb";

const client = new MongoClient(process.env.MONGO_URL!);
await client.connect();
const db = client.db("app");

// There are no tables to create, only indexes. Run once at startup.
await createMongoIndexes(db);

// Pass the client too: it is what makes a notification and its deliveries
// land together, which needs a replica set.
const database = mongoAdapter(db, { client });
```

Everything after this point is identical.

</details>

### 3. Configure

```ts
// notify.ts
import { defineNotification, easyPing, escapeHtml } from "easy-ping";
import { drizzleAdapter } from "easy-ping/adapters/drizzle";
import { resend } from "easy-ping/providers/resend";
import { after } from "next/server";
import { inArray } from "drizzle-orm";
import { z } from "zod";
import { auth } from "./auth";
import { db, users } from "./db";

export const notify = easyPing({
  database: drizzleAdapter(db),

  // Both at least 16 characters; `openssl rand -base64 32` is the easy way.
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
        // Anything a user typed goes through escapeHtml, or their markup ships from your domain.
        template: (p) =>
          `<p>${escapeHtml(p.authorName)} replied. <a href="/c/${encodeURIComponent(p.commentId)}">View</a></p>`,
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
import { useNotifications } from "easy-ping/react";

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

`send()` validates, resolves recipients, runs hooks, and writes the notification and delivery rows in one transaction. **Committing those rows is the only thing it has to do** — a 200–800ms provider round trip has no business on a comment POST.

What happens next is `delivery.mode`'s job. In `deferred`, `worker` and `cron`, `send()` returns as soon as the rows are committed and never waits on a provider. `inline` is the exception: it awaits that send's own deliveries before resolving, which is the tradeoff you accept for the simplest possible setup.

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
| `push` | ✅ push plugin + `webPush()` — VAPID and aes128gcm on Web Crypto, so it runs on edge too |
| `sms` | ⬜ not implemented |
| `slack` | ⬜ not implemented |

A channel is usable when core carries it (`inApp`, `email`) or a plugin declares it and can `deliver` it. That is how push works, and how sms and slack will.

Declaring a channel nothing can carry **warns at startup** and reports `skipped: "channel-unavailable"` — deliberately distinct from `"no-channels"`, so a missing provider never looks like a user opt-out.

## Upgrading

A later version may add a column. How you pick it up depends on how you created the tables:

| you bootstrapped with | to upgrade |
| --- | --- |
| `createSchema()` + drizzle-kit | `drizzle-kit` diffs it for you — nothing to do here |
| `renderPostgresDdl()` | `planPostgresMigration()` — see below |
| `createMongoIndexes()` | rerun it; `createIndex` is idempotent and additive |

**`renderPostgresDdl` cannot upgrade you.** It emits `CREATE TABLE IF NOT EXISTS`, which is correct exactly once and a silent no-op afterwards. Rerunning it on an existing database does nothing at all.

```ts
import { INTROSPECT_SQL, planPostgresMigration, coreSchema } from "easy-ping/schema";

const plan = await planPostgresMigration(
  async () =>
    (await sql.unsafe(INTROSPECT_SQL)).map((row) => ({
      table: row.table_name,
      column: row.column_name,
      type: row.data_type,
      nullable: row.is_nullable === "YES",
    })),
  coreSchema,
);

for (const statement of plan.statements) await sql.unsafe(statement);
if (plan.unsupported.length) console.warn(plan.unsupported);
```

**Additive only, deliberately.** It adds missing columns and indexes, and creates tables that do not exist. It never drops a column, never changes a type, and never touches a column it did not declare — those land in `unsupported` as a message for a human, because they are destructive and context-dependent.

One behaviour worth knowing: a **required** column with no default is added **nullable**, because `NOT NULL` would abort against existing rows. That is reported in `unsupported`; backfill it and `SET NOT NULL` yourself.

Run the plugins' schemas the same way — `push({...}).schema`, `preferences().schema`.

---

## When something fails

Delivery is at-least-once with five attempts and backoff, which means failures are quiet by design. To see them:

```ts
const failed = await notify.getFailedDeliveries({ since: new Date(Date.now() - 86_400_000) });
// [{ id, notificationId, channel, attempts, lastError, updatedAt, ... }]
```

Defaults to the last 24 hours, capped at 1000 rows. Wire it to an admin page or an alert — otherwise the retry machinery is a black box, and a revoked API key looks exactly like nothing happening.

`notify.healthCheck()` reports the delivery mode and warns when a mode needs a cron you have not mounted.

---

## Security notes

- **`session.getUserId` is mandatory.** There is no default and no dev bypass — an insecure default ships, a startup crash doesn't. Returning `null` yields 401; *throwing* yields 500, because a broken session store and an absent session are different bugs.
- **Every query is scoped server-side.** No route accepts a user id from the client. Marking someone else's notification read returns 404, not 403 — a 403 confirms the row exists.
- **`cron.secret` is required** for modes that rely on the sweep. Unauthenticated, that endpoint is a free flush-everything trigger against your email provider. Compared in constant time. Plugin machine routes (`/push/prune`, `/digests/cron`) accept it too unless you set `machineSecret`, which keeps the scheduler's credential to `/cron` alone. One call drains at most `cron.maxSweeps` sweeps (default 50).
- **Plugins never see the secret.** They get `ctx.sign()`, which mints tokens only for the purposes their own signed routes declare; keys are derived per purpose with HKDF, so an unsubscribe key signs nothing else. `notify.listRoutes()` shows every mounted route with its auth scope, and a `custom`-scoped route is named in a startup warning with its justification.
- **Secrets must be at least 16 characters** and not a placeholder; startup throws otherwise. A short HMAC key makes every unsubscribe link forgeable offline.
- **CSRF.** Every POST must be `application/json` (415 otherwise) and, when the browser sends an `Origin`, it must match the request host or an entry in `trustedOrigins` (403 otherwise). This holds even if your session cookie is `SameSite=None`. Set `trustedOrigins: ["https://app.example.com", "*.example.com"]` when the API lives on a different origin from the page.
- **Push endpoints are validated at registration.** Public https hosts only, well-formed keys, one owner per endpoint for life (409 if another account registered it), at most `maxDevicesPerUser` rows per user. Pin `allowedEndpointHosts` to the push services you expect if you want the SSRF surface closed entirely.
- **Email templates are sent as-is.** Run every payload field a user could have typed through `escapeHtml`, or use a templating library that escapes by default. The quickstart shows the pattern.
- **In-app payloads are served to the browser verbatim.** Never put anything in `payload` the recipient shouldn't read, and never render it with `innerHTML`.
- **Request bodies are capped at 64 KiB** (`maxBodyBytes`), responses carry `Cache-Control: private, no-store`, and a thrown adapter error is a logged 500 rather than a stack trace or a crashed process.
- **Rate limiting.** `rateLimit: { max, windowMs }` is an in-process fixed-window limiter keyed by the client address from `cf-connecting-ip` / `x-real-ip` / `x-forwarded-for` (or your own `key`), applied to every route including `/cron` and `/unsubscribe`. It is per process, not global: enough to blunt secret guessing and poll storms, not a quota. `onRequest` runs before it if you have a shared limiter of your own. The inbox is polled by every open tab, so size limits with that in mind.
- **Unsubscribe tokens** travel in the URL, so they will appear in access logs. They are valid for 30 days by default, capped at 90. A token is refused if the user changed that preference after it was issued, so an old link cannot undo a newer decision; clicking the same link twice is still a 200. `last_error` stores provider messages with email addresses redacted.

---

## Status

| | |
| --- | --- |
| ✅ Core `send()` pipeline, hooks, dedupe | |
| ✅ Postgres through any driver — no ORM needed | `pg`, `postgres.js`, Kysely, Neon… |
| ✅ Postgres via Drizzle, for those already on it | same conformance suite |
| ✅ MongoDB | same conformance suite |
| ✅ Delivery runner, all four modes, retry + backoff | |
| ✅ Resend provider | |
| ✅ Route handler, session scoping, cron | |
| ✅ React client, polling, optimistic updates | |
| ✅ preferences plugin + headless `usePreferences` | the wedge |
| ✅ digests plugin, timezone-aware | |
| ✅ push plugin + web-push provider | VAPID + RFC 8291, no node:crypto |
| ✅ push verified against a live push service | Mozilla autopush, plus a cross-check against `http_ece` |
| ✅ scoped plugin storage, so plugins own their tables | |
| ✅ additive schema migrations for the raw-SQL path | `planPostgresMigration()` |
| ✅ failed deliveries reachable from the instance | `notify.getFailedDeliveries()` |
| ⬜ realtime, batching | |
| ⬜ Prisma / Kysely adapters, Vue / Svelte bindings | |

---

## Writing an adapter

The one operation with no equivalent in other libraries is atomic claiming — without it, two concurrent sweeps send the same email twice. Verify yours:

```ts
import { adapterConformanceCases } from "easy-ping/testing";

for (const testCase of adapterConformanceCases) {
  it(testCase.name, () => testCase.run({ adapter, reset, setAttempts, lockRow }));
}
```

Thirteen cases. The one that matters asserts a row locked by another transaction is *skipped*, not waited on; it is tagged `requires: "rowLock"`, and a store whose claim is a single atomic update filters it out rather than faking it.

Declare your dialect on the adapter so the plugin store writes what your driver expects:

```ts
naming: "snake_case" | "preserve"   // columns, or the declared field names
serializesJson: boolean             // json as a string, or natively
```

---

## Development

```bash
pnpm install
docker compose up -d     # Postgres on :54329, MongoDB on :27019
pnpm test
```

Mongo runs as a single-node replica set, because that is the only way it offers transactions.

Database tests skip locally when a database is unreachable, and **fail** in CI — a green build that ran none of them is worse than a red one.

The push crypto is checked two ways. `web-push-reference.test.ts` decrypts our output with `http_ece` — the library `web-push` npm uses — because a decryptor written from the same RFC would share any misreading and agree with itself. `web-push-live.test.ts` then sends through Mozilla's production push service for real; it is opt-in so CI never goes red because someone else's service is having a bad afternoon:

```bash
EASY_PING_LIVE_PUSH=1 pnpm --filter easy-ping test web-push-live
```

The Resend provider is checked against Resend's real API too: the rejection paths need no credentials — a bogus key coming back as a structured 401 rather than a 400 is what proves the request shape is right. The delivery leg needs your own key:

```bash
RESEND_API_KEY=re_... RESEND_FROM="Acme <hi@acme.dev>"   pnpm --filter easy-ping test resend-live
```

## Releasing

Nothing is on npm yet. The name `easy-ping` is unclaimed.

The Release workflow only maintains the version PR; it does **not** publish. npm trusted publishing (OIDC) cannot create a package that does not exist — a trusted publisher is configured against an existing package, so the first `PUT` is rejected as `E404`, which reads like "name taken" and is not.

The first release is manual:

```bash
# 1. bump off 0.0.0
pnpm changeset            # choose minor -> 0.1.0
pnpm changeset version

# 2. publish once, by hand
npm login
pnpm --filter easy-ping publish --access public
```

Then enable trusted publishing on npmjs.com for this repo and this workflow, and re-add `publish: pnpm changeset publish` to `.github/workflows/release.yml`. Every release after that is automatic.

## License

MIT
