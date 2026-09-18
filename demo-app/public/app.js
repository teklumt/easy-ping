import { isPushSupported, subscribeToPush, unsubscribeFromPush } from "./easy-notify-browser.js";
import { createNotifyClient } from "./easy-notify-client.js";

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
  pollIntervalMs: 3000,
  fetch: withUser,
});

client.subscribe((state) => {
  document.querySelector("#badge").textContent = state.unseenCount;
  document.querySelector("#feed").innerHTML = state.notifications
    .map(
      (n) =>
        `<li class="${n.readAt ? "read" : "unread"}">
           <strong>${n.type}</strong>
           <span>${n.payload?.body ?? ""}</span>
         </li>`,
    )
    .join("");
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
    await withUser("/api/demo/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message }),
    })
  ).json();

  const channels = (result.notifications[0]?.deliveries ?? []).map((d) => d.channel);
  log(`sent "${message || "(default text)"}" -> ${channels.join(", ") || "nothing"}`);

  field.value = "";
  await client.refresh();
});

document.querySelector("#seen").addEventListener("click", async () => {
  await client.markSeen();
  log("badge cleared");
});
