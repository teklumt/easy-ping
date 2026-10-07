<div align="center">

# easy-ping

**Own your notifications.**
In-app inbox, transactional email, web push and Telegram — running inside your app, stored in your
database, with no per-notification bill.

[![npm](https://img.shields.io/npm/v/easy-ping?color=%23e0362a&label=npm)](https://www.npmjs.com/package/easy-ping)
[![install size](https://packagephobia.com/badge?p=easy-ping)](https://packagephobia.com/result?p=easy-ping)
[![node](https://img.shields.io/node/v/easy-ping)](https://www.npmjs.com/package/easy-ping)
[![license](https://img.shields.io/npm/l/easy-ping?color=blue)](./LICENSE)

[Documentation](https://easy-pings.com) · [Quickstart](https://easy-pings.com/docs/quickstart) · [Changelog](https://easy-pings.com/docs/changelog) · [AI context](https://easy-pings.com/docs/ai-assistant)

</div>

---

```ts
await notify.send("commentReply", {
  to: threadOwnerId,
  payload: { authorName: "Dana", commentId: "c_123" },  // typed from your schema
  dedupeKey: `commentReply:c_123:${threadOwnerId}`,      // optional, makes retries safe
});
```

```tsx
const { notifications, unseenCount, markSeen, markAsRead } = useNotifications();
```

One config file, one `send()`, one hook. No queue, no worker service, no vendor.

---

## Why

Every app past the weekend-project stage needs a notification bell, transactional email and user
preferences. The alternatives are a platform you deploy, a SaaS you rent per notification, or
hand-rolling it badly.

|  | easy-ping | Novu (self-hosted) | Knock · Courier |
| --- | --- | --- | --- |
| **What you deploy** | nothing, it is a dependency | four services | nothing, it is their cloud |
| **Infrastructure it adds** | none | MongoDB, Redis, S3 | none |
| **Where notifications live** | your Postgres or MongoDB | Novu's MongoDB | theirs |
| **Cost per notification** | none | none, you pay for servers | metered per send |
| **License** | MIT, all of it | MIT core, commercial modules | proprietary |
| **Visual workflow editor** | **no**, a notification is code | yes | yes |
| **Channels out of the box** | **in-app, email, web push, Telegram** | dozens | dozens |

The last two rows are the trade. If you need a workflow editor a non-developer can edit, use one
of the others — they are good tools solving a bigger problem.

**Scale target:** thousands to low-millions of notifications per month. Not Slack-scale fan-out.
Every "no queue required" decision below follows from that.

> **Status: published, pre-1.0.** The core pipeline, all five adapters, the React client and the
> preferences, digests, push and telegram plugins are covered by tests against real databases. Web push is
> verified end to end against Mozilla's production push service and cross-checked against
> `http_ece`; email is verified against Resend's live API, including idempotent retries and a full
> send-to-delivered pass. The bell updates over a server-sent event stream with polling as the
> fallback; batching is not built yet. Minor
> versions may still move APIs before 1.0; [what is stable and how changes are announced](https://easy-pings.com/docs/stability).

---

## Quickstart

### 1. Install

```bash
pnpm add easy-ping pg zod
```

### 2. Create the tables

No ORM required. The whole database contract is one function: run a parameterised statement,
return rows.

```ts
import { createPostgresTables, pgTransaction, postgresAdapter } from "easy-ping/adapters/postgres";
import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const query = async (text, params) => (await pool.query(text, params)).rows;

// Renders the DDL from the installed version's own schema, so the tables
// cannot drift from the package. Every statement is IF NOT EXISTS.
await createPostgresTables(query);

export const database = postgresAdapter(query, { transaction: pgTransaction(pool) });
```

Anything that can run a statement works: `pg`, `postgres.js`, Kysely, Neon or PlanetScale's
serverless drivers, or Prisma's `$queryRawUnsafe`.

<details>
<summary>Already on Drizzle</summary>

```ts
// db/schema.ts
import { createSchema } from "easy-ping/adapters/drizzle";

export const { notification, notificationDelivery, notificationPreference } = createSchema();
```

Push it with `drizzle-kit`, then `drizzleAdapter(db)` in place of `postgresAdapter`.

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

// No tables, only indexes. Run once at startup.
await createMongoIndexes(db);

// Pass the client too: it is what makes a notification and its deliveries
// land together, which needs a replica set.
export const database = mongoAdapter(db, { client });
```

Everything after this point is identical.

</details>

<details>
<summary>On MySQL instead</summary>

```bash
pnpm add easy-ping mysql2 zod
```

```ts
import { createMysqlTables, mysql2Query, mysqlAdapter, mysqlTransaction } from "easy-ping/adapters/mysql";
import mysql from "mysql2/promise";

// timezone "Z": the adapter writes DATETIME columns as UTC and must read them back unshifted.
const pool = mysql.createPool({ uri: process.env.DATABASE_URL, timezone: "Z" });
const query = mysql2Query(pool);

await createMysqlTables(query);   // CREATE TABLE IF NOT EXISTS, safe on every boot

// With a transaction, a claim uses FOR UPDATE SKIP LOCKED (MySQL 8+). Without
// one it is a single lock-free UPDATE that still never double-claims a row.
export const database = mysqlAdapter(query, { transaction: mysqlTransaction(pool) });
```

MySQL 8 or MariaDB. Any driver works: the contract is `(text, params) => Promise<{ rows, affectedRows }>`.

</details>

<details>
<summary>On SQLite instead</summary>

```ts
import { createSqliteTables, sqliteAdapter, sqliteQuery, sqliteTransaction } from "easy-ping/adapters/sqlite";
import { DatabaseSync } from "node:sqlite";   // Node 22.13+; better-sqlite3 works the same way

const db = new DatabaseSync("./app.db");
const query = sqliteQuery(db);

await createSqliteTables(query);

export const database = sqliteAdapter(query, { transaction: sqliteTransaction(db) });
```

SQLite has one writer at a time, so the claim is a plain `UPDATE … WHERE id IN (SELECT … LIMIT ?)`; two sweeps cannot interleave. Dates are ISO text, booleans 0/1, JSON text.

</details>

<details>
<summary>Adding a plugin's tables</summary>

Plugins own their own tables and export the declaration, so no plugin instance is needed:

```ts
import { pushSchema } from "easy-ping/plugins/push";

await createPostgresTables(query, { plugins: [pushSchema] });
```

</details>

### 3. Configure

```ts
// notify.ts
import { defineNotification, easyPing, escapeHtml } from "easy-ping";
import { resend } from "easy-ping/providers/resend";
import { after } from "next/server";
import { z } from "zod";
import { auth } from "./auth";
import { database, pool } from "./db";   // from step 2

export const notify = easyPing({
  database,

  // Both at least 16 characters; `openssl rand -base64 32` is the easy way.
  secret: process.env.NOTIFY_SECRET!,
  cron: { secret: process.env.NOTIFY_CRON_SECRET! },

  // Required. The mounted endpoints serve a user's private inbox.
  session: {
    getUserId: async (request) =>
      (await auth.api.getSession({ headers: request.headers }))?.user.id ?? null,
  },

  // Batched: one call per send, never one per recipient.
  getRecipients: async (userIds) => {
    const { rows } = await pool.query(
      "select id, email, timezone, locale from users where id = any($1)",
      [userIds],
    );
    return rows.map((u) => ({
      userId: u.id,
      email: u.email,
      timezone: u.timezone,
      locale: u.locale,
    }));
  },

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
// app/api/notifications/[[...notify]]/route.ts
// Double brackets: Next's required catch-all would not match the bare
// /api/notifications path, which is where the feed lives.
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

The hook is headless and keeps itself fresh without a socket server: one tab per browser holds a
`GET /events` stream and the others mirror it over `BroadcastChannel`, so ten open tabs cost one
connection and zero idle queries. `send()`, `/read` and `/seen` push a `changed` event, the tab
refreshes, and where a stream cannot live (a serverless host that cuts it, a hardened proxy) the
client notices and falls back to polling that slows down while the user is idle. Nothing to
configure; `transport: "poll"` switches the stream off if you want the old behaviour.

Two optional extras when you want the bell fresh with no dedicated request at all:

```ts
// Piggyback: any response from your own API can carry the inbox version.
return Response.json(data, { headers: notify.inboxHeaders(userId) });
// ...and the client refreshes only when that number moves.
const fetchWithBell = client.instrument(fetch);

// Push relay: if you already run the push plugin, the service worker wakes the bell too.
// easy-ping/sw is an ES module: bundle sw.js (esbuild/Vite) before serving it.
import { handlePush } from "easy-ping/sw";
self.addEventListener("push", (event) => event.waitUntil(handlePush(event)));
```

**React Native (beta, under testing).** The same client ships as `easy-ping/react-native`: `useNotifications` wired to `AppState`, a live stream when you pass `fetch` from `expo/fetch`, polling otherwise, and `registerMobilePushDevice` for native push. `examples/expo` is a complete screen.

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
| `worker` | in-process loop, woken by `send()` | ~instant in-process, ≤10s across replicas | optional |
| `cron` | when the sweep runs | up to the interval | **yes** |

Modes are **additive**. `deferred` and `worker` are latency optimisations layered over the cron sweep — the rows are already committed, so a missing platform primitive or a crashed process costs latency, never a notification.

```ts
const worker = notify.startWorker(); // idles 10s between sweeps; a send() in this process wakes it at once
process.on("SIGTERM", () => worker.stop()); // drains in-flight work, releases leases
```

On `cron` and `deferred` hosts that see traffic but no scheduler for minutes at a time,
`delivery.sweepOnRequest: true` runs a small bounded sweep after any request, at most every 5 s,
so a free-tier deployment delivers within seconds of the next page load instead of the next cron.

**Across replicas**, wake-ups travel through `signals`: a publish says "something changed, go
look" and carries no payload, so losing one costs latency, never a notification.

```ts
import { postgresSignals } from "easy-ping/adapters/postgres"; // LISTEN/NOTIFY, one channel
import { mongoSignals } from "easy-ping/adapters/mongodb";     // change stream on a capped collection

easyPing({ ..., signals: postgresSignals(sql) });
```

Without one, each process uses in-memory signals and the event stream falls back to a cheap
fingerprint probe every 30 s (`events.probeIntervalMs`), which is exactly right on SQLite or a
single replica.

**Delivery is at-least-once.** Providers receive an idempotency key derived from the delivery id. Retries use exponential backoff with jitter (30s → 2m → 8m → 32m, five attempts), floored by your cron interval. Non-retryable failures — a revoked API key, an invalid recipient — fail immediately rather than burning all five attempts.

**Not for OTP or 2FA codes.** Use your auth library's own sender. A retry-and-sweep model is wrong for a 60-second TTL.

---

## Channels

| channel | state |
| --- | --- |
| `inApp` | ✅ built in, on by default, needs no provider |
| `email` | ✅ Resend provider; the interface is open for others |
| `push` | ✅ push plugin + `webPush()` — VAPID and aes128gcm on Web Crypto, so it runs on edge too |
| `telegram` | ✅ telegram plugin + `telegramBot()` — one-tap linking through the bot, webhook or long-poll |
| `mobilePush` | 🧪 **beta** — mobile-push plugin + `expoPush()`, iOS and Android through Expo's push service; in testing |
| `sms` | ⬜ not implemented |
| `slack` | ⬜ not implemented |

A channel is usable when core carries it (`inApp`, `email`) or a plugin declares it and can `deliver` it. That is how push and telegram work, and how sms and slack will.

```ts
import { telegram } from "easy-ping/plugins/telegram";
import { telegramBot } from "easy-ping/providers/telegram";

telegram({
  provider: telegramBot({ token: process.env.TELEGRAM_BOT_TOKEN! }),
  botUsername: "your_bot",
  webhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET,   // or plugin.poll() in development
  render: ({ payload }) => ({ text: `<b>${escapeHtml(payload.authorName)}</b> replied` }),
});
```

`POST /telegram/link` returns a `t.me/<bot>?start=<code>` link; the user taps it, the bot stores the chat, and every `send()` with `telegram` in its channels reaches it. Blocked chats prune themselves.

Declaring a channel nothing can carry **warns at startup** and reports `skipped: "channel-unavailable"` — deliberately distinct from `"no-channels"`, so a missing provider never looks like a user opt-out.

## Upgrading

A later version may add a column. How you pick it up depends on how you created the tables:

| you bootstrapped with | to upgrade |
| --- | --- |
| `createSchema()` + drizzle-kit | `drizzle-kit` diffs it for you — nothing to do here |
| `renderPostgresDdl()` | `planPostgresMigration()` — see below |
| `createMysqlTables()` | `planMysqlMigration(query, schema)` from `easy-ping/schema` |
| `createSqliteTables()` | `planSqliteMigration(query, schema)` from `easy-ping/schema`, in a transaction |
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
- **Rate limiting.** `rateLimit: { max, windowMs }` is an in-process fixed-window limiter keyed by the client address from `cf-connecting-ip` / `x-real-ip` / `x-forwarded-for` (or your own `key`), applied to every route including `/cron` and `/unsubscribe`. It is per process, not global: enough to blunt secret guessing and refresh storms, not a quota. `onRequest` runs before it if you have a shared limiter of your own. Each browser holds one `GET /events` stream and refreshes the feed on every `changed`, so size limits with that in mind.
- **Unsubscribe tokens** travel in the URL, so they will appear in access logs. They are valid for 30 days by default, capped at 90. A token is refused if the user changed that preference after it was issued, so an old link cannot undo a newer decision; clicking the same link twice is still a 200. `last_error` stores provider messages with email addresses redacted.

---

## Status

| | |
| --- | --- |
| ✅ Core `send()` pipeline, hooks, dedupe | |
| ✅ Postgres through any driver — no ORM needed | `pg`, `postgres.js`, Kysely, Neon… |
| ✅ Postgres via Drizzle, for those already on it | same conformance suite |
| ✅ MongoDB | same conformance suite |
| ✅ MySQL 8 / MariaDB | `SKIP LOCKED` with a transaction, lock-free `UPDATE` without |
| ✅ SQLite | `node:sqlite` or better-sqlite3; one writer, so the claim is one `UPDATE` |
| ✅ Delivery runner, all four modes, retry + backoff | |
| ✅ Resend provider | verified against the live API: delivery, idempotent retries, end-to-end pipeline |
| ✅ Route handler, session scoping, cron | |
| ✅ React client, optimistic updates, one event stream per browser with polling fallback | `GET /events`, `navigator.locks` leader, `BroadcastChannel` mirror |
| ✅ wake-ups: worker woken by `send()`, LISTEN/NOTIFY and change-stream signals, request-driven sweep | `signals`, `delivery.sweepOnRequest` |
| ✅ preferences plugin + headless `usePreferences` | the wedge |
| ✅ digests plugin, timezone-aware | |
| ✅ push plugin + web-push provider | VAPID + RFC 8291, no node:crypto |
| ✅ push verified against a live push service | Mozilla autopush, plus a cross-check against `http_ece` |
| ✅ telegram plugin + bot provider | one-tap linking, webhook or long-poll, blocked chats pruned |
| 🧪 mobile push plugin + Expo provider, React Native client entry (beta) | in testing; APIs may change before stable |
| ✅ scoped plugin storage, so plugins own their tables | |
| ✅ additive schema migrations on every SQL database | `planPostgresMigration()`, `planMysqlMigration()`, `planSqliteMigration()`; MongoDB reruns its index setup |
| ✅ failed deliveries reachable from the instance | `notify.getFailedDeliveries()` |
| ⬜ batching | |
| ⬜ Prisma adapter, Vue / Svelte bindings | Kysely already works through `postgresAdapter` |

---

## Writing an adapter

The one operation with no equivalent in other libraries is atomic claiming — without it, two concurrent sweeps send the same email twice. Verify yours:

```ts
import { adapterConformanceCases } from "easy-ping/testing";

for (const testCase of adapterConformanceCases) {
  it(testCase.name, () => testCase.run({ adapter, reset, setAttempts, lockRow }));
}
```

Fifteen cases, run against six backends in this repo (two Postgres paths, MongoDB, two MySQL paths, SQLite). The one that matters asserts a row locked by another transaction is *skipped*, not waited on; it is tagged `requires: "rowLock"`, and a store whose claim is a single atomic update filters it out rather than faking it.

Declare your dialect on the adapter so the plugin store writes what your driver expects:

```ts
naming: "snake_case" | "preserve"   // columns, or the declared field names
serializesJson: boolean             // json as a string, or natively
```

---

## Development

```bash
pnpm install
docker compose up -d     # Postgres on :54329, MongoDB on :27019, MySQL on :33069
pnpm test
```

Mongo runs as a single-node replica set, because that is the only way it offers transactions. SQLite needs nothing running: the suite uses Node's own `node:sqlite` in memory.

Database tests skip locally when a database is unreachable, and **fail** in CI — a green build that ran none of them is worse than a red one.

The push crypto is checked two ways. `web-push-reference.test.ts` decrypts our output with `http_ece` — the library `web-push` npm uses — because a decryptor written from the same RFC would share any misreading and agree with itself. `web-push-live.test.ts` then sends through Mozilla's production push service for real; it is opt-in so CI never goes red because someone else's service is having a bad afternoon:

```bash
EASY_PING_LIVE_PUSH=1 pnpm --filter easy-ping test web-push-live
```

The Resend provider is checked against Resend's real API too. The rejection paths need no credentials: a bogus key coming back as a structured 401 rather than a 400 is what proves the request shape is right. With a key, three more cases run: a real send returns a message id, the same delivery sent twice is one email (the idempotency key a retry relies on), and a notification goes all the way through `send()` and the cron sweep to a delivery marked `sent`:

```bash
RESEND_API_KEY=re_... RESEND_FROM="Acme <hi@acme.dev>" RESEND_TO=you@acme.dev   pnpm --filter easy-ping test resend-live
```

Without a verified domain, `RESEND_FROM="onboarding@resend.dev"` works but only delivers to your own Resend account's address.

## Releasing

Every release is automatic. Open a PR with a changeset:

```bash
pnpm changeset          # describe the change, pick patch/minor/major
```

On merge to `main`, the Release workflow opens a version PR. Merging *that* publishes to npm via
[trusted publishing](https://docs.npmjs.com/trusted-publishers/), tags the commit and opens a
GitHub Release from the changelog. No npm token is stored anywhere; the workflow mints a
short-lived OIDC token instead.

## License

MIT
