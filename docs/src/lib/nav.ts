/**
 * The one place doc order and grouping are declared.
 *
 * The sidebar, the prev/next pager, and route generation all read this list —
 * add a page here and it appears everywhere; get the order wrong here and it's
 * wrong everywhere, which is the point. A `soon` entry has no `slug` and
 * renders unlinked in the sidebar, matching a channel or adapter that's
 * planned but not shipped.
 */

export type NavItem = { label: string; slug: string; beta?: true } | { label: string; soon: true };

export type NavGroup = { title: string; items: readonly NavItem[] };

export const NAV: readonly NavGroup[] = [
  {
    title: "Getting started",
    items: [
      { label: "Introduction", slug: "introduction" },
      { label: "Quickstart", slug: "quickstart" },
      { label: "Configuration", slug: "configuration" },
      { label: "Use with an AI assistant", slug: "ai-assistant" },
    ],
  },
  {
    title: "Core",
    items: [
      { label: "send()", slug: "send" },
      { label: "Delivery modes", slug: "delivery-modes" },
      { label: "Route handler", slug: "route-handler" },
      { label: "Cron sweep", slug: "cron" },
    ],
  },
  {
    title: "Channels",
    items: [
      { label: "In-app inbox", slug: "in-app-inbox" },
      { label: "Web push", slug: "web-push" },
      { label: "Email", slug: "email" },
      { label: "Telegram", slug: "telegram" },
      { label: "Mobile push", slug: "mobile-push", beta: true },
      { label: "SMS", soon: true },
      { label: "Slack", soon: true },
    ],
  },
  {
    title: "Plugins",
    items: [
      { label: "Preferences", slug: "preferences" },
      { label: "Digests", slug: "digests" },
      { label: "Push devices", slug: "push-plugin" },
      { label: "Writing a plugin", slug: "writing-a-plugin" },
    ],
  },
  {
    title: "Adapters",
    items: [
      { label: "Postgres · any driver", slug: "postgres-adapter" },
      { label: "Drizzle · Postgres", slug: "drizzle-adapter" },
      { label: "MongoDB", slug: "mongodb-adapter" },
      { label: "MySQL", slug: "mysql-adapter" },
      { label: "SQLite", slug: "sqlite-adapter" },
      { label: "Writing an adapter", slug: "writing-an-adapter" },
    ],
  },
  {
    title: "Guides",
    items: [
      { label: "React Native", slug: "react-native", beta: true },
      { label: "Upgrading", slug: "upgrading" },
      { label: "When something fails", slug: "failures" },
      { label: "Security", slug: "security" },
      { label: "Stability and versioning", slug: "stability" },
    ],
  },
  {
    title: "Releases",
    items: [{ label: "Changelog", slug: "changelog" }],
  },
];

export const isLinked = (item: NavItem): item is { label: string; slug: string; beta?: true } =>
  "slug" in item;

/** Flattened, linked-only, in document order — what the pager walks. */
export const FLAT_NAV: readonly { label: string; slug: string }[] = NAV.flatMap((group) =>
  group.items.filter(isLinked),
);

export function groupFor(slug: string): string | null {
  return (
    NAV.find((group) => group.items.some((item) => isLinked(item) && item.slug === slug))?.title ??
    null
  );
}

export function adjacent(slug: string): {
  prev: { label: string; slug: string } | null;
  next: { label: string; slug: string } | null;
} {
  const index = FLAT_NAV.findIndex((item) => item.slug === slug);
  if (index === -1) return { prev: null, next: null };
  return {
    prev: FLAT_NAV[index - 1] ?? null,
    next: FLAT_NAV[index + 1] ?? null,
  };
}
