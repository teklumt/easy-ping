"use client";

import type { NotificationView, UseNotificationsResult } from "easy-ping/react";
import { useEffect, useRef, useState } from "react";

export function NotificationBell({ inbox }: { inbox: UseNotificationsResult }) {
  const { notifications, unseenCount, unreadCount, isLoading, markAsRead, markAllRead, markSeen } =
    inbox;

  const [open, setOpen] = useState(false);
  const wrapper = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent | KeyboardEvent) => {
      const outside =
        event instanceof KeyboardEvent
          ? event.key === "Escape"
          : !wrapper.current?.contains(event.target as Node);
      if (outside) setOpen(false);
    };
    document.addEventListener("click", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("click", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);

  // Opening the dropdown clears the badge; items stay bold until clicked. seen and read are
  // separate states.
  function toggle() {
    const next = !open;
    setOpen(next);
    if (next && unseenCount > 0) void markSeen();
  }

  return (
    <div className="bell-wrap" ref={wrapper}>
      <button type="button" className="bell" aria-expanded={open} onClick={toggle}>
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.7 21a2 2 0 0 1-3.4 0" />
        </svg>
        <span className="sr-only">Notifications</span>
        {unseenCount > 0 && (
          <span key={unseenCount} className="badge">
            {unseenCount > 99 ? "99+" : unseenCount}
          </span>
        )}
      </button>

      {open && (
        <section className="inbox" aria-label="Notifications">
          <div className="inbox-head">
            <strong>Notifications</strong>
            {unreadCount > 0 && (
              <button type="button" className="link" onClick={() => void markAllRead()}>
                Mark all read
              </button>
            )}
          </div>

          {notifications.length > 0 ? (
            <ul>
              {notifications.map((notification) => (
                <li key={notification.id} className={notification.readAt ? "read" : "unread"}>
                  <button type="button" onClick={() => void markAsRead(notification.id)}>
                    <span>{describe(notification)}</span>
                    <span className="time">
                      {new Date(notification.createdAt).toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="empty">{isLoading ? "Loading…" : "Nothing yet."}</p>
          )}
        </section>
      )}
    </div>
  );
}

// In-app payloads render client-side, so anything in `payload` is visible to the recipient.
// Never put server-only data there.
function describe(notification: NotificationView): string {
  const data = notification.payload as Record<string, unknown>;

  if (notification.type === "commentReply") return `${String(data.authorName)} replied to you`;
  if (notification.type === "invoicePaid") {
    return `Invoice paid: $${(Number(data.amount) / 100).toFixed(2)}`;
  }
  return notification.type;
}
