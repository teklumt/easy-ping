import { absolute, OG_IMAGE, SITE_NAME } from "./site";

export type HeadMeta = {
  /** The full document title, already suffixed. */
  title: string;
  description: string;
  /** Route path, e.g. "/docs/quickstart". Becomes the canonical and og:url. */
  path: string;
  type?: "website" | "article";
  noindex?: boolean;
  jsonLd?: readonly Record<string, unknown>[];
};

// The last <Head> rendered. renderToString is synchronous, so the prerenderer
// reads this right after rendering a route and gets that route's tags.
let captured: HeadMeta | null = null;
export const captureHead = (meta: HeadMeta) => {
  captured = meta;
};
export const takeHead = (): HeadMeta | null => {
  const meta = captured;
  captured = null;
  return meta;
};

const escapeAttr = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** What a page's <Head> becomes in static HTML. Same tags the client upserts at runtime. */
export function renderHeadTags(meta: HeadMeta): string {
  const url = absolute(meta.path);
  const tags = [
    `<title>${escapeAttr(meta.title)}</title>`,
    `<meta name="description" content="${escapeAttr(meta.description)}" />`,
    `<link rel="canonical" href="${url}" />`,
    `<meta name="robots" content="${meta.noindex ? "noindex, nofollow" : "index, follow"}" />`,
    `<meta property="og:type" content="${meta.type ?? "website"}" />`,
    `<meta property="og:site_name" content="${SITE_NAME}" />`,
    `<meta property="og:title" content="${escapeAttr(meta.title)}" />`,
    `<meta property="og:description" content="${escapeAttr(meta.description)}" />`,
    `<meta property="og:url" content="${url}" />`,
    `<meta property="og:image" content="${OG_IMAGE}" />`,
    `<meta property="og:image:width" content="1200" />`,
    `<meta property="og:image:height" content="630" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="${escapeAttr(meta.title)}" />`,
    `<meta name="twitter:description" content="${escapeAttr(meta.description)}" />`,
    `<meta name="twitter:image" content="${OG_IMAGE}" />`,
  ];
  for (const item of meta.jsonLd ?? []) {
    // "</script" inside a JSON string would end the block early.
    const json = JSON.stringify(item).replace(/</g, "\\u003c");
    tags.push(`<script type="application/ld+json">${json}</script>`);
  }
  return tags.join("\n    ");
}

function upsert(selector: string, create: () => HTMLElement, apply: (el: HTMLElement) => void) {
  let el = document.head.querySelector<HTMLElement>(selector);
  if (!el) {
    el = create();
    document.head.appendChild(el);
  }
  apply(el);
}

const meta = (attr: "name" | "property", key: string, content: string) =>
  upsert(
    `meta[${attr}="${key}"]`,
    () => {
      const el = document.createElement("meta");
      el.setAttribute(attr, key);
      return el;
    },
    (el) => el.setAttribute("content", content),
  );

/** Client-side counterpart of renderHeadTags: updates the live document on navigation. */
export function applyHead(head: HeadMeta) {
  const url = absolute(head.path);
  document.title = head.title;
  meta("name", "description", head.description);
  meta("name", "robots", head.noindex ? "noindex, nofollow" : "index, follow");
  upsert(
    'link[rel="canonical"]',
    () => {
      const el = document.createElement("link");
      el.setAttribute("rel", "canonical");
      return el;
    },
    (el) => el.setAttribute("href", url),
  );
  meta("property", "og:type", head.type ?? "website");
  meta("property", "og:site_name", SITE_NAME);
  meta("property", "og:title", head.title);
  meta("property", "og:description", head.description);
  meta("property", "og:url", url);
  meta("property", "og:image", OG_IMAGE);
  meta("name", "twitter:card", "summary_large_image");
  meta("name", "twitter:title", head.title);
  meta("name", "twitter:description", head.description);
  meta("name", "twitter:image", OG_IMAGE);

  for (const el of document.head.querySelectorAll('script[type="application/ld+json"]')) {
    el.remove();
  }
  for (const item of head.jsonLd ?? []) {
    const el = document.createElement("script");
    el.type = "application/ld+json";
    el.textContent = JSON.stringify(item).replace(/</g, "\\u003c");
    document.head.appendChild(el);
  }
}
