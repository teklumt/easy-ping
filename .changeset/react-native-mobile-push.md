---
"easy-ping": minor
---

React Native, and native push.

- `easy-ping/react-native`: `useNotifications` and `createNativeNotifyClient` wire `AppState` (background = hidden, foreground = refresh), run as a single connection, and try the event stream first; a fetch that cannot stream falls back to polling on the first attempt, `expo/fetch` keeps the stream. `registerMobilePushDevice` / `unregisterMobilePushDevice` talk to the new routes.
- `easy-ping/plugins/mobile-push`: the `mobilePush` channel. A per-user token registry (`POST/GET /mobile-push/devices`, `POST /mobile-push/devices/remove`; one owner per token, 409 otherwise, eviction past `maxDevicesPerUser`), batched fan-out, and `POST /mobile-push/receipts` (machine) that asks the provider for late verdicts and prunes devices reported gone. `POST /mobile-push/prune` for stale devices. `mobilePushSchema` exported for DDL.
- `easy-ping/providers/expo-push`: `expoPush({ accessToken? })` over fetch. Batches of 100, receipts of 1000, per-token classification (`DeviceNotRegistered` prunes, `MessageRateExceeded` retries, `MessageTooBig` fails), access token redacted from errors.
- Client: `GET /events` answered without a streamable body now disables streaming for the session at once instead of after three retries.
- `Channel` gains `"mobilePush"`; the preferences plugin lists it.
