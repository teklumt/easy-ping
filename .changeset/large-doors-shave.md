---
"easy-ping": minor
---

Postgres without an ORM.

`postgresAdapter` takes a plain `(text, params) => rows` function instead of an ORM
instance, so `pg`, `postgres.js`, Kysely, Neon and other serverless drivers all work
with nothing extra in the dependency tree. It runs the same 14 conformance cases as
the Drizzle and MongoDB adapters, including the `FOR UPDATE SKIP LOCKED` claim.
