# Web push

Browser push notifications. Read [api.md](api.md) first; this file adds what is specific to it.

```text
- provider: webPush({ subject, vapid, ttlSeconds?, urgency? }) from 'easy-ping/providers/web-push'
  subject is a mailto: or https: URL the push service can contact you at
- plugin:   push({ provider, render, staleAfterDays?, maxDevicesPerUser?,
            allowedEndpointHosts? }) from 'easy-ping/plugins/push'
  render: ({ type, payload }) => ({ title, body }) — what the OS notification shows
- await generateVapidKeys() produces the keypair — store both halves as secrets
  and never regenerate, or every existing subscription breaks
- the notification type must list 'push' in its channels, or nothing is sent;
  the plugin is what makes 'push' a usable channel at all
- the browser half is the app's own code: a service worker with a 'push' listener (without one
  the browser shows its own generic text), plus subscribeToPush({ publicKey,
  baseUrl?, serviceWorkerPath?, scope? }) from 'easy-ping/browser'
- one user may register several devices; a send fans out to all of them in
  parallel and succeeds if ANY endpoint accepts
- an endpoint is globally unique AND bound to the account that registered it:
  registering one already owned by another account is a 409, never a silent
  re-home. Past 'maxDevicesPerUser' (default 20) the least recently seen row is evicted
- registration validates the subscription: endpoint must be a public https URL and
  the keys must be 65/16 bytes base64url, else 400. 'allowedEndpointHosts' pins it
  to known push hosts; 'allowInsecureEndpoints' is for a local fake service only
- a push service reporting the subscription gone (404/410), or a subscription the
  provider cannot encrypt for, prunes that device row immediately rather than
  retrying it five times; a 429 is retried and is NOT counted as delivered
- localhost counts as a secure context; any other host needs real HTTPS
- iOS only delivers to a PWA installed to the home screen (Safari 16.4+)
```
