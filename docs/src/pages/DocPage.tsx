import { Navigate, useParams } from "react-router-dom";
import { CodeBlock, Pre } from "../components/CodeBlock";
import { DocTools } from "../components/DocTools";
import { Head } from "../components/Head";
import { Note } from "../components/Note";
import { Pager } from "../components/Pager";
import { Sidebar } from "../components/Sidebar";
import { Tabs } from "../components/Tabs";
import { Toc } from "../components/Toc";
import { DOCS } from "../lib/docs-registry";
import { groupFor } from "../lib/nav";
import { AUTHOR, absolute, SITE_NAME, SITE_URL } from "../lib/site";

// Made available inside every .mdx file with no per-file import — see the
// README's "Writing a doc page" section for how each one is used.
const mdxComponents = { CodeBlock, Tabs, Note, pre: Pre };

export function DocPage() {
  const { slug = "" } = useParams();
  const doc = DOCS[slug];

  if (!doc) return <Navigate to="/docs/introduction" replace />;

  const Content = doc.default;
  const group = groupFor(slug);
  const path = `/docs/${slug}`;
  const jsonLd = [
    {
      "@context": "https://schema.org",
      "@type": "TechArticle",
      headline: doc.frontmatter.title,
      description: doc.frontmatter.description,
      url: absolute(path),
      isPartOf: { "@type": "WebSite", name: SITE_NAME, url: SITE_URL },
      author: { "@type": "Person", name: AUTHOR.name, url: AUTHOR.url },
      inLanguage: "en",
    },
    {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: SITE_NAME, item: SITE_URL },
        { "@type": "ListItem", position: 2, name: "Docs", item: absolute("/docs/introduction") },
        ...(group ? [{ "@type": "ListItem", position: 3, name: group }] : []),
        {
          "@type": "ListItem",
          position: group ? 4 : 3,
          name: doc.frontmatter.title,
          item: absolute(path),
        },
      ],
    },
  ];

  return (
    <div className="docs">
      <Head
        title={`${doc.frontmatter.title} · ${SITE_NAME} docs`}
        description={doc.frontmatter.description}
        path={path}
        type="article"
        jsonLd={jsonLd}
      />
      <Sidebar />

      <article className="doc">
        <div className="doc-head">
          <p className="crumbs">
            {group ?? "Docs"} <span>/ {doc.frontmatter.title}</span>
          </p>
          <DocTools slug={slug} />
        </div>

        <h1>{doc.frontmatter.title}</h1>
        <p className="intro">{doc.frontmatter.description}</p>

        <Content components={mdxComponents} />

        <Pager slug={slug} />
      </article>

      <Toc items={doc.toc} />
    </div>
  );
}
