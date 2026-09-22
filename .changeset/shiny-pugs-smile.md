---
"easy-ping": minor
---

Findings from building a real app on 0.2.0, fixed.

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
