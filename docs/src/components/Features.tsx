import { ArrowUpRight, Bell, CalendarDays, Mail, SlidersHorizontal } from "lucide-react";
import { Link } from "react-router-dom";

const FEATURES = [
  {
    icon: Bell,
    kicker: "Keep users in the loop",
    title: "An inbox inside your app",
    body: "Live updates, unread badges, read states, and pagination. Headless React hooks handle the state; you build the UI.",
    slug: "in-app-inbox",
    detail: "Replies / mentions / activity",
  },
  {
    icon: Mail,
    kicker: "Reach beyond the app",
    title: "Email, push, and Telegram",
    body: "Send transactional email, browser push, and Telegram messages from the same event. Native mobile push is available in beta.",
    slug: "send",
    detail: "Order updates / reminders / alerts",
  },
  {
    icon: SlidersHorizontal,
    kicker: "Give users a choice",
    title: "A notification preference center",
    body: "Let each user choose which notifications arrive on which channels, with preferences applied when you send.",
    slug: "preferences",
    detail: "Per user / per notification / per channel",
  },
  {
    icon: CalendarDays,
    kicker: "Less noise, more context",
    title: "Daily and weekly digests",
    body: "Collect updates into a scheduled summary instead of sending every event immediately, with timezone-aware delivery.",
    slug: "digests",
    detail: "Activity summaries / daily roundups",
  },
];

export function Features() {
  return (
    <div className="features">
      {FEATURES.map((feature) => (
        <article className="feat" key={feature.title}>
          <feature.icon className="feat-icon" size={24} strokeWidth={1.5} aria-hidden="true" />
          <p className="feat-kicker">{feature.kicker}</p>
          <h3>{feature.title}</h3>
          <p className="feat-body">{feature.body}</p>
          <p className="feat-detail">{feature.detail}</p>
          <Link className="feat-link" to={`/docs/${feature.slug}`}>
            Read the guide <ArrowUpRight size={15} aria-hidden="true" />
          </Link>
        </article>
      ))}
    </div>
  );
}
