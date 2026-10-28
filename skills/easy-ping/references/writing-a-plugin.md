# Writing a plugin

The plugin surface in detail. Read [api.md](api.md) first; this file adds what is specific to it.

```text
definePlugin({ id, dependsOn?, schema?, init?, hooks?, routes?, channels? })
- schema is a declaration object, not a method: it lists the tables the plugin
  owns, and the plugin reaches them through a scoped store (ctx.store, handed to
  init) that validates every table and column against that declaration — it
  physically cannot read a table it didn't declare
- the same plugin code runs unmodified on Postgres and MongoDB: the store
  translates field naming and JSON handling per adapter
- dependsOn resolves init order, e.g. digests declares dependsOn: ['preferences']
  and reads that plugin's stored frequency rather than duplicating the table
- FAILURE POLICY IS ASYMMETRIC: beforeSend/resolveChannels fail CLOSED;
  afterSend/afterDeliver fail OPEN — get this backwards and either a bug
  blocks every send, or a broken hook silently hides delivery failures
- a plugin can carry a channel core doesn't have by declaring it in channels and
  implementing deliver — that is exactly how the push plugin works
- routes are scoped and the scope is enforced BEFORE the handler runs, so a
  handler receives an already-resolved userId or verified claims and cannot
  forget to check them
- init(ctx) NEVER receives the master secret. Use ctx.sign({ uid, purpose, data?,
  ttlSeconds? }), which only mints tokens for purposes this plugin's own signed
  routes declare, so one plugin cannot forge another's links
- parse request bodies with readJsonBody(request) from 'easy-ping': it enforces
  the body-size cap and returns { body } or { error: Response } (400/413) for you.
  The JSON content-type and Origin checks already ran before your handler for
  user-scoped POSTs; still check typeof on every field before you query with it
- ctx.notificationTypes lists the configured notification names — refuse rows for
  types that do not exist, or every string a client invents becomes a row forever
- scope { type: 'custom', justification } does its own auth; the justification is
  printed at startup and by notify.listRoutes(), so say something true in it
- the scoped store only accepts scalar where-values, or one recognised operator,
  so a JSON body cannot smuggle a Mongo operator through a plugin route
```
