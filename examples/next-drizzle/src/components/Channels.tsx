"use client";

import { isPushSupported, subscribeToPush, unsubscribeFromPush } from "easy-ping/browser";
import type { NotifyClient } from "easy-ping/react";
import { useCallback, useEffect, useState } from "react";

type Fetch = typeof fetch;

export function InAppCard({ client, unseen }: { client: NotifyClient; unseen: number }) {
  const [transport, setTransport] = useState("connecting…");

  useEffect(() => {
    const timer = setInterval(() => {
      const t = client.getTransport();
      const how = t.transport === "sse" ? "event stream" : "polling";
      setTransport(`${how} · ${t.role} tab${t.connected ? " · connected" : ""}`);
    }, 500);
    return () => clearInterval(timer);
  }, [client]);

  return (
    <article className="channel">
      <div className="channel-head">
        <h2>In-app</h2>
        <span className={unseen > 0 ? "pill on" : "pill"}>{unseen} unseen</span>
      </div>
      <p>The bell, top right. Opening it clears the badge; clicking an item marks it read.</p>
      <p className="mono">{transport}</p>
    </article>
  );
}

export function PushCard({ request, onLog }: { request: Fetch; onLog: (line: string) => void }) {
  const [state, setState] = useState<"checking" | "unsupported" | "off" | "on" | "working">(
    "checking",
  );

  const refresh = useCallback(async () => {
    if (!isPushSupported()) return setState("unsupported");
    const registration = await navigator.serviceWorker.getRegistration("/");
    setState((await registration?.pushManager.getSubscription()) ? "on" : "off");
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function toggle() {
    const enabling = state === "off";
    setState("working");
    try {
      if (enabling) {
        const { vapidPublicKey } = (await (await fetch("/api/config")).json()) as {
          vapidPublicKey: string;
        };
        const subscription = await subscribeToPush({
          publicKey: vapidPublicKey,
          baseUrl: "/api/notifications",
          fetch: request,
        });
        onLog(`push enabled via ${new URL(subscription.endpoint).host}`);
      } else {
        await unsubscribeFromPush({ baseUrl: "/api/notifications", fetch: request });
        onLog("push disabled");
      }
    } catch (error) {
      onLog(`push: ${error instanceof Error ? error.message : String(error)}`);
    }
    await refresh();
  }

  const label = {
    checking: "checking…",
    unsupported: "not supported here",
    off: "off",
    on: "enabled",
    working: "subscribing…",
  }[state];

  return (
    <article className="channel">
      <div className="channel-head">
        <h2>Web push</h2>
        <span className={state === "on" ? "pill on" : "pill"}>{label}</span>
      </div>
      <p>
        Enable it, send yourself a notification, then look outside this tab: it arrives as a system
        notification. The first subscription can take a few seconds.
      </p>
      {(state === "on" || state === "off" || state === "working") && (
        <button
          type="button"
          className="secondary"
          disabled={state === "working"}
          onClick={() => void toggle()}
        >
          {state === "on" ? "Disable push" : "Enable push"}
        </button>
      )}
    </article>
  );
}

type SentEmail = { id: string; to: string; subject: string; html: string; sentAt: string };

export function EmailCard({ request }: { request: Fetch }) {
  const [emails, setEmails] = useState<SentEmail[]>([]);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      const { emails } = (await (await request("/api/outbox")).json()) as { emails: SentEmail[] };
      if (alive) {
        setEmails((current) =>
          current.map((e) => e.id).join() === emails.map((e) => e.id).join() ? current : emails,
        );
      }
    };
    void load();
    const timer = setInterval(() => void load(), 1500);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [request]);

  return (
    <article className="channel">
      <div className="channel-head">
        <h2>Email</h2>
        <span className={emails.length > 0 ? "pill on" : "pill"}>{emails.length} received</span>
      </div>
      <p>
        Rendered from the notification's email template and handed to an outbox provider that keeps
        it here instead of sending it.
      </p>
      <ul className="emails">
        {emails.map((email) => (
          <li key={email.id}>
            <details>
              <summary>
                <strong>{email.subject}</strong>
                <span className="meta">
                  to {email.to} · {new Date(email.sentAt).toLocaleTimeString()}
                </span>
              </summary>
              {/* An empty sandbox runs no scripts and cannot reach this page. */}
              <iframe sandbox="" title={email.subject} srcDoc={email.html} />
            </details>
          </li>
        ))}
      </ul>
    </article>
  );
}
