---
"easy-ping": patch
---

Security review of the event-driven transport.

- Client: new `scope` option mixes a user or session key into the leader lock and tab channel names. Set it when identity is not a cookie, otherwise tabs signed in as different users could share a leader and mirror each other's inbox.
- `GET /events` is capped: `events.maxStreamsPerUser` (10) returns 429 with `Retry-After`, `events.maxStreams` (5000) returns 503. A stream whose consumer stops reading is closed after 256 unread chunks.
- The fallback database probe is shared per user instead of running once per stream.
- `delivery.sweepOnRequest` runs only after a served (<400) response.
- `instrument(fetch)` reads the inbox-version header only from same-origin responses.
- Dev dependencies upgraded past published advisories (vitest, vite, tsup, esbuild, changesets); the production tree had none.
