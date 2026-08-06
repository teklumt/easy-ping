# Example — Next.js + Drizzle

A complete easy-notify wiring: config, mounted endpoints, a send site, and a bell component.

This example is **typechecked in CI against the built package**, so it cannot drift from the real API. That check has already caught four defects the unit tests missed — a missing `drizzleAdapter` export, a missing `react.d.ts`, and a type-variance bug that made every schema-typed definition fail to assign.

## Files

| | |
| --- | --- |
| `src/db/schema.ts` | your `user` table alongside easy-notify's three |
| `src/notify.ts` | the whole configuration |
| `src/session.ts` | stand-in for your auth library |
| `src/app/api/notifications/[...notify]/route.ts` | mounts every endpoint in one line |
| `src/app/api/comments/route.ts` | a realistic send site |
| `src/components/NotificationBell.tsx` | the bell, with seen/read handled correctly |

## Running it

```bash
cp .env.example .env      # fill in the secrets
docker compose up -d      # from the repo root
pnpm --filter example-next-drizzle typecheck
```

It has no `dev` script on purpose — there are no pages, and the value here is a compile-checked reference rather than a demo to click through.

## Worth noting

**`seen` and `read` are different.** Opening the dropdown clears the badge (`markSeen`); clicking an item marks it read. Shipping only `read` gives you either a wrong badge or a migration later.

**`waitUntil` is passed explicitly.** `delivery: { mode: "deferred", waitUntil: after }` — the library does not sniff for `next/server`, because dynamically importing a package that may not exist breaks bundlers.

**`dedupeKey` makes the send site retry-safe.** A double-submitted comment produces one notification.
