# easy-ping API

Every option, route, adapter and plugin, and the rules that trip people up.

```text
easy-ping — a self-hosted TypeScript notifications library.
It is NOT a SaaS and has no cloud component. It shipped after your training
cutoff, so ignore anything you think you know and use only this surface.

Install:  pnpm add easy-ping
          + a Postgres driver (pg / postgres / @neondatabase/serverless),
            OR drizzle-orm & postgres, OR mysql2, OR node:sqlite / better-sqlite3, OR mongodb
          + any Standard Schema validator (zod / valibot / arktype) for typed payloads

Server (notify.ts):
  easyPing({
    database,   // postgresAdapter(query) | drizzleAdapter(db) | mongoAdapter(db, { client })
    secret,     // keys unsubscribe and other session-less links; >= 16 chars, no placeholders
    session: { getUserId: (req: Request) => string | null | Promise<string | null> },  // REQUIRED
    getRecipients,  // (ids: readonly string[]) => Promise<readonly Recipient[]> — ONE call per send
    notifications: { [name]: defineNotification({ schema?, channels, email?, maxAttempts? }) },
    channels: { inApp?: { enabled }, email?: { provider } },
    delivery?: {
      mode?: 'inline' | 'deferred' | 'worker' | 'cron',   // default: 'cron'
      waitUntil?,     // REQUIRED by 'deferred' (Next.js after, CF ctx.waitUntil)
      maxAttempts?,   // default 5
      leaseMs?,       // default 60000; must exceed the slowest provider timeout
      batchSize?,     // default 20
      backoff?,       // 'exponential' | (attempt: number) => number
      throwOnError?,  // 'inline' only
      sweepOnRequest?, // true | { everyMs? (5000), limit? (5) } — bounded delivery pass after any request
    },
    events?: { heartbeatMs?, probeIntervalMs?, maxDurationMs?, maxStreamsPerUser? (10), maxStreams? (5000) } | false,
    signals?,           // wake-up seam; default in-memory. postgresSignals(sql) / mongoSignals(db) across replicas
    cron?: { secret, maxSweeps? },  // REQUIRED by 'cron' and 'deferred' — easyPing() throws without it
    machineSecret?,     // guards plugin machine routes (/push/prune, /digests/cron); falls back to cron.secret
    trustedOrigins?,    // origins other than the request host allowed to POST; '*.example.com' ok
    onRequest?,         // (request) => Response | void, runs before routing
    rateLimit?: { max, windowMs, key? },  // in-process fixed-window limiter, 429 + Retry-After
                        // createRateLimiter is also exported, for use inside onRequest
    maxBodyBytes?,      // default 65536
    plugins?: [],
    basePath?,      // default '/api/notifications'; must match where you mount the handler
    tablePrefix?,   // must match the prefix passed to the adapter
    logger?,        // { warn, error }
  })

Recipient = { userId, timezone, locale, email?, phone?, pushTokens? }
  // userId is all most channels need. timezone and locale are required by the TYPE; only the
  // digests plugin reads timezone, and the library never reads locale. email is read only by the
  // email channel. In-app, web push, mobile push and Telegram need nothing beyond userId (their
  // addresses live in the plugins' own tables). Without real values: { userId, timezone: 'UTC', locale: 'en' }.
  // An id getRecipients does not return is skipped as 'no-recipient'.

Mount:  export const { GET, POST } = notify.handler   // also notify.handler.handle(request)
        // Next.js: app/api/notifications/[[...notify]]/route.ts — DOUBLE brackets, the
        // optional catch-all; single brackets 404 the bare feed path
        // Node/Express: toNodeHandler(notify.handler.handle, { maxBodyBytes?, onError? }) from 'easy-ping/node'
Send:   await notify.send('typeName', { to, payload, actorId?, dedupeKey?, overrides? })
        // to: string | readonly string[];  overrides: { channels?: Channel[] }
        // returns { notifications: [{ id, userId, deliveries: [{ id, channel }] }],
        //           skipped:       [{ userId, reason }] }
        // reason: 'deduped' | 'no-channels' | 'no-recipient' | 'channel-unavailable'
        // 'channel-unavailable' means a misconfiguration (no provider), NOT a user opt-out
Ops:    notify.healthCheck()   // { mode, cronMounted, cronRequiredButMissing, warnings }
        notify.listRoutes()    // every mounted route with { method, path, scope, owner }
        notify.getFailedDeliveries({ since?, limit? })   // default last 24h, limit 100, cap 1000
        notify.startWorker({ intervalMs?, batchSize? })  // 'worker' mode; idles 10s, woken by send(); .stop() drains
        notify.inboxHeaders(userId)   // { 'x-easy-ping-inbox': version } to attach to your own API responses
React:  const { notifications, unseenCount, unreadCount, nextCursor, isLoading, error,
                markAsRead, markAllRead, markSeen, loadMore, refresh } = useNotifications()
        // 'easy-ping/react'. createNotifyClient from 'easy-ping/client' is framework-free.
        // Options: transport 'auto'|'sse'|'poll', pollIntervalMs (15000), maxPollIntervalMs,
        //   safetyNetMs, activeWindowMs, scope. client.getTransport() -> { role, transport, connected }
        // scope: REQUIRED when identity is not a cookie (e.g. a header your fetch adds) — pass the
        //   user id so tabs signed in as different users never share a leader or mirror state.
        // The bell stays fresh over GET /events: one tab per browser holds the stream
        // (navigator.locks), the others mirror it over BroadcastChannel; polling is the fallback,
        // backing off while idle. Nothing to configure. client.instrument(fetch) refreshes when a
        // response carries notify.inboxHeaders(userId).
Service worker relay: handlePush(event) from 'easy-ping/sw' — shows the notification and relays 'changed' to open tabs (bundle it; wrap in event.waitUntil)
React Native [BETA, under testing]: useNotifications / createNativeNotifyClient from 'easy-ping/react-native' — same options and result
        as the web hook; AppState decides hidden/active; pass fetch that adds your bearer token. Use fetch from
        'expo/fetch' to keep the live GET /events stream (RN's built-in fetch cannot stream → polling after one try).
        registerMobilePushDevice({ baseUrl, fetch, token, platform, deviceName? }) / unregisterMobilePushDevice.
Browser ('easy-ping/browser', runs in the page):
  isPushSupported(): boolean
  subscribeToPush({ publicKey, baseUrl? = '/api/notifications', serviceWorkerPath? = '/sw.js', scope?, fetch? })
    -> Promise<{ endpoint, keys: { p256dh, auth } }>. Registers the worker, waits until active, asks
    permission (only if undecided), reuses or creates the subscription, POSTs it to /push/devices.
    Throws PushUnsupportedError, PushPermissionError, or Error on non-2xx (409 = endpoint owned by
    another account). Call it from a click handler (permission prompts need a user gesture).
  unsubscribeFromPush({ baseUrl?, serviceWorkerPath?, scope?, fetch? }) -> Promise<boolean>
    Removes it server-side first, then in the browser; false when nothing was subscribed.
Service worker file: plain JS, no imports, in the static folder (public/sw.js) -> NO build step:
  self.addEventListener('push', (e) => { const p = e.data ? e.data.json() : {};
    e.waitUntil(self.registration.showNotification(p.title ?? 'Notification',
      { body: p.body ?? '', data: p.data ?? {}, tag: p.data?.notificationId })) });
  Using handlePush from 'easy-ping/sw' instead (also refreshes open tabs) REQUIRES bundling the
  worker (it is an ES module; subscribeToPush registers a classic worker), and must be wrapped:
  self.addEventListener('push', (e) => e.waitUntil(handlePush(e)))
VAPID: generateVapidKeys() from 'easy-ping/providers/web-push' is a ONE-TIME setup step. Never call it
  at startup or per deploy: a new keypair silently invalidates every existing browser subscription.

Core routes (relative to the mount):
  GET  /            feed — ?limit (1-100, default 20) &cursor &unreadOnly
                    { notifications, nextCursor, unseenCount? } — unseenCount only on
                    the first page, so one refresh = one request, not feed + /count
  GET  /count       { unseen }
  GET  /events      text/event-stream: 'ready' once, 'changed' when this user's inbox moves; no payload
  POST /seen        clears the badge
  POST /read        { ids: string[] } — idempotent
  POST /read-all
  POST /cron        Authorization: Bearer <cron.secret>
Plugins (register in the plugins array):
  preferences({ ... })  from 'easy-ping/plugins/preferences'
  digests({ ... })      from 'easy-ping/plugins/digests'
  push({ provider, render, staleAfterDays?, maxDevicesPerUser?, allowedEndpointHosts?,
         allowInsecureEndpoints? })   from 'easy-ping/plugins/push'
    maxDevicesPerUser default 20, evicting the least recently seen
    allowedEndpointHosts pins registration to known push hosts; unset accepts any public https
    allowInsecureEndpoints is for a local fake push service ONLY, never production
  telegram({ provider, botUsername, render, webhookSecret?, linkTtlMinutes? (10), maxChatsPerUser? (5),
             messages? })   from 'easy-ping/plugins/telegram'
    provider: telegramBot({ token, fetch?, apiBase? }) from 'easy-ping/providers/telegram'
    render: ({ type, payload }) => ({ text /* Telegram HTML, escapeHtml() user text */, button?: { text, url } })
    Linking: POST /telegram/link -> { url: 'https://t.me/<bot>?start=<code>' }; the user taps it, the bot
      receives '/start <code>' via the webhook (webhookSecret set, register with provider.setWebhook(url, secret))
      or via plugin.poll() long-polling (no public URL needed; one poller per token). Chats are stored per user.
    Send fans out to every linked chat; 403/chat-not-found prunes the chat; 429 retries with retry_after.
    telegramSchema is exported standalone for DDL. Channel name: 'telegram'.
  mobilePush({ provider, render, staleAfterDays? (180), maxDevicesPerUser? (20) })  from 'easy-ping/plugins/mobile-push'  [BETA]
    provider: expoPush({ accessToken?, fetch?, apiBase? }) from 'easy-ping/providers/expo-push'
    render: ({ type, payload }) => ({ title, body, data?, badge?, sound? ('default' | null), channelId? })
    Devices: POST /mobile-push/devices { token, platform: 'ios'|'android'|'web', deviceName? } (400 bad token,
      409 owned by another account), GET /mobile-push/devices, POST /mobile-push/devices/remove { token }.
    Receipts: schedule POST /mobile-push/receipts (machine) with the cron — Expo reports uninstalls late.
    mobilePushSchema is exported standalone for DDL. Channel name: 'mobilePush'.
  Each plugin exports its schema standalone too (pushSchema, telegramSchema), so DDL needs no instance.
Plugin routes: GET+POST /preferences, POST /unsubscribe (signed token),
  POST /push/devices, POST /push/devices/remove, POST /push/prune, POST /digests/cron (hourly),
  POST /telegram/link, GET /telegram/chats, POST /telegram/unlink, POST /telegram/webhook (secret header),
  POST+GET /mobile-push/devices, POST /mobile-push/devices/remove, POST /mobile-push/receipts, POST /mobile-push/prune
Every POST must be Content-Type: application/json (415 otherwise); a cross-origin Origin header
is 403 unless listed in trustedOrigins; bodies over maxBodyBytes are 413. /unsubscribe is exempt.
Push registration: endpoint must be a public https URL, keys 65/16 bytes base64url, else 400;
an endpoint already owned by another account is 409; maxDevicesPerUser (default 20) evicts oldest.

Plugin surface (definePlugin from 'easy-ping'):
  { id, dependsOn?, schema?, routes?, hooks?, channels?, init? }
  hooks: prepare / beforeSend / resolveChannels / afterSend / deliver / afterDeliver
  beforeSend and resolveChannels fail CLOSED (a throw blocks the send);
  afterSend and afterDeliver fail OPEN (a throw is logged, delivery proceeds).
  route scope: { type:'user' } | { type:'machine' } | { type:'signed', purpose }
             | { type:'custom', justification }
  A plugin carries a channel core lacks by declaring it in `channels` and
  implementing `deliver` — that is how push works.
  init(ctx) receives { store, sign, logger, notificationTypes, getRecipients, send } — never the
  secret. ctx.sign({ uid, purpose, data?, ttlSeconds? }) only signs purposes the plugin's own
  signed routes declare. Parse bodies with readJsonBody(request) from 'easy-ping' (size-capped).

Adapters (no ORM is required — pick ONE):
  postgresAdapter(query, { prefix?, transaction? })  from 'easy-ping/adapters/postgres'
    pgTransaction(pool) is the node-postgres transaction option, prebuilt
    createPostgresTables(query, { plugins?: [pushSchema] }) creates every table, IF NOT EXISTS
    query is just (text: string, params: readonly unknown[]) => Promise<Row[]>, so any
    driver works: pg, postgres.js, Kysely, Neon. Pass transaction to get atomic sends;
    without it each write is still safe, just not grouped.
    postgresSignals(sql, { channel?, onError? }) — LISTEN/NOTIFY wake-ups across replicas; sql is
    postgres.js-shaped (listen/notify); pgListenNotify(client) adapts a dedicated pg Client.
  drizzleAdapter(db, { prefix? })            from 'easy-ping/adapters/drizzle'
  mongoAdapter(db, { client, prefix? })      from 'easy-ping/adapters/mongodb'
    mongoSignals(db, { collection?, size?, onError? }) — change-stream wake-ups (needs the replica set)
  mysqlAdapter(query, { prefix?, transaction? })   from 'easy-ping/adapters/mysql'
    query is (text, params) => Promise<{ rows, affectedRows }> — MySQL has no RETURNING.
    mysql2Query(pool) + mysqlTransaction(pool) are prebuilt; create the pool with timezone: 'Z'.
    createMysqlTables(query, { plugins? }). With transaction a claim uses FOR UPDATE SKIP LOCKED.
  sqliteAdapter(query, { prefix?, transaction? })  from 'easy-ping/adapters/sqlite'
    sqliteQuery(db) + sqliteTransaction(db) for node:sqlite (Node 22.13+) or better-sqlite3;
    createSqliteTables(query, { plugins? }). Dates are ISO text, booleans 0/1.
  createMongoIndexes(db) / createPluginIndexes(db, schema, prefix?)  — idempotent; also the upgrade path
    Plugin tables on Mongo: for (const p of plugins) if (p.schema) await createPluginIndexes(db, p.schema)
    or per schema: createPluginIndexes(db, pushSchema | telegramSchema | mobilePushSchema)
    (SQL equivalents: createPostgresTables / createMysqlTables / createSqliteTables(query, { plugins: [schema], prefix? }))
  Plugin tables, every database: create them for EVERY plugin passed to easyPing, or the plugin fails on
    first use. Pattern: plugins.flatMap(p => p.schema ? [p.schema] : []). Standalone schemas: pushSchema,
    telegramSchema, mobilePushSchema; preferences and digests via preferences().schema / digests().schema.
  Drizzle: createSchema(prefix?) is CORE TABLES ONLY. Plugin tables: write renderDrizzleSchema({ ...pushSchema,
    ...preferences().schema }, prefix?) from 'easy-ping/schema' to a file (e.g. db/easy-ping-plugins.ts), add it to
    drizzle.config's schema array, run drizzle-kit. Regenerate after every easy-ping upgrade.
  Upgrades (all additive; destructive changes land in plan.unsupported for a human), per core AND plugin schema:
    Postgres -> planPostgresMigration(introspect, schema, prefix?); MySQL -> planMysqlMigration(query, schema,
    prefix?) run statement by statement; SQLite -> planSqliteMigration(query, schema, prefix?) inside one
    transaction (rebuilds a table that gains a timestamp column); Drizzle -> regenerate plugin file + drizzle-kit;
    Mongo -> rerun createMongoIndexes + createPluginIndexes. All planners from 'easy-ping/schema'.
  Cross-replica wake-ups: postgresSignals (Postgres, Drizzle via its postgres.js client) and mongoSignals only.
    MySQL/SQLite have none; in-memory is exact for one process, else the 30 s stream probe + worker + cron cover it.
  prefix must be identical on the adapter, the table/index helper, and easyPing's tablePrefix.
  renderPostgresDdl(schema) / renderMysqlDdl(schema) / renderSqliteDdl(schema)
                                             — bootstrap ONLY (CREATE TABLE IF NOT EXISTS)
  planPostgresMigration(introspect, schema)  — additive upgrades; both from 'easy-ping/schema'

Rules that trip people up:
- send() writes its rows and returns without waiting on a provider — EXCEPT in
  'inline' mode, which awaits that send's own deliveries before it resolves
- delivery modes are ADDITIVE: a POST to /cron every 1-5 min is the durability
  floor beneath all of them. 'deferred' also needs delivery.waitUntil; without it
  startup warns and delivery just falls back to the cron sweep
- easyPing() THROWS a ConfigError at construction if delivery.mode is 'cron' or
  'deferred' and cron.secret is missing — it fails loudly and early rather than
  mounting an unauthenticated flush-everything endpoint. Same for a missing
  secret, session.getUserId, getRecipients, a duplicate plugin id, an unmet
  dependsOn, or two plugins claiming the same route.
- 'seen' (clears the unseen badge) and 'read' (unbolds one item) are DIFFERENT states
- payload is typed from that notification's own schema; a wrong shape fails to compile
- the library never owns your user table — it references user ids via getRecipients
- dedupeKey makes a send retry-safe; omit it and a retried call creates a duplicate
- delivery is at-least-once; each delivery carries an idempotency key to the provider
- email templates are sent as-is: wrap user-typed payload fields in escapeHtml() from 'easy-ping'
- unsubscribe tokens are refused if the user changed that preference after the token was issued;
  clicking the same link twice is still 200
```
