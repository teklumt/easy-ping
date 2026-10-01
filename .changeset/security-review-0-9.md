---
"easy-ping": minor
---

Fixes from the 0.9.0 security review. Two of them change behaviour for existing apps; see the 0.10.0 section of the Upgrading page.

- `useNotifications` (React) now forwards `scope` and the other client options it accepted but dropped, so the cross-user tab fix from 0.6.1 works through the hook.
- **Behaviour change.** Rate limiter: when the default key finds no proxy header, requests share one bucket instead of being exempt, and a warning is logged once. At most `maxKeys` (10 000) keys are tracked, oldest evicted. A custom `key` returning `null` still exempts.
- **Behaviour change.** `session.getUserId` returning `""` or a non-string is treated as unauthenticated. A user whose id is literally `"error"` is no longer answered with 500.
- Push token registration rejects tokens over 512 characters; Expo tokens are bounded to 64 characters inside the brackets.
- `toNodeHandler`: `x-forwarded-proto` takes the first hop and only `http`/`https`; a client leaving during backpressure no longer leaves the handler waiting forever.
- `pgListenNotify` binds the `pg_notify` channel and payload as parameters.
- Telegram: malformed webhook updates are ignored; one live link code per user.
- Web push: an off-curve `p256dh` is reported as an invalid subscription and pruned, not retried five times.
- A plugin route that reuses a core route is a startup error.
- Postgres and Drizzle upserts whose every column is in the conflict key now emit `DO NOTHING` instead of an invalid `DO UPDATE SET`.
- Plugin store: `readOnly` tables refuse writes (digests declares the preferences table this way); `update`/`remove` refuse an empty `where`.
- `planSqliteMigration` sets `requiresTransaction` when a plan rebuilds a table.
- CI workflow runs with a read-only token.
