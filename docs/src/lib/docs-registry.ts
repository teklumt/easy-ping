import type { ComponentType } from "react";

export type DocModule = {
  default: ComponentType<{ components?: Record<string, ComponentType<never>> }>;
  frontmatter: { title: string; description: string };
  toc: readonly { id: string; label: string }[];
};

/**
 * Every .mdx file under content/docs, keyed by filename (without extension).
 * Eager + glob rather than one import per route: ~20 short docs pages cost
 * nothing to bundle together, and it keeps the router free of a hand-written
 * import list that content authors would otherwise have to remember to update.
 */
const modules = import.meta.glob<DocModule>("../content/docs/*.mdx", { eager: true });

export const DOCS: Record<string, DocModule> = {};

for (const [path, mod] of Object.entries(modules)) {
  const slug = path
    .split("/")
    .pop()
    ?.replace(/\.mdx$/, "");
  if (slug) DOCS[slug] = mod;
}
