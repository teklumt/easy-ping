"use client";

import { useState } from "react";
import { PEOPLE } from "../session";

type SendResult = { notifications: { deliveries: { channel: string }[] }[] };

export function Actions({ current, onLog }: { current: string; onLog: (line: string) => void }) {
  const [to, setTo] = useState<string>(current);

  // Stands in for signing in as someone else; the bell reconnects as that user on reload.
  function switchUser(person: string) {
    location.assign(`/api/session?user=${encodeURIComponent(person)}`);
  }

  async function post(path: string, body: unknown, label: string) {
    const response = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) return onLog(`${label} failed: ${response.status}`);

    const result = (await response.json()) as SendResult;
    const channels = (result.notifications[0]?.deliveries ?? []).map((d) => d.channel);
    onLog(`${label} → ${channels.join(", ") || "nothing"}`);
  }

  return (
    <>
      <div className="card controls">
        <label>
          Signed in as
          <select value={current} onChange={(event) => switchUser(event.target.value)}>
            {PEOPLE.map((person) => (
              <option key={person}>{person}</option>
            ))}
          </select>
        </label>
        <label>
          Reply to
          <select value={to} onChange={(event) => setTo(event.target.value)}>
            {PEOPLE.map((person) => (
              <option key={person}>{person}</option>
            ))}
          </select>
        </label>
      </div>

      <div className="events">
        <button
          type="button"
          className="event"
          onClick={() => void post("/api/comments", { threadOwnerId: to }, `commentReply to ${to}`)}
        >
          <strong>Reply to {to === current ? "your own" : `${to}'s`} comment</strong>
          <span>A user action with an actor and a deduplication key</span>
        </button>
        <button
          type="button"
          className="event"
          onClick={() => void post("/api/invoices", {}, `invoicePaid to ${current}`)}
        >
          <strong>Mark your invoice paid</strong>
          <span>A system event with no actor</span>
        </button>
      </div>
    </>
  );
}
