# easy-ping on Expo

The web client, on a phone: the bell over `useNotifications` from `easy-ping/react-native`, the
live event stream through `expo/fetch`, and native push through the `mobilePush` channel with
Expo's push service.

This folder is deliberately **outside the pnpm workspace** (`pnpm-workspace.yaml` excludes it), so
installing the library does not pull in the React Native toolchain. It is a copy-paste starting
point, not a package that builds here.

## Run it

```bash
npx create-expo-app my-bell --template blank-typescript
cd my-bell
npx expo install expo-notifications expo-device
npm install easy-ping
cp <this folder>/App.tsx App.tsx      # then set NOTIFY_URL and getSessionToken()
npx expo start
```

Push needs a physical device (simulators have no push token) and, for iOS, an Apple developer
account. Expo's push service does not need FCM or APNs credentials for development; see Expo's
docs for production credentials.

## Server side

```ts
import { mobilePush } from "easy-ping/plugins/mobile-push";
import { expoPush } from "easy-ping/providers/expo-push";

plugins: [
  mobilePush({
    provider: expoPush({ accessToken: process.env.EXPO_ACCESS_TOKEN }), // token optional
    render: ({ type, payload }) => ({ title: "New", body: `${type}`, data: {} }),
  }),
],
```

Add `"mobilePush"` to the channels of any notification type that should reach phones, create the
two tables from `mobilePushSchema`, and schedule `POST /mobile-push/receipts` (machine route)
alongside `/cron`: Expo learns that a device was uninstalled only after accepting the message, and
receipts are where that verdict arrives.

## What the client does differently on a phone

- `AppState` decides hidden vs. active: no polling in the background, an immediate refresh when
  the app comes back to the foreground.
- One app is one user, so there is no tab leader to elect and no cross-tab mirror.
- The event stream is tried first. React Native's built-in `fetch` cannot stream a body, so with
  it the client falls back to polling on the very first attempt; `expo/fetch` streams, so the bell
  stays live.
- Identity is a bearer token you add in `fetch`, not a cookie. The server's `getUserId` reads it.
