<div align="center">

# easy-ping docs

**The documentation site for [easy-ping](https://github.com/teklumt/easy-ping).**
A landing page and 28 docs pages, written in MDX, built with Vite + React, and prerendered to
static HTML so every page arrives with its title, description and structured data in place.

[![site](https://img.shields.io/website?url=https%3A%2F%2Feasy-pings.com&label=easy-pings.com&up_color=%23e0362a)](https://easy-pings.com)
[![npm](https://img.shields.io/npm/v/easy-ping?color=%23e0362a&label=easy-ping)](https://www.npmjs.com/package/easy-ping)
[![node](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](#)
[![license](https://img.shields.io/badge/license-MIT-blue)](https://easy-pings.com/legal)

[Live site](https://easy-pings.com) · [Quickstart](https://easy-pings.com/docs/quickstart) · [Changelog](https://easy-pings.com/docs/changelog) · [llms.txt](https://easy-pings.com/llms.txt) · [Library repo](https://github.com/teklumt/easy-ping)

</div>

---

```bash
pnpm install
pnpm dev        # http://localhost:17173
pnpm build      # -> dist/  (client build, then prerender + sitemap)
pnpm preview    # http://localhost:17174, serves dist/
pnpm lint       # biome
pnpm og         # regenerate public/og.png after a version bump
```

Hand-authored content, no CMS, no server: `pnpm build` writes a `dist/` of plain HTML, CSS and
JS that any static host can serve. This README is written for whoever touches this next,
including a future you.

The dev server runs on **17173, not Vite's usual 5173**; see
[Why the port is pinned](#why-the-port-is-pinned). Requires **Node 22+**, because the build
scripts import `.ts` files directly through Node's native type stripping (the library itself
supports Node 20; this is a requirement of this repo's tooling alone).

---

## Where this lives

The site is the `docs/` workspace package (`easy-ping-docs`) of the
[easy-ping monorepo](https://github.com/teklumt/easy-ping), the way
[better-auth](https://github.com/better-auth/better-auth) keeps its docs. An API change and the
docs describing it can land in one PR. The package is private and listed under `ignore` in
`.changeset/config.json`, so it is never versioned or published.

Run the commands above from `docs/`, or from the repo root as `pnpm docs:dev` and
`pnpm docs:build`. There's no dependency on the `easy-ping` package here; this site is
hand-authored content, not generated from the library's source.

## Staying in sync with the library

Nothing forces the docs to follow the library, so these are the things to re-check here whenever
`easy-ping` cuts a release:

1. **`src/lib/prompts.ts`** — the `API_CONTEXT` block is a hand-written summary of the public
   API. If a signature changed, this is the highest-value thing to update in the whole repo; see
   [The AI-context feature](#the-ai-context-feature).
2. **The release catalog** — add the release to `RELEASES` in `src/lib/releases.ts` and move
   `current: true` to it. The version badge needs nothing: `CURRENT_VERSION` is read from
   `packages/easy-ping/package.json` at build time.
3. **Any changed API surface** in the 28 pages under `src/content/docs/`.
4. **`pnpm og`** — the social image carries the version number, so regenerate and commit it.

---

## Table of contents

- [How it's put together](#how-its-put-together)
- [Writing a doc page](#writing-a-doc-page)
- [The design system](#the-design-system)
- [The AI-context feature](#the-ai-context-feature)
- [The support dialog](#the-support-dialog)
- [Adding a page to the nav](#adding-a-page-to-the-nav)
- [Why the port is pinned](#why-the-port-is-pinned)
- [Prerendering and SEO](#prerendering-and-seo)
- [Deploying](#deploying)
- [Known limitations](#known-limitations)

---

## How it's put together

```
docs/
├── scripts/
│   ├── generate-llms.mjs      generates public/llms*.txt from src/lib/prompts.ts (before dev/build)
│   ├── prerender.mjs          renders every route to static HTML + sitemap.xml (after vite build)
│   └── generate-og.mjs        renders public/og.png (run by hand: pnpm og)
├── public/
│   ├── favicon.svg
│   ├── og.png                  the social preview image (generated — regenerate, don't edit)
│   ├── robots.txt
│   ├── llms.txt                (generated — do not hand-edit)
│   └── llms-full.txt           (generated — do not hand-edit)
├── src/
│   ├── content/docs/*.mdx      the 28 doc pages — this is where you'll spend most of your time
│   ├── components/             CodeBlock, Tabs, Note, Sidebar, Toc, Pager, PromptSection, Head, ...
│   ├── pages/                  Landing.tsx, DocPage.tsx, Legal.tsx, NotFound.tsx
│   ├── lib/
│   │   ├── nav.ts              the sidebar/pager order — the one source of truth for doc order
│   │   ├── prompts.ts          the AI-context text — the one source of truth for that
│   │   ├── releases.ts         the changelog catalog; CURRENT_VERSION (read from the package's package.json)
│   │   ├── site.ts             the canonical origin and site-wide copy — the one source of truth for URLs
│   │   ├── head.ts             per-page <head> tags, rendered statically and applied on navigation
│   │   ├── docs-registry.ts    globs every .mdx file into a { slug: module } map
│   │   ├── highlight.tsx       the syntax highlighter (see below — deliberately small)
│   │   └── clipboard.ts        the copy-to-clipboard hook every "Copy" button uses
│   ├── styles/
│   │   ├── tokens.css          colors/type/spacing — every design decision lives here
│   │   ├── global.css          chrome, docs shell, shared primitives (.panel, .btn, .wrap)
│   │   └── landing.css         landing-page-only rules (hero, AI section, stats, features)
│   ├── App.tsx                 the router: "/", "/docs/:slug", "/legal", 404
│   ├── main.tsx                browser entry: hydrates prerendered HTML (or renders fresh in dev)
│   └── entry-server.tsx        prerender entry: the route list and render(url)
├── index.html                  the shell: <!--app-head--> / <!--app-html--> markers, pre-paint theme script
├── vercel.json                 no trailing slash, static files first, SPA fallback for the rest
└── vite.config.ts              MDX + remark-gfm + React, in that plugin order
```

**No server, no database, no CMS.** `pnpm build` produces `dist/`: one HTML file per route with
its content and `<head>` already in it, plus the JS that hydrates it. Deploy it anywhere that
serves static files (see [Deploying](#deploying)).

## Writing a doc page

Every file in `src/content/docs/*.mdx` follows the same shape. Copy an existing one that's close
to what you're writing rather than starting from this description, but here's what each part
does:

```mdx
export const frontmatter = {
  title: "Page Title",              // shown as the <h1> and in the sidebar breadcrumb
  description: "One sentence.",     // shown under the h1, in the "intro" style
};

export const toc = [
  { id: "section-one", label: "Section One" },   // must match a heading's <a id="section-one" />
];

## Section One <a id="section-one" />

Regular markdown. **Bold**, `inline code`, [links](/docs/other-page), and GFM tables all work.
```

**Why headings use `<a id="..." />` instead of the more common `{#id}` syntax:** MDX parses every
`{...}` in the document as a JavaScript expression — including inside headings — so a heading
written as `## Section One {#section-one}` fails to compile (acorn tries to parse `#section-one`
as JS and errors). A literal, brace-free `<a id="section-one" />` sidesteps that entirely and
renders as an empty, focusable anchor right inside the heading.

**Two things must stay in sync, and nothing checks this for you:** the `id` in a `toc` entry has
to match a real `<a id="...">` somewhere in the body, or that TOC link goes nowhere. If you add a
`##` heading, add its anchor **and** its `toc` entry in the same edit.

### Available components

These are wired into every `.mdx` file automatically via `DocPage.tsx`'s `mdxComponents` map — no
per-file import needed:

| Component | Use for |
| --- | --- |
| `<CodeBlock title="...">` wrapping a fence | A code sample with a filename header. This is the default way to show code. |
| `<CodeBlock bare>` wrapping a fence | The same, with no header/border — for a snippet inline in prose. |
| `<Tabs labels={["A", "B"]}><CodeBlock bare>...</CodeBlock><CodeBlock bare>...</CodeBlock></Tabs>` | Switching between equivalent code paths (see `quickstart.mdx` for the Drizzle/Raw SQL/MongoDB example). |
| `<Note tag="Heads up">...</Note>` | A callout for anything a reader must not skim past. Keep `tag` to one or two words. |

If a page needs something none of these cover — `ai-assistant.mdx` does this — you can `import`
a real component at the top of the `.mdx` file, same as any other module:

```mdx
import { PromptSection } from "../../components/PromptSection";

...later in the body...

<PromptSection />
```

### How to write a code sample

The code goes in a fence, wrapped in a `<CodeBlock>` — blank lines around the fence, and the
fence itself at column 0:

```mdx
<CodeBlock title="notify.ts">

```ts
export const notify = easyPing({
  database: postgresAdapter(query),
});
```

</CodeBlock>
```

`<CodeBlock>` is what gives the sample its filename header — `notify.ts`,
`app/api/.../route.ts` — which is part of the visual language the approved design established and
something a bare fence cannot express. A fence on its own still renders (`Pre` in
`CodeBlock.tsx` is wired to MDX's `pre` override), just without the header.

**Never write the code as `{`a template literal`}`.** MDX strips up to two leading spaces from
every continuation line of a multi-line JSX expression, so a template literal silently loses the
indentation of every line of the sample:

```
type SqlQuery = (        authored as        type SqlQuery = (
text: string,            renders as -->       text: string,
) => …                                      ) => …
```

The whole site was written this way at first and every indented sample on all 25 pages came out
flat. A fence is passed through byte-exactly, and as a bonus needs no `\`` or `\${` escaping,
so samples containing template literals read as the code actually looks.

## The design system

`src/styles/tokens.css` is the single source of every color, font, and spacing decision on the
site — components reference `var(--accent)`, never a literal hex code. If you're asked to
"rebrand" or adjust the palette, that file is the entire diff.

Three-state theming is built in: an un-stamped document follows `prefers-color-scheme`, and
`data-theme="light"` / `data-theme="dark"` on `<html>` overrides it either direction. An inline
script in `index.html` stamps the attribute before first paint (stored choice, else the OS), and
the topbar toggle in `TopBar.tsx` flips it and stores the choice in `localStorage`.

**The syntax highlighter (`src/lib/highlight.tsx`) is intentionally not a real one.** It's a
single regex pass recognizing four token categories — comments, strings, function calls, numbers
— tuned to read the same as the approved design's hand-authored spans. It will mis-highlight
unusual TypeScript constructs. If code samples ever need real language-aware highlighting, swap
it for Shiki or Prism; until then, this costs zero bundle weight and zero configuration.

## The AI-context feature

This is the reason the "Use with an AI assistant" page and the landing page's prompt buttons
exist: **every current model's training cutoff predates this library**, so a cold request to
"add easy-ping" produces a fluent, invented API. The fix is cheap — paste the real surface into
the conversation first — and this site is where that context lives.

**`src/lib/prompts.ts` is the single source of truth.** It exports `API_CONTEXT` (the shared API
reference block) and `PROMPTS` (four task-specific prompts, each built on top of `API_CONTEXT`).
Both the copy buttons on the site *and* the two static files below are generated from this one
file — nothing is duplicated by hand.

**`scripts/generate-llms.mjs`** imports `prompts.ts` directly using Node's native TypeScript
stripping (Node ≥22, matching the workspace's `engines.node`) and writes:

- `public/llms.txt` — a short index, following the [llms.txt](https://llmstxt.org) convention
- `public/llms-full.txt` — `llms.txt` plus the complete `API_CONTEXT` block

This runs automatically before `dev` and `build` (see `package.json`), so the generated files can
never drift from what the site's buttons actually copy. **Never hand-edit either `.txt` file** —
edit `src/lib/prompts.ts` and the generator will overwrite them on the next `dev` or `build`.

If you update the library's public API, updating `API_CONTEXT` to match is the single most
valuable edit you can make to this site — it's what every "vibe coder" prompt button and every
crawler fetching `llms-full.txt` is actually built on.

### Why "Copy AI context" isn't a real Markdown export of each page

The doc-page header has a "Copy AI context" button (`DocTools.tsx`). It copies the same
`API_CONTEXT` block every prompt on the landing page uses — **not** a literal Markdown dump of
that specific page. That's a deliberate choice, not a shortcut: pasting the API surface before
asking a question is what actually fixes the "AI invents this library" problem. A page-to-
Markdown export would be a nice-to-have for a different reason (letting someone paste a page into
a chat) but would require either storing raw Markdown source separately from the compiled MDX
component (duplicating content) or serializing the rendered JSX back to text (lossy, and fragile
against custom components like `<Tabs>`). If that's ever wanted, treat it as a new feature, not a
fix to this one.

## The support dialog

The topbar's **Support** button opens `src/components/SupportDialog.tsx` — a native
`<dialog>` with the two ways to reach the maintainer. The contact details are constants at the
top of that file; **that's the only place to change them**:

```ts
const EMAIL = "teklumo.jembere@gmail.com";   // opens mailto: with a prefilled subject
const TELEGRAM = "teklumt";                   // opens https://t.me/<handle>
```

It uses `showModal()` rather than a hand-rolled div, which brings Escape-to-close, focus
containment and an inert background for free. Click-outside-to-close is bound as a native
listener in a `useEffect` (a click landing on the dialog element itself *is* a backdrop click) —
not as a JSX `onClick`, which would trip an a11y lint rule that can't tell the two apart.

Bear in mind the email address is published in plain text in the built bundle, so it will be
scraped. That's the tradeoff for a one-click mailto; an obfuscated address or a contact form
would trade convenience for a little cover.

## Adding a page to the nav

`src/lib/nav.ts` is the **only** place page order and grouping are declared. It drives four
things at once: the sidebar (`Sidebar.tsx`) and the mobile menu (`MobileMenu.tsx`, sharing
`NavTree`), the prev/next pager (`Pager.tsx`), and breadcrumbs (`DocPage.tsx`'s `groupFor`). Below
760px the top bar collapses to the brand, the sun/moon theme toggle and a hamburger; the drawer
slides in from the left with the hidden controls (Docs, Support, GitHub) and then the docs tree. A backdrop tap, the close button,
Escape or navigating closes it. To add a page:

1. Add an `.mdx` file under `src/content/docs/` (see [Writing a doc page](#writing-a-doc-page)).
2. Add one entry to the matching group in `NAV` in `nav.ts` — `{ label: "...", slug: "..." }`,
   where `slug` matches the filename without `.mdx`.

That's it. `docs-registry.ts` globs the file automatically; nothing else needs to know it exists.

A **planned but unshipped** channel or adapter (SMS, Slack, and so on) gets an entry with no
`slug` — `{ label: "SMS", soon: true }` — which renders in the sidebar unlinked with a `SOON`
badge, and is correctly excluded from the pager since `FLAT_NAV` only includes linked items.

## Why the port is pinned

`vite.config.ts` pins the dev server to **17173** and preview to **17174**, not Vite's defaults
(5173 / 4173). On Windows, this is the difference between the site starting and this:

```
Error: listen EACCES: permission denied ::1:5173
```

That reads like a filesystem permissions problem. It isn't — the OS has reserved the port.
Note it's `EACCES`, not `EADDRINUSE`: nothing is *using* the port, and Vite's "try the next
port" fallback only handles `EADDRINUSE`, so it can't recover on its own.

**Why it happens, and why it looks random.** Hyper-V and Docker Desktop reserve blocks of ports
out of the Windows *dynamic port range*, and those blocks get reshuffled on every reboot — a
port that worked yesterday can fail today. Check both the range and the current reservations:

```bash
netsh int ipv4 show dynamicport tcp              # the range they're drawn from
netsh int ipv4 show excludedportrange protocol=tcp   # today's reservations
netsh int ipv6 show excludedportrange protocol=tcp   # same list, IPv6 — Vite binds ::1 first
```

The default dynamic range is 49152–65535, but Docker/Hyper-V installs commonly widen it to
start at **1024**, which puts every conventional dev port (3000, 5173, 8080…) permanently at
risk. Anything **above the range's end** never is — hence 17173.

If a machine's range is wide enough to cover 17173 too, pick a higher port. To fix it properly
system-wide instead, restore the standard ephemeral range from an **admin** shell:

```powershell
netsh int ipv4 set dynamicport tcp start=49152 num=16384
netsh int ipv6 set dynamicport tcp start=49152 num=16384
```

That frees ports 1024–49151 for every project on the machine, not just this one.

## Prerendering and SEO

The site started as a plain SPA: one `<title>` for everything and an empty `#root` until
JavaScript ran, which is what a crawler or a link unfurler saw. It is now prerendered.

**How a build works.** `vite build` produces the client bundle and `dist/index.html`. Then
`scripts/prerender.mjs` runs a Vite SSR build of `src/entry-server.tsx`, calls `render(url)` for
every route in its list (`/`, every linked slug in `nav.ts`, `/legal`), and writes each result
into a copy of `dist/index.html` at the `<!--app-head-->` and `<!--app-html-->` markers:
`dist/docs/quickstart/index.html` and so on, plus `dist/404.html` (marked `noindex`) and
`dist/sitemap.xml` from the same route list, so a page cannot be prerendered yet missing from the
sitemap. In the browser, `main.tsx` sees the root already has children and hydrates instead of
rendering; React Router takes over from there. `pnpm dev` skips all of this and renders fresh.

**Per-page `<head>`.** Each page renders a `<Head>` (`src/components/Head.tsx`) with its title,
description and path. `src/lib/head.ts` turns that into title, description, canonical, robots,
Open Graph, Twitter card and JSON-LD tags: captured into the static HTML at build time, applied to
the live document on client-side navigation. What each page emits:

| Page | Title | Structured data |
| --- | --- | --- |
| Landing | `easy-ping — Self-hosted notifications for TypeScript` | `SoftwareApplication` (version, MIT, npm, free) + `WebSite` |
| Doc page | `<frontmatter.title> · easy-ping docs` | `TechArticle` + `BreadcrumbList` (site › Docs › group › page) |
| Legal | `Legal · easy-ping` | none |
| 404 | `Page not found · easy-ping` | none; `noindex, nofollow` |

**The canonical origin lives in one place**, `src/lib/site.ts`. Canonicals, `og:url`, the sitemap
and `robots.txt`'s `Sitemap:` line all derive from it (robots.txt is static; update it by hand
if the domain changes). `public/og.png` is the 1200×630 social image, rendered from an SVG in
`scripts/generate-og.mjs` with `@resvg/resvg-js` and this machine's fonts, which is why it is
generated by hand (`pnpm og`) and committed rather than built on the host.

**The one rule prerendering imposes:** a component must not touch `window`, `document`,
`localStorage` or `matchMedia` during render. Effects are fine. `TopBar.tsx` is the example: the
theme state starts `null` and is resolved in an effect, so the server and the first client render
agree and hydration has nothing to patch. The pre-paint theme script in `index.html` is what stops
a dark-mode visitor seeing a light flash in the meantime.

**Checking a deploy:** `curl -I https://easy-pings.com/docs/quickstart` should return
200 for the prerendered file, not the SPA fallback; `curl -s .../docs/quickstart | grep '<title>'`
should show the page's own title. Paste any docs URL into a link-preview debugger and the card
should carry the page title, description and `og.png`.

## Deploying

`pnpm build` produces a static `dist/`; no server runtime is required. The production host is
Vercel, configured by `vercel.json`: `trailingSlash: false` so `/docs/quickstart` serves
`docs/quickstart/index.html`, real files win over the rewrite, and only paths with no file fall
back to `index.html` (React Router then shows the 404 page). `public/_redirects` does the same
for Netlify and Cloudflare Pages. Long-lived cache headers apply to `/assets/*` (content-hashed),
one hour to `sitemap.xml`, `robots.txt` and `og.png`.

`public/llms.txt` and `public/llms-full.txt` need to actually exist in the deployed output. They
do, because `generate-llms.mjs` runs as part of `pnpm build`, not as a separate manual step.

## Known limitations

Documenting what's missing so it's a choice, not a surprise:

- **No search.** The approved design mocked up a `⌘K` search box in the topbar; the real
  `TopBar.tsx` leaves it out entirely rather than shipping a decorative control that does nothing.
  Real client-side search over the 25 docs pages — Pagefind, or a hand-rolled Fuse.js index — is
  the most valuable next addition, and the topbar's the obvious place to put its trigger back.
- **The theme toggle stores a per-browser choice only.** Picking light or dark writes to
  `localStorage` and stamps `data-theme` on the root; with nothing stored the page follows the
  OS via `prefers-color-scheme`. There's no "reset to system" control once a choice is made —
  clearing site data is the only way back.
- **`sitemap.xml` uses the build date as every page's `lastmod`.** Real per-page dates would need
  git history at build time; not worth it at this size.
- **The 404 page is only prerendered for hosts that serve `404.html`.** On Vercel an unknown path
  falls back to `index.html` (200) and React Router renders the 404 client-side, so the
  `noindex` arrives with the JS, not the HTML. A `vercel.json` route to `404.html` with status
  404 would close it.
- **The syntax highlighter is deliberately minimal** — see
  [The design system](#the-design-system).
