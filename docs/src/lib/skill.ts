/**
 * The agent skill's own words: when to load it and the order to work in. The API it points at
 * comes from prompts.ts, so the skill, the copy buttons and llms-full.txt cannot disagree.
 * scripts/generate-skill.mjs writes skills/easy-ping/ at the repository root from this file.
 */

import { SETUP_RULES } from "./prompts.ts";

export const SKILL_NAME = "easy-ping";

export const SKILL_DESCRIPTION =
  "Add and work with easy-ping, the self-hosted TypeScript notifications library: in-app inbox " +
  "and bell, email, web push, mobile push and Telegram, stored in the app's own Postgres, MySQL, " +
  "SQLite or MongoDB. Use when the user wants notifications, a notification bell or inbox, " +
  "notification emails, web or mobile push, or Telegram alerts in a TypeScript or Node app, or " +
  'when the code imports from "easy-ping".';

/** One line per reference file, in the order an agent is most likely to need them. */
export const SKILL_REFERENCES = [
  ["api.md", "The whole API surface. Read it before writing any easy-ping code."],
  ["web-push.md", "Browser push: VAPID keys, the service worker, subscribing."],
  ["telegram.md", "Telegram bots: linking a chat, webhook or polling."],
  ["react-native.md", "React Native and Expo: the hook and native push (beta)."],
  ["mongodb.md", "Running on MongoDB instead of a SQL database."],
  ["writing-a-plugin.md", "Writing a plugin: hooks, routes, the scoped store."],
] as const;

export const SKILL_BODY = `# easy-ping

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

1. **Install.** \`easy-ping\`, plus a Standard Schema validator (zod, valibot or arktype) if the
   project has none. The database driver is whatever the project already uses.
2. **Pick the adapter and create the tables.**
   - Postgres without an ORM: \`postgresAdapter\`, tables from \`createPostgresTables\`.
   - Drizzle: \`drizzleAdapter\`. Core tables from \`createSchema()\` in the Drizzle schema; plugin
     tables written by \`renderDrizzleSchema\` to a file drizzle-kit reads.
   - MySQL: \`mysqlAdapter\` and \`createMysqlTables\`. SQLite: \`sqliteAdapter\` and
     \`createSqliteTables\`.
   - MongoDB: \`mongoAdapter\` and \`createMongoIndexes\`; see
     [references/mongodb.md](references/mongodb.md).

   Create the tables of every plugin you register too, or that plugin fails on first use.
3. **Write notify.ts.** Wire \`session.getUserId\` to the app's real session, returning \`null\`
   when nobody is signed in. Make \`getRecipients\` one batched query. Declare each notification
   with a schema and its channels.
4. **Choose the delivery mode.**
   - Next.js, Vercel or another serverless host with \`waitUntil\` (Next's \`after\`): \`deferred\`.
   - A long-running Node server: \`worker\`, started once with \`notify.startWorker()\`.
   - A demo or a low-traffic app that can wait on its own deliveries: \`inline\`.
   - Otherwise the default, \`cron\`.

   Whatever the mode, schedule \`POST <basePath>/cron\` every 1 to 5 minutes with
   \`Authorization: Bearer <cron.secret>\`. It is the durability floor under every mode, and
   \`easyPing()\` throws at startup without \`cron.secret\` in \`cron\` and \`deferred\` mode.
5. **Mount the handler** at \`/api/notifications\` unless the app needs another path (then set
   \`basePath\` to match).
   - Next.js App Router: \`app/api/notifications/[[...notify]]/route.ts\` exporting
     \`export const { GET, POST } = notify.handler\`. Double brackets: single brackets 404 the feed.
   - Express: \`app.all("/api/notifications{/*path}", toNodeHandler(notify.handler.handle))\` from
     \`easy-ping/node\`, registered before any body parser.
   - Hono and other fetch-style frameworks: pass the raw \`Request\` to \`notify.handler.handle\`,
     for both the bare path and \`/*\`.
6. **Send** from the code where the event happens, not from a separate service:
   \`await notify.send("type", { to, payload, dedupeKey })\`. Pass a \`dedupeKey\` whenever the
   calling code can be retried.
7. **Render the bell** with \`useNotifications()\` from \`easy-ping/react\`, or
   \`createNotifyClient\` from \`easy-ping/client\` outside React. Opening the list calls
   \`markSeen()\` (clears the badge); clicking an item calls \`markAsRead(id)\`. Seen and read are
   different states.
8. **Other channels:** web push, Telegram and React Native each have a reference file below.
9. **Check it works.** Typecheck, then start the app. \`notify.healthCheck()\` lists configuration
   warnings and \`notify.listRoutes()\` every mounted route. \`GET /api/notifications/count\` should
   answer 200 signed in and 401 signed out.

## Rules for the code you write

${SETUP_RULES}
- never generate VAPID keys at startup or per deploy; it is a one-time step whose keys are stored
  as secrets.
- never stub \`getUserId\` or read a user id from the request body or query: the routes serve a
  user's private inbox.

## Reference files

`;
