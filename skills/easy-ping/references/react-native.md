# React Native

The inbox and native push in a React Native or Expo app. Both are in beta: say so. Read [api.md](api.md) first; this file adds what is specific to it.

```text
- client: useNotifications({ baseUrl, fetch }) from 'easy-ping/react-native' — same result shape as the web
  hook (notifications, unseenCount, unreadCount, markSeen, markAsRead, markAllRead, loadMore, refresh).
  It wires AppState itself: background = hidden (no polling), foreground = immediate refresh.
- identity is a bearer token, not a cookie: pass a fetch that adds Authorization; the server's
  session.getUserId must read that header. RN sends no Origin header, which the CSRF check accepts.
- streaming: RN's built-in fetch cannot stream a body, so the client polls after one failed stream
  attempt. Pass fetch from 'expo/fetch' (SDK 52+) and GET /events stays live. client.getTransport()
  reports which mode the client ended up in.
- native push is the 'mobilePush' channel, NOT web push:
  server: mobilePush({ provider: expoPush({ accessToken? }), render: ({ type, payload }) => ({ title, body,
          data?, badge?, sound?, channelId? }) }) from 'easy-ping/plugins/mobile-push' and
          'easy-ping/providers/expo-push'; add 'mobilePush' to the notification type's channels; create
          the tables from mobilePushSchema; schedule POST /mobile-push/receipts (machine) with the cron
  app:    request permission with expo-notifications, getExpoPushTokenAsync(), then
          registerMobilePushDevice({ baseUrl, fetch, token, platform, deviceName? }); on Android create a
          notification channel first. Push needs a physical device.
  the plugin adds notificationId and type to data, so a tap handler can markAsRead(notificationId).
- a token belongs to one account (409 otherwise); DeviceNotRegistered prunes the device; a user with no
  device is skipped, not failed.
```
