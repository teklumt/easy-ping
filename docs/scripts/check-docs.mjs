// Fails the build when the docs drift out of shape. Runs before `vite build`.
//
// Written after an integrator found that plugin-table setup was documented for
// two databases and missing for the other three: every adapter page must cover
// the same questions, every channel page must show every database, every TOC
// entry must point at a real anchor, and llms-full.txt must carry the answers.
// Add a requirement here when a new kind of page appears.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { NAV } from "../src/lib/nav.ts";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const docsDir = join(root, "src", "content", "docs");
const read = (slug) => readFileSync(join(docsDir, `${slug}.mdx`), "utf8");
const problems = [];
const need = (slug, what, ok) => {
  if (!ok) problems.push(`${slug}: ${what}`);
};

// Every adapter page answers the same questions an integrator will ask.
const ADAPTERS = {
  "postgres-adapter": {
    tables: /createPostgresTables\(query, \{[\s\S]*plugins/,
    upgrade: /planPostgresMigration/,
  },
  "drizzle-adapter": { tables: /renderDrizzleSchema/, upgrade: /drizzle-kit/ },
  "mysql-adapter": {
    tables: /createMysqlTables\(query, \{[\s\S]*plugins/,
    upgrade: /planMysqlMigration/,
  },
  "sqlite-adapter": {
    tables: /createSqliteTables\(query, \{[\s\S]*plugins/,
    upgrade: /planSqliteMigration/,
  },
  "mongodb-adapter": { tables: /createPluginIndexes\(db/, upgrade: /idempotent/ },
};

for (const [slug, rule] of Object.entries(ADAPTERS)) {
  const page = read(slug);
  need(slug, "has no setup section", /<a id="setup" \/>/.test(page));
  need(slug, "does not show how to create plugin tables", rule.tables.test(page));
  need(slug, "does not say how to upgrade an existing database", rule.upgrade.test(page));
  need(slug, "does not mention the table prefix", /\bprefix\b/.test(page));
  need(slug, "has no cross-replica wake-ups section", /<a id="signals" \/>/.test(page));
}

// Every channel that owns tables shows how to create them on every database.
const CHANNEL_PAGES = ["push-plugin", "telegram", "mobile-push"];
const PER_DATABASE = [
  "createPostgresTables",
  "createMysqlTables",
  "createSqliteTables",
  "createPluginIndexes",
];
for (const slug of CHANNEL_PAGES) {
  const page = read(slug);
  for (const helper of PER_DATABASE) {
    need(slug, `does not show ${helper} for its tables`, page.includes(helper));
  }
}

// TOC entries and heading anchors must agree; nothing else checks this.
const files = readdirSync(docsDir).filter((file) => file.endsWith(".mdx"));
for (const file of files) {
  const slug = file.replace(/\.mdx$/, "");
  const page = read(slug);
  const tocBlock = page.match(/export const toc = \[([\s\S]*?)\];/)?.[1] ?? "";
  const tocIds = [...tocBlock.matchAll(/id: "([^"]+)"/g)].map((m) => m[1]);
  const anchors = new Set([...page.matchAll(/<a id="([^"]+)" \/>/g)].map((m) => m[1]));
  for (const id of tocIds)
    need(slug, `TOC entry "${id}" has no <a id="${id}" /> anchor`, anchors.has(id));
}

// Every nav slug has a page, and every page is reachable from the nav.
const navSlugs = new Set(
  NAV.flatMap((group) => group.items)
    .filter((item) => "slug" in item)
    .map((item) => item.slug),
);
const pageSlugs = new Set(files.map((file) => file.replace(/\.mdx$/, "")));
for (const slug of navSlugs)
  need("nav", `links to "${slug}", which has no .mdx file`, pageSlugs.has(slug));
for (const slug of pageSlugs) need(slug, "is not in the nav", navSlugs.has(slug));

// The AI context file must carry the answers, not point at pages.
const full = readFileSync(join(root, "public", "llms-full.txt"), "utf8");
const MUST_MENTION = [
  "createPluginIndexes",
  "createPostgresTables",
  "createMysqlTables",
  "createSqliteTables",
  "renderDrizzleSchema",
  "planPostgresMigration",
  "planMysqlMigration",
  "planSqliteMigration",
  "subscribeToPush",
  "unsubscribeFromPush",
  "isPushSupported",
  "generateVapidKeys",
  "NO build step",
  "telegram(",
  "mobilePush(",
  "getRecipients",
];
for (const term of MUST_MENTION)
  need("llms-full.txt", `does not mention ${term}`, full.includes(term));

if (problems.length > 0) {
  console.error(`docs check failed (${problems.length}):\n  - ${problems.join("\n  - ")}`);
  process.exit(1);
}
console.log(
  `docs check passed: ${Object.keys(ADAPTERS).length} adapters, ${CHANNEL_PAGES.length} channel pages, ${files.length} pages`,
);
