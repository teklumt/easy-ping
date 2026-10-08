// Writes public/llms.txt and public/llms-full.txt from src/lib/prompts.ts.
//
// Run automatically before dev and build (see package.json), so the two
// static files served to crawlers and AI assistants can never drift from the
// prompt text shown on the site itself. Node's native TS stripping (>=22)
// imports the .ts source directly — no build step needed for this script.

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isLinked, NAV } from "../src/lib/nav.ts";
import { API_CONTEXT, PROMPTS } from "../src/lib/prompts.ts";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const publicDir = join(root, "public");

// The description each page already shows under its own <h1>.
async function describe(slug) {
  const source = await readFile(join(root, "src", "content", "docs", `${slug}.mdx`), "utf8");
  const literal = source.match(/export const frontmatter = (\{[\s\S]*?\n\});/)?.[1];
  const description = literal ? new Function(`return ${literal}`)().description : undefined;
  if (!description) throw new Error(`${slug}.mdx has no frontmatter description`);
  return description;
}

// Built from the same NAV the sidebar and route list read, so this can't list a page
// that doesn't exist or drift out of sync with one that does.
const groups = await Promise.all(
  NAV.map(async (group) => {
    const items = await Promise.all(
      group.items
        .filter(isLinked)
        .map(async (item) => `- [${item.label}](/docs/${item.slug}): ${await describe(item.slug)}`),
    );
    return `### ${group.title}\n\n${items.join("\n")}`;
  }),
);
const DOCS = groups.join("\n\n");

const SHORT = `# easy-ping

> Free, open-source notifications for TypeScript. In-app inbox,
> transactional email, web push, mobile push and Telegram. Runs inside your
> app; stores notifications in your own Postgres, MySQL, SQLite or MongoDB
> database. No cloud component, no per-notification billing.

This library shipped after most language models' training cutoffs.
For the full API surface an AI assistant needs to use it correctly,
fetch /llms-full.txt from this same origin.

## Docs

${DOCS}

## Source

- npm: https://www.npmjs.com/package/easy-ping
- Repository: https://github.com/teklumt/easy-ping
`;

// Every task prompt's specifics (web push, Telegram, React Native, MongoDB, plugins) belong in the
// one file an assistant fetches, not only behind the copy buttons.
const DETAILS = Object.values(PROMPTS)
  .map(({ label, text }) => {
    const body = text
      .replace(API_CONTEXT, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    return `## ${label}\n\n${body}`;
  })
  .join("\n\n");

const FULL = `${SHORT}\n---\n\n${API_CONTEXT}\n\n---\n\n# Task-specific details\n\n${DETAILS}\n`;

await writeFile(join(publicDir, "llms.txt"), SHORT);
await writeFile(join(publicDir, "llms-full.txt"), FULL);

console.log("generated public/llms.txt and public/llms-full.txt");
