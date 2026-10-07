import { StrictMode } from "react";
import { renderToString } from "react-dom/server";
import { StaticRouter } from "react-router-dom";
import { App } from "./App";
import { renderHeadTags, takeHead } from "./lib/head";
import { FLAT_NAV } from "./lib/nav";

/** Every route worth a static HTML file. The prerenderer and the sitemap both read this. */
export const routes: readonly { path: string; priority: number }[] = [
  { path: "/", priority: 1 },
  ...FLAT_NAV.map((item) => ({ path: `/docs/${item.slug}`, priority: 0.8 })),
  { path: "/legal", priority: 0.3 },
];

export function render(url: string): { html: string; head: string } {
  const html = renderToString(
    <StrictMode>
      <StaticRouter location={url}>
        <App />
      </StaticRouter>
    </StrictMode>,
  );
  const meta = takeHead();
  return { html, head: meta ? renderHeadTags(meta) : "" };
}
