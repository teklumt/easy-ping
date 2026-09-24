# easy-ping

## 0.8.0

### Minor Changes

- [#15](https://github.com/teklumt/easy-ping/pull/15) [`496ddd1`](https://github.com/teklumt/easy-ping/commit/496ddd15d0e5fe6e9ab82fbda30bf56d901c8b85) Thanks [@teklumt](https://github.com/teklumt)! - React Native, and native push.
  
  - `easy-ping/react-native`: `useNotifications` and `createNativeNotifyClient` wire `AppState` (background = hidden, foreground = refresh), run as a single connection, and try the event stream first; a fetch that cannot stream falls back to polling on the first attempt, `expo/fetch` keeps the stream. `registerMobilePushDevice` / `unregisterMobilePushDevice` talk to the new routes.
  - `easy-ping/plugins/mobile-push`: the `mobilePush` channel. A per-user token registry (`POST/GET /mobile-push/devices`, `POST /mobile-push/devices/remove`; one owner per token, 409 otherwise, eviction past `maxDevicesPerUser`), batched fan-out, and `POST /mobile-push/receipts` (machine) that asks the provider for late verdicts and prunes devices reported gone. `POST /mobile-push/prune` for stale devices. `mobilePushSchema` exported for DDL.
  - `easy-ping/providers/expo-push`: `expoPush({ accessToken? })` over fetch. Batches of 100, receipts of 1000, per-token classification (`DeviceNotRegistered` prunes, `MessageRateExceeded` retries, `MessageTooBig` fails), access token redacted from errors.
  - Client: `GET /events` answered without a streamable body now disables streaming for the session at once instead of after three retries.
  - `Channel` gains `"mobilePush"`; the preferences plugin lists it.

## 0.7.0

### Minor Changes

- [`75b5964`](https://github.com/teklumt/easy-ping/commit/75b596444c88c7dfb0b412761db7c0217a7e28a8) Thanks [@teklumt](https://github.com/teklumt)! - Telegram as a channel.
  
  - `easy-ping/plugins/telegram`: `telegram({ provider, botUsername, render, webhookSecret?, linkTtlMinutes?, maxChatsPerUser?, messages? })` declares the `telegram` channel. `POST /telegram/link` mints a one-time `https://t.me/<bot>?start=<code>` link; the `/start <code>` message links the chat to the user. `GET /telegram/chats`, `POST /telegram/unlink`, and `POST /telegram/webhook` (mounted only with `webhookSecret`, authenticated by `X-Telegram-Bot-Api-Secret-Token`). `plugin.poll()` long-polls instead of a webhook. `telegramSchema` exported for DDL.
  - `easy-ping/providers/telegram`: `telegramBot({ token })` over fetch. `send` never throws: 429 is retryable with `retry_after`, 403 and "chat not found" mark the chat gone (pruned), other 400s fail without retry, 5xx and network retry. The token is redacted from every error. `getUpdates`, `setWebhook`, `deleteWebhook`, `getMe`.
  - `Channel` gains `"telegram"`; the preferences plugin lists it.

## 0.6.1

### Patch Changes

- [`fd4bf32`](https://github.com/teklumt/easy-ping/commit/fd4bf32c74cb0ce8ff8c4473041767c4ace97d7f) Thanks [@teklumt](https://github.com/teklumt)! - Security review of the event-driven transport.
  
  - Client: new `scope` option mixes a user or session key into the leader lock and tab channel names. Set it when identity is not a cookie, otherwise tabs signed in as different users could share a leader and mirror each other's inbox.
  - `GET /events` is capped: `events.maxStreamsPerUser` (10) returns 429 with `Retry-After`, `events.maxStreams` (5000) returns 503. A stream whose consumer stops reading is closed after 256 unread chunks.
  - The fallback database probe is shared per user instead of running once per stream.
  - `delivery.sweepOnRequest` runs only after a served (<400) response.
  - `instrument(fetch)` reads the inbox-version header only from same-origin responses.
  - Dev dependencies upgraded past published advisories (vitest, vite, tsup, esbuild, changesets); the production tree had none.

## 0.6.0

### Minor Changes

- [`c0577df`](https://github.com/teklumt/easy-ping/commit/c0577df70bcd47d8ee6f19cbad152975fc7527a5) Thanks [@teklumt](https://github.com/teklumt)! - The bell no longer lives on a timer.

  - `GET /events`: a server-sent event stream per user (`ready`, then `changed` whenever the inbox moves). No payload travels on it; the client refetches the feed. Off with `events: false`.
  - The client opens one stream per browser: a `navigator.locks` leader owns it, other tabs mirror its state over `BroadcastChannel`. Polling remains the fallback (after three short-lived streams the session gives up on streaming) and now backs off while the user is idle and snaps back on input. `transport: "auto" | "sse" | "poll"`, `safetyNetMs`, `activeWindowMs`; `getTransport()` reports the role.
  - `client.instrument(fetch)` refreshes when a response carries `notify.inboxHeaders(userId)`, so active users need no dedicated request at all.
  - `easy-ping/sw`: `handlePush(event)` shows the OS notification and relays a `changed` message to open tabs.
  - `signals`: the wake-up seam. `createMemorySignals` (default), `postgresSignals(sql)` over LISTEN/NOTIFY and `mongoSignals(db)` over a change stream for multi-replica deployments. Without a cross-process signal, the stream probes a change fingerprint every `events.probeIntervalMs` (30 s).
  - `startWorker()` is woken by `send()` in the same process; the default idle interval is now 10 s.
  - `toNodeHandler` now streams response bodies instead of buffering them, and aborts the web `Request` when the client disconnects. Without this the event stream never reached a browser through Express or plain Node.
  - `delivery.sweepOnRequest`: a bounded delivery pass after any request, throttled to every 5 s, for hosts that see traffic but no scheduler.

## 0.5.0

### Minor Changes

- [`bd64257`](https://github.com/teklumt/easy-ping/commit/bd642575bf9b4f8ea91405aeea066bff4a05c535) Thanks [@teklumt](https://github.com/teklumt)! - MySQL and SQLite adapters.

  - `mysqlAdapter(query, { prefix?, transaction? })` from `easy-ping/adapters/mysql`, with `mysql2Query(pool)`, `mysqlTransaction(pool)` and `createMysqlTables(query, { plugins? })`. MySQL 8 or MariaDB. With `transaction` a claim uses `FOR UPDATE SKIP LOCKED`; without it a lock-free `UPDATE … JOIN (SELECT … LIMIT)` that re-checks eligibility on the locked row, so two sweeps can never take the same delivery. Create the pool with `timezone: "Z"`.
  - `sqliteAdapter(query, { prefix?, transaction? })` from `easy-ping/adapters/sqlite`, with `sqliteQuery(db)`, `sqliteTransaction(db)` and `createSqliteTables(query, { plugins? })`. Works with `node:sqlite` (Node 22.13+), better-sqlite3 or anything with the same `prepare().all()/.run()` shape. Nothing is imported at module level, so the package's Node 20 floor holds.
  - `renderMysqlDdl` and `renderSqliteDdl` from `easy-ping/schema`. MySQL string columns become `VARCHAR(768)` when they are a single-column key, `VARCHAR(255)` in a composite key or when they carry a default, and `TEXT` otherwise, inside InnoDB's 3072-byte key limit; indexes are declared inline because MySQL has no `CREATE INDEX IF NOT EXISTS`.
  - The query contract for both is `(text, params) => Promise<{ rows, affectedRows }>`, since MySQL has no `RETURNING`. `PluginStore.update` on MySQL returns rows changed, not matched, unless the pool sets `FOUND_ROWS`.
  - Both run the full conformance, plugin-store and end-to-end suites alongside the Postgres and MongoDB backends. The plugin store now coerces `0/1` to booleans for date-less engines.
  - No additive migration planner for these dialects yet; `createMysqlTables` and `createSqliteTables` are bootstrap only.

### Patch Changes

- [`bd64257`](https://github.com/teklumt/easy-ping/commit/bd642575bf9b4f8ea91405aeea066bff4a05c535) Thanks [@teklumt](https://github.com/teklumt)! - Fix `planPostgresMigration` silently doing nothing on an existing database.

  `INTROSPECT_SQL` returns `table_name`/`column_name`/`data_type`/`is_nullable`, but `LiveColumn` is
  `table`/`column`/`type`/`nullable`, and the planner read the short names. Passing the exported
  query's rows straight through — which "so callers need not retype it" invites — built a map keyed
  on `undefined`, so every existing table looked new. The plan came back as `CREATE TABLE IF NOT
EXISTS` against tables that already exist, which is a no-op, with no `ALTER TABLE ADD COLUMN` at
  all and an empty `unsupported` list. It reported success and changed nothing.

  The practical effect: anyone upgrading to 0.4.0 by the documented path did not get
  `notification_preference.updated_at`, so unsubscribe-freshness checks had no column to read.

  The planner now accepts either shape, so raw rows and hand-mapped rows both work. Every existing
  test mapped the names by hand before calling it, which is why this survived; the new case passes
  the rows through untouched.

## 0.4.0

### Minor Changes

- 1b39afa: Security hardening across the handler, plugins and adapters.

  - **Push devices belong to one account.** `POST /push/devices` no longer upserts on `endpoint` alone, which let any user re-home another user's device by knowing its URL. Registering an endpoint owned by another account is a 409. Endpoints must be public https URLs with well-formed keys (`allowedEndpointHosts` pins them to known push services), and each user keeps at most `maxDevicesPerUser` rows (default 20). Fan-out is parallel, and a throttled device no longer counts as delivered.
  - **CSRF defence.** Every POST must be `application/json` (415) and a cross-origin `Origin` is refused (403) unless listed in the new `trustedOrigins` option.
  - **Secret strength.** `secret`, `cron.secret` and the new `machineSecret` must be at least 16 characters and not a placeholder; startup throws otherwise.
  - **Plugins no longer receive the secret.** `PluginInitContext.secret` is replaced by `sign()`, which mints tokens only for the purposes the plugin's own `signed` routes declare. Token keys are now derived per purpose with HKDF. **Outstanding tokens signed by 0.3.0 are invalid after upgrading**; unsubscribe links in already-sent email will need to be re-issued.
  - **Unsubscribe freshness.** `notification_preference` gains an `updatedAt` column (additive; `planPostgresMigration` emits it, Mongo needs nothing). A token issued before the user's later explicit change is refused; a repeat click is still a 200.
  - **Machine routes** can be guarded by a separate `machineSecret`; they fall back to `cron.secret`. `cron.maxSweeps` bounds one `/cron` call. `notify.listRoutes()` lists every route with its scope, and `custom`-scoped routes are named in a startup warning.
  - **Rate limiting.** `rateLimit: { max, windowMs, key? }` adds an in-process fixed-window limiter before routing; `createRateLimiter` is exported for use inside `onRequest`.
  - **No unhandled errors.** The handler returns a logged 500 instead of throwing, and `toNodeHandler` no longer rethrows after responding (which was an unhandled rejection under Express). It also caps request bodies, as does the handler (`maxBodyBytes`, default 64 KiB) via the new `readJsonBody`.
  - **Plugin store shape checks.** Where-clause values must be scalars or a single recognised operator, so a JSON body can no longer smuggle a Mongo operator through a plugin route; field lookups use `Object.hasOwn`.
  - **Preferences validation.** `type` must be a configured notification, `channel` and `frequency` must be valid, `enabled` must be a boolean.
  - `escapeHtml` is exported for email templates; the quickstart uses it. `onRequest` runs before routing. Responses carry `Cache-Control: private, no-store` and `nosniff`. Token TTLs are capped at 90 days and token `data` is validated. Email addresses are redacted from `last_error`. `basePath` matching is anchored to a path segment. The bearer comparison hashes both sides so it no longer leaks the secret's length.
  - Web push: the provider reports an unusable subscription as `invalid`, and the plugin prunes it instead of retrying five times.

## 0.3.0

### Minor Changes

- 699832c: Findings from building a real app on 0.2.0, fixed.

  **A delivery can now report `skipped`.** `DeliveryOutcome` gains
  `{ result: "skipped", reason }`, writing the `"skipped"` status the schema always had. Push uses
  it when a user has no registered device, so an opt-out no longer lands in
  `getFailedDeliveries` — the one view an operator reads to find real breakage. Skipped is
  terminal and never retried. `SweepResult` gains a `skipped` count.

  **A poll costs one request instead of two.** The feed response carries `unseenCount` on the first
  page, and the client stops calling `/count` alongside it. At a thousand open tabs on the default
  15s interval that is 133 req/s of pure badge-keeping halved. Paginating with a cursor omits it,
  since that is scrollback rather than a poll. A client on an older server falls back to `/count`.

  **`createPostgresTables(query, { plugins })`** renders and runs the DDL for core plus any plugin
  schemas, all `IF NOT EXISTS`. Every integration was hand-writing this file.

  **`pgTransaction(pool)`** replaces the sixteen lines of BEGIN/COMMIT/ROLLBACK/release that every
  node-postgres user copied, including the `finally` that leaks a connection per send when dropped.

  **`pushSchema` is exported standalone**, so rendering the push tables no longer means constructing
  the plugin — which meant inventing a provider and a render function you never intend to call.

## 0.2.0

### Minor Changes

- 59564d7: Postgres without an ORM.

  `postgresAdapter` takes a plain `(text, params) => rows` function instead of an ORM
  instance, so `pg`, `postgres.js`, Kysely, Neon and other serverless drivers all work
  with nothing extra in the dependency tree. It runs the same 14 conformance cases as
  the Drizzle and MongoDB adapters, including the `FOR UPDATE SKIP LOCKED` claim.

## 0.1.0

### Minor Changes

- 183de60: First release.

  Self-hosted, framework-agnostic, type-safe notifications: a `send()` pipeline with dedupe and hooks, four delivery modes over one cron sweep, retry with exponential backoff, and an atomic claim so two concurrent sweeps never send the same thing twice.

  - **Databases** — Postgres via Drizzle, and MongoDB. Both pass the same adapter conformance suite.
  - **Channels** — in-app, email (Resend), and web push (VAPID + RFC 8291 on Web Crypto, so it runs on Workers and Edge).
  - **Client** — a polling client with optimistic updates, and a React hook.
  - **Plugins** — preferences, digests and push, each owning its own tables through a scoped store.

  APIs may still move before 1.0.
