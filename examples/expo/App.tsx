// A complete Expo screen: the bell, a "Mark seen" action, and native push
// registration. Everything below `NOTIFY_URL` is the same on iOS and Android.
//
// Run: see README.md in this folder. This example is intentionally not part of
// the pnpm workspace, so the library's install stays free of the native toolchain.

import {
  registerMobilePushDevice,
  unregisterMobilePushDevice,
  useNotifications,
} from "easy-ping/react-native";
import { fetch as expoFetch } from "expo/fetch";
import { useEffect, useRef, useState } from "react";
import { Button, FlatList, Platform, StyleSheet, Text, View } from "react-native";

const NOTIFY_URL = "https://app.example.com/api/notifications";

// Your session token, however your app stores it. The server's getUserId reads
// the Authorization header; there is no cookie on a phone.
async function getSessionToken(): Promise<string> {
  return "replace-with-your-session-token";
}

// expo/fetch streams response bodies, so the bell stays live over GET /events.
// With React Native's built-in fetch the client would fall back to polling.
const authedFetch: typeof globalThis.fetch = async (input, init) => {
  const token = await getSessionToken();
  const headers = new Headers(init?.headers);
  headers.set("authorization", `Bearer ${token}`);
  return expoFetch(String(input), { ...init, headers } as never) as unknown as Response;
};

// expo-notifications is imported lazily: Expo Go on Android throws at import time
// (remote push left it in SDK 53), and the bell must not depend on push at all.
type NotificationsModule = typeof import("expo-notifications");

async function loadPush() {
  const [Notifications, Device] = await Promise.all([
    import("expo-notifications"),
    import("expo-device"),
  ]);
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: true,
    }),
  });
  return { Notifications, Device };
}

async function enablePush(): Promise<{ token: string; Notifications: NotificationsModule }> {
  const { Notifications, Device } = await loadPush();
  if (!Device.isDevice) throw new Error("push needs a physical device");
  const { status } = await Notifications.requestPermissionsAsync();
  if (status !== "granted") throw new Error("permission denied");
  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync("default", {
      name: "Default",
      importance: Notifications.AndroidImportance.DEFAULT,
    });
  }
  const { data: token } = await Notifications.getExpoPushTokenAsync();
  await registerMobilePushDevice({
    baseUrl: NOTIFY_URL,
    fetch: authedFetch,
    token,
    platform: Platform.OS === "ios" ? "ios" : "android",
    deviceName: Device.deviceName ?? undefined,
  });
  return { token, Notifications };
}

export default function App() {
  const { notifications, unseenCount, unreadCount, isLoading, markSeen, markAsRead } =
    useNotifications({ baseUrl: NOTIFY_URL, fetch: authedFetch });
  const [pushToken, setPushToken] = useState<string | null>(null);
  const [status, setStatus] = useState("");

  // Tapping an OS notification opens the app; the bell refreshes on its own,
  // this marks the tapped one read. Registered once push is enabled.
  const tapListener = useRef<{ remove(): void } | null>(null);
  useEffect(() => () => tapListener.current?.remove(), []);
  function listenForTaps(Notifications: NotificationsModule) {
    tapListener.current?.remove();
    tapListener.current = Notifications.addNotificationResponseReceivedListener((response) => {
      const data = response.notification.request.content.data as { notificationId?: string };
      if (data.notificationId) void markAsRead(data.notificationId);
    });
  }

  return (
    <View style={styles.screen}>
      <Text style={styles.title}>Inbox {unseenCount > 0 ? `(${unseenCount})` : ""}</Text>
      <View style={styles.row}>
        <Button title="Mark seen" onPress={() => void markSeen()} />
        {pushToken ? (
          <Button
            title="Disable push"
            onPress={() =>
              void unregisterMobilePushDevice({
                baseUrl: NOTIFY_URL,
                fetch: authedFetch,
                token: pushToken,
              }).then(() => setPushToken(null))
            }
          />
        ) : (
          <Button
            title="Enable push"
            onPress={() =>
              void enablePush()
                .then(({ token, Notifications }) => {
                  setPushToken(token);
                  listenForTaps(Notifications);
                  setStatus("push enabled");
                })
                .catch((error: Error) => setStatus(error.message))
            }
          />
        )}
      </View>
      {status ? <Text style={styles.status}>{status}</Text> : null}
      {isLoading ? <Text>Loading…</Text> : null}
      <FlatList
        data={notifications}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <Text
            style={[styles.item, item.readAt ? styles.read : styles.unread]}
            onPress={() => void markAsRead(item.id)}
          >
            {item.type}
          </Text>
        )}
        ListEmptyComponent={<Text>Nothing yet.</Text>}
      />
      <Text style={styles.foot}>{unreadCount} unread</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, padding: 24, paddingTop: 64, gap: 12 },
  title: { fontSize: 24, fontWeight: "700" },
  row: { flexDirection: "row", gap: 12 },
  status: { color: "#666" },
  item: { paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: "#eee" },
  unread: { fontWeight: "600" },
  read: { color: "#888" },
  foot: { color: "#888" },
});
