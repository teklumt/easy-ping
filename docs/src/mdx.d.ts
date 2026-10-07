declare module "*.mdx" {
  import type { ComponentType } from "react";

  export const frontmatter: { title: string; description: string };
  export const toc: readonly { id: string; label: string }[];

  const MDXComponent: ComponentType<{ components?: Record<string, ComponentType<never>> }>;
  export default MDXComponent;
}
