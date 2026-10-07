/**
 * The release catalog shown at /docs/changelog.
 *
 * Hand-maintained, and deliberately so: this is the human-readable story of
 * what changed and why, which a generated CHANGELOG from commit messages
 * cannot give you. Keep it in sync with packages/easy-ping/CHANGELOG.md in the
 * library repo when you cut a release — see the README's
 * "Staying in sync with the library" section.
 *
 * Newest first. `date` is ISO so it sorts and formats predictably.
 */

export type ChangeKind = "added" | "fixed" | "changed" | "security";

export type Change = {
  kind: ChangeKind;
  title: string;
  /** Why it matters — skip it if the title already says everything. */
  detail?: string;
};

export type Release = {
  version: string;
  date: string;
  /** One line on what this release is about. */
  summary: string;
  /** Marks the entry rendered as the current version. */
  current?: boolean;
  changes: readonly Change[];
};

export const RELEASES: readonly Release[] = [
  {
    version: "0.10.2",
    date: "2026-10-07",
    summary:
      "Package metadata now says what it is: free and open-source, with every channel and database it supports listed up front.",
    current: true,
    changes: [
      {
        kind: "changed",
        title: "Description leads with free and open-source",
        detail:
          "Lists every channel (in-app, email, web push, mobile push, Telegram) and database " +
          "(Postgres, MySQL, SQLite, MongoDB) up front, instead of the old one-liner.",
      },
      {
        kind: "changed",
        title: "Readme comparison table catches up",
        detail:
          '"Where notifications live" now lists MySQL and SQLite alongside Postgres and MongoDB, ' +
          'and "Channels out of the box" includes mobile push (beta).',
      },
    ],
  },
  {
    version: "0.10.1",
    date: "2026-10-07",
    summary: "Package homepage now points at the project site instead of the GitHub readme.",
    changes: [
      {
        kind: "changed",
        title: "homepage points to easy-pings.com",
        detail:
          "Also added novu-alternative, knock-alternative, courier-alternative, inbox and " +
          "notification-center to keywords, for npm and GitHub search.",
      },
    ],
  },
  {
    version: "0.10.0",
    date: "2026-10-02",
    summary: "Fixes from the 0.9.0 security review; two behaviour changes, covered in Upgrading.",
    changes: [
      {
        kind: "security",
        title: "Rate limiting is no longer silently off without proxy headers",
        detail:
          "With no `cf-connecting-ip`, `x-real-ip` or `x-forwarded-for`, requests used to be exempt; " +
          "they now share one bucket and a warning is logged once. The limiter tracks at most 10 000 " +
          "keys, so spoofed headers cannot grow memory. Behaviour change: see Upgrading.",
      },
      {
        kind: "security",
        title: "An empty user id is no longer a user",
        detail:
          '`getUserId` returning `""` or a non-string is a 401, so anonymous visitors cannot share ' +
          'one inbox. A user whose id is literally `"error"` no longer gets a 500. Behaviour change.',
      },
      {
        kind: "fixed",
        title: "React `useNotifications` forwards `scope`",
        detail:
          "It accepted `scope` and dropped it, so the cross-user tab fix from 0.6.1 only worked through " +
          "`createNotifyClient`.",
      },
      {
        kind: "security",
        title: "Hardening across adapters, push, Telegram and the Node adapter",
        detail:
          "Bounded push tokens, bound `pg_notify` parameters, off-curve push keys pruned instead of " +
          "retried, Telegram updates shape-checked with one live link code per user, " +
          "`x-forwarded-proto` parsed safely, no hang when a client leaves mid-stream, plugin routes " +
          "cannot shadow core routes, read-only plugin tables, and no whole-table update or remove.",
      },
      {
        kind: "fixed",
        title: "Upserts with nothing to update on Postgres and Drizzle",
        detail: "They emitted an invalid `DO UPDATE SET`; they now emit `DO NOTHING`.",
      },
    ],
  },
  {
    version: "0.9.0",
    date: "2026-09-27",
    summary:
      "Every SQL database can now be upgraded in place, and email is verified against Resend's live API.",
    changes: [
      {
        kind: "added",
        title: "`planMysqlMigration` and `planSqliteMigration`",
        detail:
          "From `easy-ping/schema`, taking the same query function as the adapters. Additive only, " +
          "like `planPostgresMigration`: missing tables, columns and indexes are emitted, and anything " +
          "destructive lands in `plan.unsupported` for a human. MySQL checks existing indexes first, " +
          "since it has no `CREATE INDEX IF NOT EXISTS`; SQLite rebuilds a table that gains a timestamp " +
          "column, because `ADD COLUMN` cannot carry that default.",
      },
      {
        kind: "fixed",
        title: "Digests declared a partial copy of the preference table",
        detail:
          "It now reuses the core definition, so migration planners no longer report `updated_at` as " +
          "undeclared.",
      },
      {
        kind: "changed",
        title: "The Resend provider is verified against the live API",
        detail:
          "A real send, idempotent retries (the same delivery sent twice is one email) and a full " +
          "`send()` to delivered pass through the cron sweep.",
      },
      {
        kind: "added",
        title: "Docs: stability policy, and a build check that keeps every database page complete",
        detail:
          "A new Stability and versioning page says what is frozen before 1.0 and how a breaking " +
          "change ships. The site build now fails if any database or channel page misses plugin " +
          "tables, upgrades, prefix or wake-ups.",
      },
    ],
  },
  {
    version: "0.8.1",
    date: "2026-09-26",
    summary: "React Native support and the mobilePush channel are labelled beta in the readme.",

    changes: [
      {
        kind: "changed",
        title: "React Native and mobile push marked beta",
        detail:
          "Both are in beta while we test them across more devices and setups, so their APIs and " +
          "defaults may change in a minor release before they are marked stable. Readme only; no code " +
          "changes.",
      },
    ],
  },
  {
    version: "0.8.0",
    date: "2026-09-24",
    summary: "React Native and native push through Expo, both in beta while we test them.",

    changes: [
      {
        kind: "added",
        title: "`easy-ping/react-native` (beta) — the same client, wired for a phone",
        detail:
          "`useNotifications` and `createNativeNotifyClient` use `AppState` for hidden vs. active, run " +
          "as a single connection, and try the event stream first. React Native's built-in fetch cannot " +
          "stream, so the client polls after one attempt; pass `fetch` from `expo/fetch` and the bell is " +
          "as live as on the web. `registerMobilePushDevice` and `unregisterMobilePushDevice` included.",
      },
      {
        kind: "added",
        title: "`mobilePush` channel (beta): `mobilePush` plugin + `expoPush()` provider",
        detail:
          "A per-user token registry (one owner per token, 409 otherwise, eviction past the cap), " +
          "batched fan-out to every device, and `POST /mobile-push/receipts` for the verdict Expo only " +
          "learns from APNs/FCM after accepting the message. Devices reported gone are pruned on the " +
          "spot or by receipt. The provider interface is small enough that a direct FCM or APNs " +
          "provider slots in without touching the plugin.",
      },
      {
        kind: "changed",
        title: "A fetch that cannot stream falls back to polling at once",
        detail:
          "`GET /events` answered without a body used to count as three failed streams before the " +
          "client gave up. It now switches on the first attempt, so a non-streaming runtime costs " +
          "nothing but the live updates.",
      },
      {
        kind: "changed",
        title: "`Channel` gains `mobilePush`; preferences lists it",
      },
    ],
  },
  {
    version: "0.7.0",
    date: "2026-09-24",
    summary: "Telegram as a channel: a bot the user connects with one tap.",
    changes: [
      {
        kind: "added",
        title: "`telegram` plugin + `telegramBot()` provider",
        detail:
          "From `easy-ping/plugins/telegram` and `easy-ping/providers/telegram`. `POST /telegram/link` " +
          "returns a one-time `t.me/<bot>?start=<code>` link; the user taps it, the bot stores the chat, " +
          "and every send with `telegram` in its channels reaches it. HTML messages with an optional " +
          "inline button, link previews off. Updates arrive through a webhook authenticated by " +
          "Telegram's secret-token header, or through `plugin.poll()` where there is no public URL.",
      },
      {
        kind: "added",
        title: "Failure classification on the Bot API",
        detail:
          "429 retries with Telegram's `retry_after`; 403 and “chat not found” prune the chat on the " +
          "spot so the next send skips instead of failing; malformed HTML fails without retry and keeps " +
          "the chat. The bot token never appears in an error or a log line.",
      },
      {
        kind: "changed",
        title: "`Channel` gains `telegram`; preferences lists it",
        detail: "The union is closed, so the one core change is the new member.",
      },
    ],
  },
  {
    version: "0.6.1",
    date: "2026-09-24",
    summary:
      "Security review of the event-driven transport: stream caps, scoped tab groups, shared probes.",
    changes: [
      {
        kind: "security",
        title: "`scope` keeps tabs signed in as different users apart",
        detail:
          "The leader lock and tab channel were named after the mount alone, so when identity is " +
          "not a cookie (a header your custom fetch adds) two users' tabs could share a leader and " +
          "mirror each other's inbox. Pass `scope: userId`; cookie-based apps need nothing.",
      },
      {
        kind: "security",
        title: "Event streams are capped per user and per process",
        detail:
          "`events.maxStreamsPerUser` (10) answers a 429 with Retry-After; `events.maxStreams` " +
          "(5000) answers a 503. One valid session could previously hold every socket and timer. " +
          "A stream whose consumer stops reading is closed after 256 unread chunks.",
      },
      {
        kind: "fixed",
        title: "One database probe per user, however many streams they hold",
        detail:
          "Without a cross-process signal each stream probed on its own timer, so ten tabs meant " +
          "twenty queries per interval. Probes are now shared and reference-counted.",
      },
      {
        kind: "security",
        title:
          "`sweepOnRequest` only after served requests; inbox header only from the page's origin",
        detail:
          "Anonymous 401s no longer trigger a delivery pass, and `instrument(fetch)` ignores the " +
          "inbox-version header on third-party responses.",
      },
      {
        kind: "changed",
        title: "Dev tooling upgraded past published advisories",
        detail:
          "vitest, vite, tsup, esbuild and changesets. The production dependency tree had none; " +
          "the package ships one runtime dependency.",
      },
    ],
  },
  {
    version: "0.6.0",
    date: "2026-09-23",
    summary:
      "The bell no longer lives on a timer: one event stream per browser, wake-ups instead of polls.",
    changes: [
      {
        kind: "added",
        title: "`GET /events` — a server-sent event stream per user",
        detail:
          "`ready` once, then `changed` whenever this user's inbox moves: after a send, a /read, a " +
          "/seen. No payload travels on it; the client refetches the first page. `events: false` " +
          "removes the route. Keepalive every 25 s, optional `maxDurationMs` for hosts with a cap.",
      },
      {
        kind: "changed",
        title: "The client holds one stream per browser and polls only as a fallback",
        detail:
          "A `navigator.locks` leader owns the connection; other tabs mirror its state over " +
          "`BroadcastChannel`, so ten tabs cost one connection and zero idle queries. If a host cuts " +
          "three streams in a row the session falls back to polling, which now backs off while the " +
          'user is idle and snaps back on input. `transport: "poll"` restores the old behaviour.',
      },
      {
        kind: "added",
        title: "`signals` — the wake-up seam, with Postgres and MongoDB implementations",
        detail:
          "`postgresSignals(sql)` over LISTEN/NOTIFY and `mongoSignals(db)` over a change stream " +
          'carry "something changed, go look" across replicas. In-memory by default; without a ' +
          "cross-process signal each stream probes a cheap inbox fingerprint every 30 s.",
      },
      {
        kind: "changed",
        title: "`startWorker()` is woken by `send()`; the default idle interval is 10 s",
        detail:
          "The loop no longer claims every second. A send in the same process (or, with a signal, " +
          "any process) wakes it at once, so the interval only bounds work committed elsewhere.",
      },
      {
        kind: "added",
        title: "`delivery.sweepOnRequest` — deliver on the next page load, not the next cron",
        detail:
          "A bounded pass after any request, at most every 5 s per process. For free-tier hosts " +
          "that see traffic but no scheduler for minutes at a time. Ignored in `inline` mode.",
      },
      {
        kind: "fixed",
        title: "`toNodeHandler` streams response bodies and aborts on client disconnect",
        detail:
          "It used to buffer the whole body before writing, which every JSON route survived and " +
          "the event stream did not: through Express or plain Node the browser never saw a byte. " +
          "Found by running the built client against the demo server over real HTTP.",
      },
      {
        kind: "added",
        title: "`notify.inboxHeaders(userId)` + `client.instrument(fetch)`, and `easy-ping/sw`",
        detail:
          "Your own API responses can carry the inbox version and the bell refreshes only when it " +
          "moves. `handlePush(event)` from the new service-worker entry shows the OS notification " +
          "and relays a `changed` message to open tabs.",
      },
    ],
  },
  {
    version: "0.5.0",
    date: "2026-09-23",
    summary: "MySQL and SQLite, on the same conformance suite as everything else.",
    changes: [
      {
        kind: "added",
        title: "`mysqlAdapter` — MySQL 8 or MariaDB through any driver",
        detail:
          "From `easy-ping/adapters/mysql`, with `mysql2Query`, `mysqlTransaction` and " +
          "`createMysqlTables`. With a transaction a claim uses FOR UPDATE SKIP LOCKED; without " +
          "one it is a single lock-free UPDATE that re-checks eligibility on the locked row, so two " +
          'sweeps can never take the same delivery. Create the pool with `timezone: "Z"`.',
      },
      {
        kind: "added",
        title: "`sqliteAdapter` — node:sqlite, better-sqlite3 or anything with the same shape",
        detail:
          "From `easy-ping/adapters/sqlite`, with `sqliteQuery`, `sqliteTransaction` and " +
          "`createSqliteTables`. SQLite has one writer, so the claim is one UPDATE. Nothing is " +
          "imported at module level, so the Node 20 floor holds.",
      },
      {
        kind: "added",
        title: "`renderMysqlDdl` and `renderSqliteDdl`",
        detail:
          "MySQL string columns are sized to InnoDB's 3072-byte key limit and indexes are declared " +
          "inline, since MySQL has no CREATE INDEX IF NOT EXISTS. Bootstrap only: no migration " +
          "planner for these dialects yet.",
      },
      {
        kind: "changed",
        title: "Six backends run every suite",
        detail:
          "The conformance suite grew from 44 to 87 cases and the whole suite from 437 to 604 " +
          "tests without a new assertion: the two MySQL paths and SQLite run the existing ones. " +
          "The plugin store now reads 0/1 back as booleans for engines without a boolean column.",
      },
      {
        kind: "fixed",
        title: "A concurrent lock-free MySQL claim could deadlock",
        detail:
          "InnoDB rolls the loser back and asks for a retry; the adapter now does so, bounded and " +
          "jittered. Found by the eight-caller conformance case on the first full run.",
      },
    ],
  },
  {
    version: "0.4.0",
    date: "2026-09-22",
    summary:
      "A security review of 0.3.0, and every finding from it closed. Two changes break 0.3.0 " +
      "consumers: tokens are re-keyed, and plugins no longer receive the secret.",
    changes: [
      {
        kind: "security",
        title: "A push endpoint belongs to one account",
        detail:
          "Registration upserted on `endpoint` alone and rewrote `user_id`, so anyone who knew a " +
          "device's endpoint URL could re-home it and silently take its pushes. Another account " +
          "registering an owned endpoint is now a 409; the owner can still refresh their keys.",
      },
      {
        kind: "security",
        title: "CSRF defence on every POST",
        detail:
          "`application/json` is required (415) and a cross-origin `Origin` is refused (403) unless " +
          "listed in the new `trustedOrigins`. Holds even with a `SameSite=None` cookie. The signed " +
          "`/unsubscribe` route stays form-tolerant for one-click mail clients.",
      },
      {
        kind: "security",
        title: "Push endpoints are validated at registration",
        detail:
          "Public https only, no loopback or private hosts, well-formed 65/16-byte keys, optional " +
          "`allowedEndpointHosts`. Closes the server-side request the plugin made to any URL a user " +
          "supplied. Unusable subscriptions are pruned instead of retried five times.",
      },
      {
        kind: "security",
        title: "Secrets must be real",
        detail:
          "`secret`, `cron.secret` and the new `machineSecret` must be 16+ characters and not a " +
          "placeholder, or startup throws. A one-character HMAC key made every unsubscribe link " +
          "forgeable offline.",
      },
      {
        kind: "security",
        title: "Plugins get `sign()`, not the secret",
        detail:
          "Keys are derived per purpose with HKDF and a plugin can only mint tokens for purposes its " +
          "own signed routes declare. Every 0.3.0 token stops verifying; re-issue unsubscribe links.",
      },
      {
        kind: "security",
        title: "Unsubscribe links cannot undo a newer decision",
        detail:
          "Tokens carry their issue time and `notification_preference` gains `updatedAt`. A link " +
          "older than the user's last explicit change is refused; a repeat click is still a 200.",
      },
      {
        kind: "fixed",
        title: "A thrown adapter error no longer crashes the Node process",
        detail:
          "`toNodeHandler` rethrew after responding, which under Express is an unhandled rejection. " +
          "The handler now returns a logged 500 everywhere, and `toNodeHandler` takes `onError`.",
      },
      {
        kind: "fixed",
        title: "A throttled push device was counted as delivered",
        detail:
          "A 429 from the push service marked the delivery sent. It is now retryable, and fan-out " +
          "runs in parallel so one dead endpoint cannot hold the sweep to the timeout.",
      },
      {
        kind: "fixed",
        title: "Date columns came back as strings through Drizzle over postgres.js",
        detail: "The plugin store now coerces declared date fields, matching the other adapters.",
      },
      {
        kind: "changed",
        title: "Bodies capped, responses private, errors redacted",
        detail:
          "64 KiB default via `maxBodyBytes` and the new `readJsonBody`; `Cache-Control: private, " +
          "no-store` and `nosniff` on every response; email addresses stripped from `last_error`; " +
          "`basePath` anchored to a path segment; the bearer compare no longer leaks secret length.",
      },
      {
        kind: "changed",
        title: "Preference writes are validated",
        detail:
          "`type` must be a configured notification, `channel` and `frequency` valid, `enabled` a " +
          "boolean. The plugin store also refuses non-scalar values, so a JSON body can no longer " +
          "carry a Mongo operator into a query.",
      },
      {
        kind: "added",
        title: "`rateLimit`, `onRequest`, `machineSecret`, `cron.maxSweeps`, `listRoutes()`",
        detail:
          "An in-process limiter before routing, a hook for your own, a separate credential for " +
          "plugin machine routes, a bound on one cron drain, and the route inventory RFC 0002 " +
          "promised. `custom`-scoped routes are named in a startup warning.",
      },
      {
        kind: "added",
        title: "`escapeHtml`, `maxDevicesPerUser`",
        detail:
          "The quickstart template now escapes user input; each user keeps at most 20 devices by " +
          "default. The repo's own examples and demo were fixed to match.",
      },
    ],
  },
  {
    version: "0.3.0",
    date: "2026-09-22",
    summary: "What building a real app on 0.2.0 turned up.",
    changes: [
      {
        kind: "fixed",
        title: "Docs: the route mount was wrong, and it broke the feed",
        detail:
          "The quickstart said `[...notify]`. Next's required catch-all does not match the bare " +
          "/api/notifications path, which is where the feed lives, so the bell rendered an empty " +
          "list against a 404 while /count kept working. It is `[[...notify]]`.",
      },
      {
        kind: "fixed",
        title: "An opt-out is no longer recorded as a delivery failure",
        detail:
          "A plugin can now return { result: 'skipped', reason }, writing the skipped status the " +
          "schema always had. Push uses it when nobody has registered a device, so getFailedDeliveries " +
          "stops filling with people who never enabled push and starts showing only real breakage.",
      },
      {
        kind: "changed",
        title: "A poll costs one request instead of two",
        detail:
          "The feed carries unseenCount on the first page and the client no longer calls /count " +
          "beside it. At a thousand open tabs on the default interval that halves 133 req/s of pure " +
          "badge-keeping. Cursor pages omit it, being scrollback rather than a poll.",
      },
      {
        kind: "added",
        title: "createPostgresTables and pgTransaction",
        detail:
          "The bootstrap file and the sixteen-line transaction wrapper that every integration was " +
          "writing by hand now ship. pushSchema is exported standalone too, so rendering plugin DDL " +
          "no longer means constructing a plugin with a provider you never intend to call.",
      },
    ],
  },
  {
    version: "0.2.0",
    date: "2026-09-22",
    summary: "Postgres without an ORM.",
    changes: [
      {
        kind: "added",
        title: "`postgresAdapter` — Postgres through any driver",
        detail:
          "Takes a plain query function instead of an ORM instance, so `pg`, `postgres.js`, " +
          "Kysely, Neon and PlanetScale's serverless drivers all work with no ORM in the " +
          "dependency tree. Verified against the same 14 conformance cases as the Drizzle and " +
          "MongoDB adapters, including the FOR UPDATE SKIP LOCKED one.",
      },
      {
        kind: "changed",
        title: "The conformance suite now runs three backends, not two",
        detail:
          "postgres-drizzle, postgres-raw and mongodb. The test count went from 304 to 359 " +
          "without a single new assertion being written — the new adapter simply runs the " +
          "existing behaviour suites.",
      },
      {
        kind: "fixed",
        title: "Docs: every code sample had its indentation eaten",
        detail:
          "MDX strips up to two leading spaces from each line of a multi-line JSX expression, " +
          "and the samples were written as template literals inside one — so nested code on all " +
          "23 pages rendered flat. Samples are fenced now, which MDX passes through byte-exactly.",
      },
      {
        kind: "fixed",
        title: "Docs: `send()` does block in `inline` mode",
        detail:
          "Every other mode returns as soon as the rows are committed, but `inline` awaits that " +
          "send's own deliveries. The docs previously claimed it never blocks, full stop.",
      },
      {
        kind: "fixed",
        title: "Docs: a missing `cron.secret` throws at startup",
        detail:
          "It does not silently 404, which is what the docs said. `easyPing()` refuses to " +
          "construct rather than mount an unauthenticated flush-everything endpoint.",
      },
      {
        kind: "fixed",
        title: "Docs: the configuration reference was incomplete",
        detail:
          "`basePath`, `tablePrefix`, `leaseMs`, `batchSize` and `throwOnError` were missing " +
          "from a page that claimed to list every option, and `backoff` can be a function.",
      },
    ],
  },
  {
    version: "0.1.0",
    date: "2026-09-22",
    summary: "First release.",
    changes: [
      {
        kind: "added",
        title: "The `send()` pipeline",
        detail:
          "Dedupe, hooks, four delivery modes over one cron sweep, and retry with exponential " +
          "backoff and jitter.",
      },
      {
        kind: "added",
        title: "Atomic claiming, so two sweeps never send the same thing twice",
        detail:
          "FOR UPDATE SKIP LOCKED on Postgres, an atomic findOneAndUpdate loop on MongoDB. " +
          "Both proven by a conformance case that holds a real row lock and asserts the claim " +
          "skips it.",
      },
      {
        kind: "added",
        title: "Two databases — Postgres via Drizzle, and MongoDB",
        detail:
          "Adding the second one is what exposed that the plugin store had hard-coded Postgres " +
          "naming and JSON handling; those are now the adapter's declaration.",
      },
      {
        kind: "added",
        title: "In-app inbox, email (Resend), and web push",
        detail:
          "Push is VAPID and aes128gcm on Web Crypto — no node:crypto — so it runs on Workers " +
          "and Edge, which the web-push npm package cannot.",
      },
      {
        kind: "added",
        title: "preferences, digests and push plugins",
        detail: "Each owns its own tables through a scoped store it cannot read outside of.",
      },
      {
        kind: "fixed",
        title: "`createdAt` came from the database clock, not the app's",
        detail:
          "`markSeen` compared a database timestamp against an app-clock cutoff. On one machine " +
          "they agree; across two hosts, NTP skew meant the newest notifications were never " +
          "marked seen and the badge never cleared. Found because MongoDB did it the other way.",
      },
      {
        kind: "security",
        title: "Every route carries a scope, enforced before the handler runs",
        detail:
          "A user-scoped handler receives an already-resolved userId and never sees a " +
          "client-supplied one. Feed and read queries are additionally scoped by user id in the " +
          "query itself.",
      },
    ],
  },
];

export const CURRENT_VERSION =
  RELEASES.find((release) => release.current)?.version ?? RELEASES[0]?.version ?? "0.0.0";
