# easy-ping demo

A real server, a real browser, a real push notification. This is where the
browser half of web push lives — the part the library cannot own for you.

## Run it

```bash
docker compose up -d                      # Postgres, MongoDB and MySQL, from the repo root
pnpm --filter easy-ping build           # the demo serves the built bundles

cd demo-app
cp .env.example .env
pnpm keys                                 # generate VAPID keys -> paste into .env
pnpm dev                                  # http://localhost:3210
```

Set `DB_DRIVER` to `mongodb`, `mysql` or `sqlite` in `.env` to run the exact same demo on another
database (SQLite needs nothing running: it uses Node's own `node:sqlite` in memory). The
startup banner names whichever one it connected to.

Then: **Enable push** → allow the permission prompt → type a message → **Send**.

The message you typed arrives as a real OS notification, encrypted in transit
and decrypted by the service worker in `public/sw.js`. Click into another
window first — seeing it arrive while the tab is in the background is the whole
point.

Open `http://localhost:3210/?user=someone-else` in another window to act as a
second person and confirm feeds stay separate.

## What it exercises

| | |
| --- | --- |
| in-app inbox | one event stream per browser (open two tabs: leader / follower), unseen badge, seen vs read |
| web push | VAPID, aes128gcm, a real service worker, a real push service |
| device registry | register, re-register, unregister, prune |
| session scoping | `x-demo-user` stands in for your auth |
| all four adapters | the same code on Postgres, MongoDB, MySQL and SQLite |

`delivery.mode` is `inline` so there is no cron to run.

## The browser half

Three pieces, none of which the library can supply for you:

1. **A service worker** (`public/sw.js`) with a `push` listener. Without one
   the browser shows its own generic "site updated in the background" text.
2. **A subscribe call** — `subscribeToPush()` from `easy-ping/browser` does
   registration, permission, `pushManager.subscribe`, and the POST to
   `/push/devices`.
3. **A VAPID public key** the page can read, served here by `/api/demo/config`.

## Notes

- **localhost is a secure context**, so push works without TLS. Any other host
  needs HTTPS or the service worker will not register.
- **iOS** only delivers web push to a PWA installed to the home screen
  (16.4+). Desktop Safari 16+ works normally.
- The demo authenticates by header. Real apps supply a session resolver.

## Troubleshooting

**"Cannot reach Postgres" / "Cannot reach MongoDB" / "Cannot reach MySQL"** — the container is not up.
`docker compose up -d` from the repo root. If the Docker engine itself will not
start, open Docker Desktop and clear whatever it is waiting on (sign-in,
licence, update).

**`/easy-ping-browser.js` returns 500** — the bundles are missing. Run
`pnpm --filter easy-ping build`; the demo serves them straight out of the
workspace package so a rebuild is picked up without copying.

**"Enable push" does nothing** — the notification permission for `localhost`
was denied at some point, and browsers never re-prompt. Reset it in the site
settings padlock menu.

**Push worked, then stopped** — clearing site data drops the subscription. The
stale endpoint returns 410, the server prunes the row, and you subscribe again.

**Nothing arrives but the feed updates** — the service worker is registered but
has no `push` listener, or an older worker is still active. Hard-reload, or
unregister it under Application → Service Workers.
