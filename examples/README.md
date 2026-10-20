# Examples

Runnable web apps that use easy-ping from npm, exactly as you would install it. Each one sends to
three channels and shows all three on the page: the in-app bell, web push, and email.

| Example | Stack | Database | Delivery | Also shows |
| --- | --- | --- | --- | --- |
| [`express-sqlite`](./express-sqlite) | Express, plain HTML | SQLite (`node:sqlite`) | `worker` | the browser bundles with no build step; needs nothing running |
| [`hono-react`](./hono-react) | Hono, React on Vite | Postgres via postgres.js | `inline` | `useNotifications`, any driver without an ORM, several notification types |
| [`next-drizzle`](./next-drizzle) | Next.js App Router | Postgres via Drizzle | `deferred` | `after()` as `waitUntil`, `drizzle-kit` managing your tables and easy-ping's, real email through Resend |

Start with `express-sqlite` if you just want to see it work: `pnpm install && pnpm dev` inside it.

**Email** goes to an outbox provider that keeps each rendered email for the page to show, so no
account is needed. `next-drizzle` sends real email through Resend when `RESEND_API_KEY` is set.

All three are typechecked in CI against the published package, so they cannot drift from the API
on npm. Each one trusts an `x-demo-user` header or cookie for identity, standing in for your
auth library. Never deploy them as they are.
