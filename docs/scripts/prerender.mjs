// Turns the SPA build into static HTML, one file per route, after `vite build`.
//
// Crawlers and link previews then get the real page (title, description,
// canonical, Open Graph, JSON-LD, the full article) without running JS; the
// browser hydrates the same markup and React Router takes over from there.
// Also writes sitemap.xml from the same route list, so a page cannot be
// prerendered and missing from the sitemap, or the other way round.

import { execFileSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "vite";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(root, "dist");
const ssrOut = join(root, "dist-ssr");

await build({
  root,
  logLevel: "warn",
  build: { ssr: "src/entry-server.tsx", outDir: ssrOut, emptyOutDir: true },
});

const { render, routes } = await import(pathToFileURL(join(ssrOut, "entry-server.js")).href);
const template = await readFile(join(dist, "index.html"), "utf8");

if (!template.includes("<!--app-head-->") || !template.includes("<!--app-html-->")) {
  throw new Error("index.html lost its <!--app-head--> / <!--app-html--> markers");
}

const page = (path) => {
  const { html, head } = render(path);
  return template.replace("<!--app-head-->", head).replace("<!--app-html-->", html);
};

for (const route of routes) {
  const file = route.path === "/" ? join(dist, "index.html") : join(dist, route.path, "index.html");
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, page(route.path));
}
// Static hosts serve this for unknown paths; it carries noindex.
await writeFile(join(dist, "404.html"), page("/__not_found__"));

const { SITE_URL } = await import("../src/lib/site.ts");
const today = new Date().toISOString().slice(0, 10);

const sourceFileFor = (path) => {
  if (path === "/") return "src/pages/Landing.tsx";
  if (path === "/legal") return "src/pages/Legal.tsx";
  return `src/content/docs/${path.slice("/docs/".length)}.mdx`;
};

// Falls back to the build date on a shallow clone (or no git), where a page's
// last-touching commit can be outside the fetched history.
function lastModFor(path) {
  try {
    const date = execFileSync("git", ["log", "-1", "--format=%cs", "--", sourceFileFor(path)], {
      cwd: root,
      encoding: "utf8",
    }).trim();
    if (date) return date;
  } catch {}
  return today;
}

const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${routes
  .map(
    (route) => `  <url>
    <loc>${SITE_URL}${route.path === "/" ? "" : route.path}</loc>
    <lastmod>${lastModFor(route.path)}</lastmod>
    <priority>${route.priority.toFixed(1)}</priority>
  </url>`,
  )
  .join("\n")}
</urlset>
`;
await writeFile(join(dist, "sitemap.xml"), sitemap);

await rm(ssrOut, { recursive: true, force: true });
console.log(`prerendered ${routes.length} routes + 404.html, wrote sitemap.xml`);
