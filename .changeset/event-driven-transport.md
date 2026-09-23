---
"easy-ping": minor
---

The bell no longer lives on a timer.

- `GET /events`: a server-sent event stream per user (`ready`, then `changed` whenever the inbox moves). No payload travels on it; the client refetches the feed. Off with `events: false`.
- The client opens one stream per browser: a `navigator.locks` leader owns it, other tabs mirror its state over `BroadcastChannel`. Polling remains the fallback (after three short-lived streams the session gives up on streaming) and now backs off while the user is idle and snaps back on input. `transport: "auto" | "sse" | "poll"`, `safetyNetMs`, `activeWindowMs`; `getTransport()` reports the role.
- `client.instrument(fetch)` refreshes when a response carries `notify.inboxHeaders(userId)`, so active users need no dedicated request at all.
- `easy-ping/sw`: `handlePush(event)` shows the OS notification and relays a `changed` message to open tabs.
- `signals`: the wake-up seam. `createMemorySignals` (default), `postgresSignals(sql)` over LISTEN/NOTIFY and `mongoSignals(db)` over a change stream for multi-replica deployments. Without a cross-process signal, the stream probes a change fingerprint every `events.probeIntervalMs` (30 s).
- `startWorker()` is woken by `send()` in the same process; the default idle interval is now 10 s.
- `toNodeHandler` now streams response bodies instead of buffering them, and aborts the web `Request` when the client disconnects. Without this the event stream never reached a browser through Express or plain Node.
- `delivery.sweepOnRequest`: a bounded delivery pass after any request, throttled to every 5 s, for hosts that see traffic but no scheduler.
