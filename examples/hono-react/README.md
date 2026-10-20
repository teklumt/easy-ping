# Hono + React + Postgres

A React single-page app on Vite, talking to a Hono API that keeps notifications in Postgres
through postgres.js, with no ORM.

```bash
docker compose up -d postgres     # from the repo root, or set DATABASE_URL in .env
pnpm install
pnpm dev                          # http://localhost:3002
```

`pnpm dev` starts both halves: the Hono API on port 3003 and Vite on 3002, which proxies `/api`
to it. Every event reaches three channels, each with its own card on the page:

- **In-app:** the bell in the header, through `useNotifications`.
- **Web push:** press **Enable push**, allow the prompt, trigger an event, then look outside the
  tab. The first subscription can take a few seconds.
- **Email:** an outbox provider (`server/outbox.ts`) keeps each rendered email for the page to
  show instead of sending it. Swap in `resend({ apiKey, from })` to send for real.

Open the link on the page to act as `dana` in a second window and send to her.

## What it shows

| | |
| --- | --- |
| `server/index.ts` | `postgresAdapter` over a plain `(text, params) => rows` function, a transaction for atomic sends, the push plugin, one email template per notification type, and the handler mounted in Hono in one line |
| `src/App.tsx` | one `createNotifyClient` shared by the bell and the status card, and three notification types each typed by its own zod schema |
| `src/Bell.tsx` | the bell: badge, dropdown, seen versus read |
| `src/Channels.tsx` | `subscribeToPush` from `easy-ping/browser`, and the email outbox |

- **`delivery.mode: "inline"`** finishes delivery before `send()` returns, so there is no cron or
  worker to run.
- **Tables are created on start** with `createPostgresTables`, including the push plugin's. It is
  idempotent.
- **VAPID keys** are generated on first start and kept in the gitignored `.vapid-keys.json`.
- **Identity is an `x-demo-user` header** set by the page. It stands in for your auth, and the
  server refuses to start with `NODE_ENV=production`.

Requires Node 22.18 or newer, which runs the TypeScript server directly.
