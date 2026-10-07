import type { ReactElement, ReactNode } from "react";
import { highlight } from "../lib/highlight";

type Props = {
  /** Shown as the panel header, e.g. "notify.ts". Omit for a bare snippet. */
  title?: string;
  /** A ```fence``` child in .mdx, or a plain string from .tsx. */
  children: ReactNode;
  /** True inside <Tabs> — the tab bar is the header, so no panel-head/border. */
  bare?: boolean;
};

/**
 * Samples in .mdx are written as a ```fence``` inside the element, never as a
 * {`template literal`}: MDX strips up to two leading spaces from every
 * continuation line of a multi-line JSX expression, which silently ate the
 * indentation of every sample on the site. A fence is passed through
 * byte-exactly. See the README's "Writing a doc page" section.
 *
 * That makes the child a <pre><code> element rather than a string, so the raw
 * text is read back out of it — .tsx callers still pass a plain string.
 */
function rawCode(node: ReactNode): string {
  if (typeof node === "string") return node;
  const children = (node as ReactElement<{ children?: ReactNode }> | null)?.props?.children;
  return children === undefined || children === node ? "" : rawCode(children);
}

/**
 * The one way code renders on the site. Used explicitly in .mdx content —
 * `<CodeBlock title="notify.ts">` wrapping a fence — rather than a bare fence,
 * so every real example gets the filename header the design calls for.
 */
export function CodeBlock({ title, children, bare }: Props) {
  const body = (
    <pre className="code">
      <code>{highlight(rawCode(children).replace(/^\n/, "").trimEnd())}</code>
    </pre>
  );

  if (bare) return body;

  return (
    <div className="panel">
      {title ? <div className="panel-head">{title}</div> : null}
      {body}
    </div>
  );
}

/**
 * Fallback for a stray Markdown ```fence``` in prose that is not wrapped in a
 * CodeBlock (e.g. a one-line shell command in a callout).
 */
export function Pre(props: { children?: ReactElement<{ children?: string }> }) {
  const raw =
    typeof props.children?.props.children === "string" ? props.children.props.children : "";
  return (
    <pre className="code">
      <code>{highlight(raw.replace(/\n$/, ""))}</code>
    </pre>
  );
}
