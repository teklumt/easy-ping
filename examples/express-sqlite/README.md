# Express + SQLite

The quickest way to see easy-ping working: an Express server, a SQLite file, and a plain HTML
page. No database server, no bundler, no account anywhere.

```bash
pnpm install
pnpm dev            # http://localhost:3001
```

One `send()` reaches three channels, each with its own card on the page:

- **In-app:** the bell in the header, live over the event stream.
- **Web push:** press **Enable push** and allow the prompt, send yourself a message, then look
  outside the tab. The first subscription can take a few seconds.
- **Email:** an outbox provider (`src/outbox.ts`) keeps each rendered email for the page to show
  instead of sending it. Swap in `resend({ apiKey, from })` to send for real.

Open the link on the page to act as `dana` in a second window and watch a message land there.

## What it shows

| | |
| --- | --- |
| `src/server.ts` | the whole server: SQLite adapter, `toNodeHandler` mounted before the body parser, worker delivery, the push plugin, an email template |
| `src/outbox.ts` | a complete `EmailProvider` in twenty lines |
| `src/vapid.ts` | VAPID keys generated once and kept in the gitignored `.vapid-keys.json` |
| `public/app.js` | `createNotifyClient` and `subscribeToPush` from the package's browser bundles, with no build step |
| `public/sw.js` | the service worker that shows the push notification |

- **Live without a socket server.** One tab per browser holds the event stream and the others
  mirror it; the page shows which role this tab has.
- **Seen and read are different.** Opening the inbox clears the badge; clicking an item un-bolds it.
- **Identity is an `x-demo-user` header** set by the page. It stands in for your auth, and the
  server refuses to start with `NODE_ENV=production`.
- **Push needs a secure context.** `localhost` counts; any other host needs HTTPS. iOS only
  delivers web push to a site installed to the home screen.

Requires Node 22.18 or newer, for built-in TypeScript and `node:sqlite`.
