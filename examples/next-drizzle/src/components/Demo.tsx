"use client";

import { createNotifyClient, useNotifications } from "easy-ping/react";
import { useState } from "react";
import { Actions } from "./Actions";
import { EmailCard, InAppCard, PushCard } from "./Channels";
import { NotificationBell } from "./NotificationBell";

export function Demo({ current }: { current: string }) {
  // One client for the page, so the bell and the status card share one connection. Same-origin,
  // so the session cookie rides along with every request.
  const [client] = useState(() => createNotifyClient());
  const inbox = useNotifications({ client });

  const [log, setLog] = useState<string[]>([]);
  const addLog = (line: string) =>
    setLog((lines) => [`${new Date().toLocaleTimeString()}  ${line}`, ...lines].slice(0, 8));

  return (
    <>
      <header className="bar">
        <span className="brand">
          <span className="mark">a</span>Acme
        </span>
        <span className="who">
          signed in as <strong>{current}</strong>
        </span>
        <NotificationBell inbox={inbox} />
      </header>

      <main>
        <h1>Send a notification</h1>
        <p className="lede">
          Each button calls a route handler that calls <code>notify.send()</code>. Delivery runs
          after the response through Next&apos;s <code>after()</code> and reaches the bell, a push
          notification and an email.
        </p>

        <Actions current={current} onLog={addLog} />

        <section className="channels" aria-label="What arrived">
          <InAppCard client={client} unseen={inbox.unseenCount} />
          <PushCard request={fetch} onLog={addLog} />
          <EmailCard request={fetch} />
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
