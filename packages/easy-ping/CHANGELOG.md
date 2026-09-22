# easy-ping

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
