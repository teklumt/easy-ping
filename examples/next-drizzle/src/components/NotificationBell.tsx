"use client";

import { useNotifications } from "easy-notify/react";
import { useState } from "react";

export function NotificationBell() {
  const { notifications, unseenCount, unreadCount, isLoading, markAsRead, markAllRead, markSeen } =
    useNotifications();

  const [open, setOpen] = useState(false);

  function toggle() {
    const next = !open;
    setOpen(next);
    // Opening the dropdown clears the badge; individual items stay bold until
    // clicked. seen and read are separate states.
    if (next && unseenCount > 0) void markSeen();
  }

  return (
    <div>
      <button type="button" onClick={toggle}>
        Notifications {unseenCount > 0 && <span>{unseenCount}</span>}
      </button>

      {open && (
        <div>
          {isLoading && <p>Loading…</p>}

          {unreadCount > 0 && (
            <button type="button" onClick={() => void markAllRead()}>
              Mark all read ({unreadCount})
            </button>
          )}

          <ul>
            {notifications.map((notification) => (
              <li key={notification.id}>
                <button
                  type="button"
                  onClick={() => void markAsRead(notification.id)}
                  style={{ fontWeight: notification.readAt ? "normal" : "bold" }}
                >
                  {renderBody(notification.type, notification.payload)}
                </button>
              </li>
            ))}
          </ul>

          {notifications.length === 0 && !isLoading && <p>Nothing yet.</p>}
        </div>
      )}
    </div>
  );
}

// In-app payloads render client-side, so anything in `payload` is visible to
// the recipient. Never put server-only data there.
function renderBody(type: string, payload: unknown): string {
  const data = payload as Record<string, unknown>;

  if (type === "commentReply") return `${String(data.authorName)} replied to you`;
  if (type === "invoicePaid") return `Invoice paid: $${Number(data.amount) / 100}`;
  return type;
}
