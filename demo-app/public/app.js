import { isPushSupported, subscribeToPush, unsubscribeFromPush } from "./easy-ping-browser.js";
import { createNotifyClient } from "./easy-ping-client.js";

const userId = new URLSearchParams(location.search).get("user") ?? "demo-user";
document.querySelector("#who").textContent = userId;

const withUser = (input, init = {}) =>
  fetch(input, { ...init, headers: { ...init.headers, "x-demo-user": userId } });

const log = (message) => {
  const line = document.createElement("div");
  line.textContent = `${new Date().toLocaleTimeString()}  ${message}`;
  document.querySelector("#log").prepend(line);
};

const client = createNotifyClient({
  baseUrl: "/api/notifications",
  fetch: withUser,
});

// Your app's own calls carry the inbox version; the bell refreshes when it moves.
const appFetch = client.instrument(withUser);

let lastTransport = "";
const showTransport = () => {
  const t = client.getTransport();
  const text = `${t.role} / ${t.transport}${t.connected ? " (connected)" : ""}`;
  document.querySelector("#transport").textContent = text;
  if (text !== lastTransport) {
    lastTransport = text;
    log(`transport -> ${text}`);
  }
};
setInterval(showTransport, 250);

client.subscribe((state) => {
  showTransport();
  document.querySelector("#badge").textContent = state.unseenCount;

  // Built as nodes, never innerHTML: payload.body is whatever the sender typed.
  const feed = document.querySelector("#feed");
  feed.replaceChildren(
    ...state.notifications.map((n) => {
      const item = document.createElement("li");
      item.className = n.readAt ? "read" : "unread";
      const type = document.createElement("strong");
      type.textContent = n.type;
      const body = document.createElement("span");
      body.textContent = n.payload?.body ?? "";
      item.append(type, " ", body);
      return item;
    }),
  );
});

document.querySelector("#enable").addEventListener("click", async () => {
  if (!isPushSupported()) return log("this browser has no push support");

  try {
    const { vapidPublicKey } = await (await fetch("/api/demo/config")).json();
    const sub = await subscribeToPush({
      publicKey: vapidPublicKey,
      baseUrl: "/api/notifications",
      fetch: withUser,
    });
    log(`push enabled -> ${new URL(sub.endpoint).host}`);
  } catch (error) {
    log(`push failed: ${error.message}`);
  }
});

document.querySelector("#disable").addEventListener("click", async () => {
  const removed = await unsubscribeFromPush({ baseUrl: "/api/notifications", fetch: withUser });
  log(removed ? "push disabled" : "nothing was subscribed");
});

document.querySelector("#composer").addEventListener("submit", async (event) => {
  event.preventDefault();

  const field = document.querySelector("#message");
  const message = field.value.trim();

  const result = await (
    await appFetch("/api/demo/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message }),
    })
  ).json();

  const channels = (result.notifications[0]?.deliveries ?? []).map((d) => d.channel);
  log(`sent "${message || "(default text)"}" -> ${channels.join(", ") || "nothing"}`);

  field.value = "";
  // No manual refresh: the event stream (or the piggyback header) brings it in.
});

document.querySelector("#seen").addEventListener("click", async () => {
  await client.markSeen();
  log("badge cleared");
});
