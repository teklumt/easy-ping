import {
  Bell,
  Check,
  FolderKanban,
  House,
  Inbox,
  Mail,
  RotateCcw,
  Send,
  Settings,
  Smartphone,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { CodeBlock } from "./CodeBlock";

const SNIPPET = `await notify.send("commentReply", {
  to: userId,
  payload: { authorName: "Dana", commentId: "c_123" },
});`;

// When each channel shows up after Send, in ms. Simulated: nothing leaves the browser.
const ARRIVALS = { inApp: 500, push: 1200, email: 1900 } as const;
type Channel = keyof typeof ARRIVALS;

const CHANNELS: { id: Channel; label: string; icon: typeof Bell }[] = [
  { id: "inApp", label: "In-app", icon: Bell },
  { id: "push", label: "Web push", icon: Smartphone },
  { id: "email", label: "Email", icon: Mail },
];

const NONE: Record<Channel, boolean> = { inApp: false, push: false, email: false };
const ALL: Record<Channel, boolean> = { inApp: true, push: true, email: true };

const reducedMotion = () =>
  typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export function DeviceDemo() {
  const [arrived, setArrived] = useState(NONE);
  const [sending, setSending] = useState(false);
  const [read, setRead] = useState(false);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const stage = useRef<HTMLDivElement>(null);
  const played = useRef(false);

  function send() {
    for (const timer of timers.current) clearTimeout(timer);
    timers.current = [];
    setRead(false);

    if (reducedMotion()) {
      setArrived(ALL);
      return;
    }

    setArrived(NONE);
    setSending(true);
    for (const [channel, delay] of Object.entries(ARRIVALS) as [Channel, number][]) {
      timers.current.push(
        setTimeout(() => setArrived((current) => ({ ...current, [channel]: true })), delay),
      );
    }
    timers.current.push(setTimeout(() => setSending(false), ARRIVALS.email));
  }

  // Plays once when the demo scrolls into view. Effects never run while prerendering.
  // biome-ignore lint/correctness/useExhaustiveDependencies: send() only reads refs and setters
  useEffect(() => {
    const node = stage.current;
    if (!node) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting && !played.current) {
          played.current = true;
          send();
        }
      },
      { threshold: 0.4 },
    );
    observer.observe(node);
    return () => {
      observer.disconnect();
      for (const timer of timers.current) clearTimeout(timer);
    };
  }, []);

  const done = arrived.email;
  const unread = arrived.inApp && !read;

  return (
    <div className="device-demo">
      <div className="demo-console">
        <div className="demo-code">
          <span className="demo-file">app/api/comments/route.ts</span>
          <CodeBlock bare>{SNIPPET}</CodeBlock>
        </div>

        <div className="demo-controls">
          <button type="button" className="btn btn-primary" disabled={sending} onClick={send}>
            {done ? (
              <RotateCcw size={16} aria-hidden="true" />
            ) : (
              <Send size={16} aria-hidden="true" />
            )}
            {sending ? "Sending…" : done ? "Send again" : "Send"}
          </button>

          <ul className="demo-chips" aria-label="Delivery">
            {CHANNELS.map(({ id, label, icon: Icon }) => (
              <li key={id} data-arrived={arrived[id]}>
                {arrived[id] ? (
                  <Check size={14} aria-hidden="true" />
                ) : (
                  <Icon size={14} aria-hidden="true" />
                )}
                {label}
              </li>
            ))}
          </ul>

          <p className="demo-note" role="status">
            {done
              ? "Delivered to all three. Simulated in your browser; nothing was sent."
              : "Simulated in your browser. Nothing is sent."}
          </p>
        </div>
      </div>

      <div className="demo-stage" ref={stage}>
        <div className="device-desktop">
          <div className="window-bar" aria-hidden="true">
            <span className="window-dots">
              <i />
              <i />
              <i />
            </span>
            <span className="window-url">acme.app/projects/launch</span>
          </div>

          <div className="window-body">
            <nav className="app-side" aria-label="Example app">
              <span className="app-brand">
                <span className="app-mark">a</span>Acme
              </span>
              <span>
                <House size={16} aria-hidden="true" /> Home
              </span>
              <span className="is-active">
                <FolderKanban size={16} aria-hidden="true" /> Projects
              </span>
              <span>
                <Inbox size={16} aria-hidden="true" /> Inbox
              </span>
              <span>
                <Settings size={16} aria-hidden="true" /> Settings
              </span>
            </nav>

            <div className="app-main">
              <div className="app-top">
                <strong>Launch plan</strong>
                <span
                  className="app-bell"
                  role="img"
                  aria-label={unread ? "1 unread notification" : "No unread notifications"}
                >
                  <Bell size={18} aria-hidden="true" />
                  {unread && <span className="app-badge">1</span>}
                </span>
              </div>

              <ul className="app-tasks" aria-hidden="true">
                <li>
                  <Check size={14} />
                  Write the launch post
                </li>
                <li>
                  <Check size={14} />
                  Review the pricing page
                </li>
                <li className="is-open">
                  <span className="task-ring" />
                  Ship the release
                </li>
              </ul>

              {arrived.inApp && (
                <div className="app-dropdown">
                  <div className="dropdown-head">
                    <strong>Notifications</strong>
                    <span>{read ? "All caught up" : "1 unread"}</span>
                  </div>
                  <button
                    type="button"
                    className="dropdown-item"
                    data-read={read}
                    onClick={() => setRead(true)}
                  >
                    <span className="avatar">D</span>
                    <span className="dropdown-text">
                      <strong>Dana replied to your comment</strong>
                      <span>"Looks good. Let's ship it!"</span>
                      <small>{read ? "Read" : "Just now · click to mark read"}</small>
                    </span>
                    {!read && <span className="unread-dot" aria-hidden="true" />}
                  </button>
                </div>
              )}
            </div>
          </div>

          {arrived.push && (
            <div className="push-toast">
              <span className="app-mark">a</span>
              <span className="toast-text">
                <small>Chrome · acme.app · now</small>
                <strong>Dana replied to your comment</strong>
                <span>"Looks good. Let's ship it!"</span>
              </span>
            </div>
          )}
        </div>

        <div className="device-phone">
          <div className="phone-screen">
            <div className="phone-status" aria-hidden="true">
              <span>9:41</span>
              <span className="phone-notch" />
              <span>5G</span>
            </div>
            <div className="mail-head">
              <strong>Inbox</strong>
              <span>{done ? "1 new" : "Up to date"}</span>
            </div>
            <ul className="mail-list">
              {arrived.email && (
                <li className="mail-row is-new">
                  <span className="avatar">A</span>
                  <span className="mail-text">
                    <strong>Acme</strong>
                    <span className="mail-subject">Dana replied to your comment</span>
                    <span>"Looks good. Let's ship it!"</span>
                  </span>
                  <small>now</small>
                </li>
              )}
              <li className="mail-row">
                <span className="avatar">A</span>
                <span className="mail-text">
                  <strong>Acme</strong>
                  <span className="mail-subject">Your weekly summary</span>
                  <span>3 projects moved this week.</span>
                </span>
                <small>Mon</small>
              </li>
              <li className="mail-row">
                <span className="avatar">A</span>
                <span className="mail-text">
                  <strong>Acme</strong>
                  <span className="mail-subject">Welcome to Acme</span>
                  <span>Here is how to get started.</span>
                </span>
                <small>Sep 2</small>
              </li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}
