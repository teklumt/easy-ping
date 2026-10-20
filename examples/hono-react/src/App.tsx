import { createNotifyClient, useNotifications } from "easy-ping/react";
import { useState } from "react";
import { Bell } from "./Bell";
import { EmailCard, InAppCard, PushCard } from "./Channels";
import { asCurrentUser, currentUser } from "./user";

const EVENTS = [
  { type: "commentReply", label: "Reply to a comment", detail: "A teammate answers a thread" },
  { type: "taskAssigned", label: "Assign a task", detail: "Work lands on someone's plate" },
  { type: "invoicePaid", label: "Mark an invoice paid", detail: "A system event, no actor" },
] as const;

const PEOPLE = ["you", "dana", "sam"];

export function App() {
  // One client for the whole page, so the bell and the status card share one connection.
  // scope keeps tabs signed in as different users from sharing it across tabs.
  const [client] = useState(() => createNotifyClient({ fetch: asCurrentUser, scope: currentUser }));
  const inbox = useNotifications({ client });

  const [to, setTo] = useState(currentUser);
  const [log, setLog] = useState<string[]>([]);
  const other = currentUser === "dana" ? "you" : "dana";
  const addLog = (line: string) =>
    setLog((lines) => [`${new Date().toLocaleTimeString()}  ${line}`, ...lines].slice(0, 8));

  async function trigger(type: (typeof EVENTS)[number]["type"]) {
    const response = await asCurrentUser("/api/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type, to }),
    });
    if (!response.ok) return addLog(`${type} failed: ${response.status}`);

    const result = (await response.json()) as {
      notifications: { deliveries: { channel: string }[] }[];
    };
    const channels = (result.notifications[0]?.deliveries ?? []).map((d) => d.channel);
    addLog(`${type} to ${to} → ${channels.join(", ") || "nothing"}`);
  }

  return (
    <>
      <header className="bar">
        <span className="brand">
          <span className="mark">a</span>Acme
        </span>
        <span className="who">
          signed in as <strong>{currentUser}</strong>
        </span>
        <Bell inbox={inbox} />
      </header>

      <main>
        <h1>Trigger an event</h1>
        <p className="lede">
          Each button calls <code>notify.send()</code> on the Hono server, which reaches the bell, a
          push notification and an email. Open{" "}
          <a href={`/?user=${other}`} target="_blank" rel="noreferrer">
            a second window as {other}
          </a>{" "}
          and send to them to watch it arrive somewhere else.
        </p>

        <label className="recipient">
          Send to
          <select value={to} onChange={(event) => setTo(event.target.value)}>
            {PEOPLE.map((person) => (
              <option key={person}>{person}</option>
            ))}
          </select>
        </label>

        <div className="events">
          {EVENTS.map((event) => (
            <button
              key={event.type}
              type="button"
              className="event"
              onClick={() => void trigger(event.type)}
            >
              <strong>{event.label}</strong>
              <span>{event.detail}</span>
            </button>
          ))}
        </div>

        <section className="channels" aria-label="What arrived">
          <InAppCard client={client} unseen={inbox.unseenCount} />
          <PushCard request={asCurrentUser} onLog={addLog} />
          <EmailCard request={asCurrentUser} />
        </section>

        {log.length > 0 && (
          <ol className="log">
            {log.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ol>
        )}
      </main>
    </>
  );
}
