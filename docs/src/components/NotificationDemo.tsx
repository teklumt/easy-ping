import { Bell, Check, Inbox, Mail, RotateCcw, Send, Smartphone } from "lucide-react";
import { useId, useState } from "react";
import { CodeBlock } from "./CodeBlock";

const EXAMPLE = `await notify.send("commentReply", {
  to: threadOwnerId,
  payload: {
    authorName: "Dana",
    commentId: "c_123",
  },
  dedupeKey: "commentReply:c_123",
});`;

const CHANNELS = [
  { id: "inbox", label: "In-app inbox", icon: Inbox },
  { id: "email", label: "Email", icon: Mail },
  { id: "push", label: "Web push", icon: Smartphone },
] as const;

export function NotificationDemo() {
  const groupId = useId();
  const [channel, setChannel] = useState<(typeof CHANNELS)[number]["id"]>("inbox");
  const [sent, setSent] = useState(false);
  const [read, setRead] = useState(false);

  function reset() {
    setSent(false);
    setRead(false);
  }

  return (
    <section className="notification-demo" id="demo" aria-label="Interactive notification example">
      <div className="demo-heading">
        <span>One event. Every channel you choose.</span>
        <span className="demo-label">Local demo</span>
      </div>
      <div className="demo-grid">
        <div className="demo-source">
          <div className="demo-file">app/api/comments/route.ts</div>
          <CodeBlock bare>{EXAMPLE}</CodeBlock>
          <div className="demo-actions">
            <button
              className="btn btn-primary"
              type="button"
              disabled={sent}
              onClick={() => setSent(true)}
            >
              {sent ? (
                <Check size={16} aria-hidden="true" />
              ) : (
                <Send size={16} aria-hidden="true" />
              )}
              {sent ? "Example sent" : "Send example"}
            </button>
            <button
              className="demo-reset"
              type="button"
              onClick={reset}
              title="Reset example"
              aria-label="Reset example"
            >
              <RotateCcw size={17} aria-hidden="true" />
            </button>
          </div>
        </div>
        <div className="demo-output">
          <fieldset className="demo-channels">
            <legend className="demo-sr-only">Notification channel</legend>
            {CHANNELS.map(({ id, label, icon: Icon }) => (
              <label key={id}>
                <input
                  type="radio"
                  name={groupId}
                  value={id}
                  checked={channel === id}
                  onChange={() => setChannel(id)}
                />
                <span>
                  <Icon size={15} aria-hidden="true" />
                  {label}
                </span>
              </label>
            ))}
          </fieldset>
          <div className="demo-preview">
            <div className="demo-appbar">
              <span className="demo-appname">
                <span className="demo-appmark">a</span>Acme workspace
              </span>
              <span
                className="demo-bell"
                role="img"
                aria-label={`${sent && !read ? 1 : 0} unread notifications`}
              >
                <Bell size={19} aria-hidden="true" />
                {sent && !read && <span className="demo-count">1</span>}
              </span>
            </div>
            <div className="demo-preview-body" key={channel}>
              {channel === "inbox" ? (
                <>
                  <div className="demo-inbox-heading">
                    <strong>Notifications</strong>
                    <span>{sent && !read ? "1 unread" : "All caught up"}</span>
                  </div>
                  {sent ? (
                    <div className="demo-notification" data-read={read}>
                      <span className="demo-avatar">D</span>
                      <div>
                        <strong>Dana replied to your comment</strong>
                        <p>"Looks good. Let's ship it!"</p>
                        <div className="demo-message-meta">
                          <span>Just now</span>
                          <button type="button" disabled={read} onClick={() => setRead(true)}>
                            {read ? "Read" : "Mark as read"}
                          </button>
                        </div>
                      </div>
                      {!read && <span className="demo-unread-dot" aria-hidden="true" />}
                    </div>
                  ) : (
                    <div className="demo-empty">
                      <Inbox size={30} strokeWidth={1.4} aria-hidden="true" />
                      <strong>You're all caught up</strong>
                      <span>No new notifications.</span>
                    </div>
                  )}
                </>
              ) : channel === "email" ? (
                <>
                  <div className="demo-inbox-heading">
                    <strong>Email</strong>
                    <span>via Resend</span>
                  </div>
                  {sent ? (
                    <div className="demo-email">
                      <span>Acme &lt;updates@acme.example&gt;</span>
                      <h3>Dana replied to your comment</h3>
                      <p>"Looks good. Let's ship it!"</p>
                      <span className="demo-destination">acme.example/comments/c_123</span>
                    </div>
                  ) : (
                    <div className="demo-empty">
                      <Mail size={30} strokeWidth={1.4} aria-hidden="true" />
                      <strong>No new messages</strong>
                      <span>Your inbox is empty.</span>
                    </div>
                  )}
                </>
              ) : (
                <>
                  <div className="demo-inbox-heading">
                    <strong>Browser notifications</strong>
                    <span>Web push</span>
                  </div>
                  {sent ? (
                    <div className="demo-push">
                      <span className="demo-appmark">a</span>
                      <div>
                        <span>Acme · now</span>
                        <strong>Dana replied to your comment</strong>
                        <p>"Looks good. Let's ship it!"</p>
                      </div>
                    </div>
                  ) : (
                    <div className="demo-empty">
                      <Bell size={30} strokeWidth={1.4} aria-hidden="true" />
                      <strong>No new alerts</strong>
                      <span>Nothing waiting for you.</span>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
          <div className="demo-status" role="status">
            <span className={sent ? "demo-status-dot is-sent" : "demo-status-dot"} />
            {sent
              ? "Example delivered locally. No external messages sent."
              : "Ready to send. No account or API keys needed."}
          </div>
        </div>
      </div>
    </section>
  );
}
