---
"easy-ping": minor
---

Security hardening across the handler, plugins and adapters.

- **Push devices belong to one account.** `POST /push/devices` no longer upserts on `endpoint` alone, which let any user re-home another user's device by knowing its URL. Registering an endpoint owned by another account is a 409. Endpoints must be public https URLs with well-formed keys (`allowedEndpointHosts` pins them to known push services), and each user keeps at most `maxDevicesPerUser` rows (default 20). Fan-out is parallel, and a throttled device no longer counts as delivered.
- **CSRF defence.** Every POST must be `application/json` (415) and a cross-origin `Origin` is refused (403) unless listed in the new `trustedOrigins` option.
- **Secret strength.** `secret`, `cron.secret` and the new `machineSecret` must be at least 16 characters and not a placeholder; startup throws otherwise.
- **Plugins no longer receive the secret.** `PluginInitContext.secret` is replaced by `sign()`, which mints tokens only for the purposes the plugin's own `signed` routes declare. Token keys are now derived per purpose with HKDF. **Outstanding tokens signed by 0.3.0 are invalid after upgrading**; unsubscribe links in already-sent email will need to be re-issued.
- **Unsubscribe freshness.** `notification_preference` gains an `updatedAt` column (additive; `planPostgresMigration` emits it, Mongo needs nothing). A token issued before the user's later explicit change is refused; a repeat click is still a 200.
- **Machine routes** can be guarded by a separate `machineSecret`; they fall back to `cron.secret`. `cron.maxSweeps` bounds one `/cron` call. `notify.listRoutes()` lists every route with its scope, and `custom`-scoped routes are named in a startup warning.
- **Rate limiting.** `rateLimit: { max, windowMs, key? }` adds an in-process fixed-window limiter before routing; `createRateLimiter` is exported for use inside `onRequest`.
- **No unhandled errors.** The handler returns a logged 500 instead of throwing, and `toNodeHandler` no longer rethrows after responding (which was an unhandled rejection under Express). It also caps request bodies, as does the handler (`maxBodyBytes`, default 64 KiB) via the new `readJsonBody`.
- **Plugin store shape checks.** Where-clause values must be scalars or a single recognised operator, so a JSON body can no longer smuggle a Mongo operator through a plugin route; field lookups use `Object.hasOwn`.
- **Preferences validation.** `type` must be a configured notification, `channel` and `frequency` must be valid, `enabled` must be a boolean.
- `escapeHtml` is exported for email templates; the quickstart uses it. `onRequest` runs before routing. Responses carry `Cache-Control: private, no-store` and `nosniff`. Token TTLs are capped at 90 days and token `data` is validated. Email addresses are redacted from `last_error`. `basePath` matching is anchored to a path segment. The bearer comparison hashes both sides so it no longer leaks the secret's length.
- Web push: the provider reports an unusable subscription as `invalid`, and the plugin prunes it instead of retrying five times.
