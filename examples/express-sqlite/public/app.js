import {
  isPushSupported,
  subscribeToPush,
  unsubscribeFromPush,
} from "/vendor/easy-ping/browser.js";
import { createNotifyClient } from "/vendor/easy-ping/client.js";

const $ = (selector) => document.querySelector(selector);

// Stand-in for your auth: ?user=dana acts as dana. Real apps rely on their session cookie.
const user = new URLSearchParams(location.search).get("user") || "you";
const other = user === "dana" ? "you" : "dana";
$("#who").textContent = user;
$("#other").href = `/?user=${other}`;
$("#other").textContent = `a second window as ${other}`;

const asUser = (input, init = {}) => {
  const headers = new Headers(init.headers);
  headers.set("x-demo-user", user);
  return fetch(input, { ...init, headers });
};

const log = (message) => {
  const line = document.createElement("li");
  line.textContent = `${new Date().toLocaleTimeString()}  ${message}`;
  $("#log").prepend(line);
};

const time = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
const ago = (iso) => {
  const seconds = Math.round((new Date(iso).getTime() - Date.now()) / 1000);
  return Math.abs(seconds) < 60
    ? time.format(seconds, "second")
    : time.format(Math.round(seconds / 60), "minute");
};

// ---- In-app ---------------------------------------------------------------------------------

// scope keeps tabs signed in as different users from sharing one connection.
const client = createNotifyClient({ baseUrl: "/api/notifications", fetch: asUser, scope: user });

// Built from nodes, never innerHTML: the text is whatever the sender typed.
client.subscribe((state) => {
  const badge = $("#badge");
  badge.hidden = state.unseenCount === 0;
  badge.textContent = state.unseenCount > 99 ? "99+" : String(state.unseenCount);
  $("#inapp-pill").textContent = `${state.unseenCount} unseen`;
  $("#inapp-pill").classList.toggle("on", state.unseenCount > 0);

  $("#empty").hidden = state.notifications.length > 0;
  $("#feed").replaceChildren(
    ...state.notifications.map((n) => {
      const item = document.createElement("li");
      item.className = n.readAt ? "read" : "unread";

      const button = document.createElement("button");
      button.type = "button";
      button.addEventListener("click", () => client.markAsRead(n.id));

      const from = document.createElement("span");
      from.className = "from";
      from.textContent = n.payload?.from ?? n.type;
      const when = document.createElement("span");
      when.className = "time";
      when.textContent = ago(n.createdAt);

      button.append(from, `: ${n.payload?.text ?? ""}`, when);
      item.append(button);
      return item;
    }),
  );
});

setInterval(() => {
  const t = client.getTransport();
  const how = t.transport === "sse" ? "event stream" : "polling";
  $("#transport").textContent = `${how} · ${t.role} tab${t.connected ? " · connected" : ""}`;
}, 500);

// Opening the inbox clears the badge (seen); clicking an item un-bolds it (read).
const bell = $("#bell");
const inbox = $("#inbox");
const setOpen = (open) => {
  inbox.hidden = !open;
  bell.setAttribute("aria-expanded", String(open));
  if (open && client.getState().unseenCount > 0) client.markSeen();
};
bell.addEventListener("click", () => setOpen(inbox.hidden));
document.addEventListener("click", (event) => {
  if (!inbox.hidden && !event.target.closest(".bell-wrap")) setOpen(false);
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") setOpen(false);
});
$("#read-all").addEventListener("click", () => client.markAllRead());

// ---- Email ----------------------------------------------------------------------------------

let shown = "";
const refreshEmails = async () => {
  const { emails } = await (await asUser("/api/outbox")).json();
  const ids = emails.map((email) => email.id).join();
  if (ids === shown) return;
  shown = ids;

  $("#email-pill").textContent = `${emails.length} received`;
  $("#email-pill").classList.toggle("on", emails.length > 0);
  $("#emails").replaceChildren(
    ...emails.map((email) => {
      const item = document.createElement("li");
      const details = document.createElement("details");
      const summary = document.createElement("summary");
      const subject = document.createElement("strong");
      subject.textContent = email.subject;
      const meta = document.createElement("span");
      meta.className = "meta";
      meta.textContent = `to ${email.to} · ${ago(email.sentAt)}`;
      summary.append(subject, meta);

      // The rendered HTML, isolated: an empty sandbox runs no scripts and can't reach this page.
      const preview = document.createElement("iframe");
      preview.setAttribute("sandbox", "");
      preview.title = email.subject;
      preview.srcdoc = email.html;

      details.append(summary, preview);
      item.append(details);
      return item;
    }),
  );
};
setInterval(refreshEmails, 1500);
await refreshEmails();

// ---- Sending --------------------------------------------------------------------------------

$("#composer").addEventListener("submit", async (event) => {
  event.preventDefault();
  const to = $("#to").value;
  const text = $("#text").value.trim();
  if (!text) return;

  const response = await asUser("/api/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ to, text }),
  });
  const result = await response.json();
  if (!response.ok) return log(`send failed: ${result.error}`);

  const channels = (result.notifications[0]?.deliveries ?? []).map((d) => d.channel);
  log(`sent to ${to} → ${channels.join(", ") || "nothing"}`);
  $("#text").value = "";
});

// ---- Web push -------------------------------------------------------------------------------

const pushPill = $("#push-pill");
const pushToggle = $("#push-toggle");
const { vapidPublicKey } = await (await fetch("/api/config")).json();

const showPush = async () => {
  if (!isPushSupported()) {
    pushPill.textContent = "not supported here";
    return;
  }
  const registration = await navigator.serviceWorker.getRegistration("/");
  const subscribed = Boolean(await registration?.pushManager.getSubscription());
  pushPill.textContent = subscribed ? "enabled" : "off";
  pushPill.classList.toggle("on", subscribed);
  pushToggle.textContent = subscribed ? "Disable push" : "Enable push";
  pushToggle.hidden = false;
};

pushToggle.addEventListener("click", async () => {
  try {
    if (pushToggle.textContent === "Enable push") {
      const subscription = await subscribeToPush({
        publicKey: vapidPublicKey,
        baseUrl: "/api/notifications",
        fetch: asUser,
      });
      log(`push enabled via ${new URL(subscription.endpoint).host}`);
    } else {
      await unsubscribeFromPush({ baseUrl: "/api/notifications", fetch: asUser });
      log("push disabled");
    }
  } catch (error) {
    log(`push: ${error.message}`);
  }
  await showPush();
});

await showPush();
