# easy-ping

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
