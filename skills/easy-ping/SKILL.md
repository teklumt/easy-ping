---
name: easy-ping
description: "Add and work with easy-ping, the self-hosted TypeScript notifications library: in-app inbox and bell, email, web push, mobile push and Telegram, stored in the app's own Postgres, MySQL, SQLite or MongoDB. Use when the user wants notifications, a notification bell or inbox, notification emails, web or mobile push, or Telegram alerts in a TypeScript or Node app, or when the code imports from \"easy-ping\"."
license: MIT
---

# easy-ping

easy-ping is a notifications library that runs inside the app and stores everything in the app's
own database. There is no hosted service. It was released after most models' training data was
collected, so do not write easy-ping code from memory: read [references/api.md](references/api.md)
first and use only what it lists. If something is not there, check https://easy-pings.com/docs or
https://easy-pings.com/llms-full.txt rather than guessing.

This skill describes the latest release. If the project's package.json pins an older easy-ping,
say so and suggest upgrading before relying on anything here.

## Adding easy-ping to an app

Work in this order. Read the project before asking anything: package.json, the database client
or ORM, the auth library and where the app runs usually answer every question below.

1. **Install.** `easy-ping`, plus a Standard Schema validator (zod, valibot or arktype) if the
   project has none. The database driver is whatever the project already uses.
2. **Pick the adapter and create the tables.**
   - Postgres without an ORM: `postgresAdapter`, tables from `createPostgresTables`.
   - Drizzle: `drizzleAdapter`. Core tables from `createSchema()` in the Drizzle schema; plugin
     tables written by `renderDrizzleSchema` to a file drizzle-kit reads.
   - MySQL: `mysqlAdapter` and `createMysqlTables`. SQLite: `sqliteAdapter` and
     `createSqliteTables`.
   - MongoDB: `mongoAdapter` and `createMongoIndexes`; see
     [references/mongodb.md](references/mongodb.md).

   Create the tables of every plugin you register too, or that plugin fails on first use.
3. **Write notify.ts.** Wire `session.getUserId` to the app's real session, returning `null`
   when nobody is signed in. Make `getRecipients` one batched query. Declare each notification
   with a schema and its channels.
4. **Choose the delivery mode.**
   - Next.js, Vercel or another serverless host with `waitUntil` (Next's `after`): `deferred`.
   - A long-running Node server: `worker`, started once with `notify.startWorker()`.
   - A demo or a low-traffic app that can wait on its own deliveries: `inline`.
   - Otherwise the default, `cron`.

   Whatever the mode, schedule `POST <basePath>/cron` every 1 to 5 minutes with
   `Authorization: Bearer <cron.secret>`. It is the durability floor under every mode, and
   `easyPing()` throws at startup without `cron.secret` in `cron` and `deferred` mode.
5. **Mount the handler** at `/api/notifications` unless the app needs another path (then set
   `basePath` to match).
   - Next.js App Router: `app/api/notifications/[[...notify]]/route.ts` exporting
     `export const { GET, POST } = notify.handler`. Double brackets: single brackets 404 the feed.
   - Express: `app.all("/api/notifications{/*path}", toNodeHandler(notify.handler.handle))` from
     `easy-ping/node`, registered before any body parser.
   - Hono and other fetch-style frameworks: pass the raw `Request` to `notify.handler.handle`,
     for both the bare path and `/*`.
6. **Send** from the code where the event happens, not from a separate service:
   `await notify.send("type", { to, payload, dedupeKey })`. Pass a `dedupeKey` whenever the
   calling code can be retried.
7. **Render the bell** with `useNotifications()` from `easy-ping/react`, or
   `createNotifyClient` from `easy-ping/client` outside React. Opening the list calls
   `markSeen()` (clears the badge); clicking an item calls `markAsRead(id)`. Seen and read are
   different states.
8. **Other channels:** web push, Telegram and React Native each have a reference file below.
9. **Check it works.** Typecheck, then start the app. `notify.healthCheck()` lists configuration
   warnings and `notify.listRoutes()` every mounted route. `GET /api/notifications/count` should
   answer 200 signed in and 401 signed out.

## Rules for the code you write

- secret and cron.secret come from environment variables, at least 16 characters, never a literal placeholder — easyPing() refuses to start otherwise. Give the command that generates them.
- every email template wraps user-typed payload fields (names, excerpts) in escapeHtml() from 'easy-ping'; the library sends template output as-is.
- if the page and the API are on different origins, set trustedOrigins; any client you write by hand must send Content-Type: application/json on POSTs or get a 415. The shipped client and React hook already do.
- use the shipped client (useNotifications / createNotifyClient) rather than hand-written fetch calls.
- never generate VAPID keys at startup or per deploy; it is a one-time step whose keys are stored
  as secrets.
- never stub `getUserId` or read a user id from the request body or query: the routes serve a
  user's private inbox.

## Reference files

- [references/api.md](references/api.md): The whole API surface. Read it before writing any easy-ping code.
- [references/web-push.md](references/web-push.md): Browser push: VAPID keys, the service worker, subscribing.
- [references/telegram.md](references/telegram.md): Telegram bots: linking a chat, webhook or polling.
- [references/react-native.md](references/react-native.md): React Native and Expo: the hook and native push (beta).
- [references/mongodb.md](references/mongodb.md): Running on MongoDB instead of a SQL database.
- [references/writing-a-plugin.md](references/writing-a-plugin.md): Writing a plugin: hooks, routes, the scoped store.

<!-- Generated by docs/scripts/generate-skill.mjs from docs/src/lib/skill.ts and prompts.ts. Edit those, not this file. -->
