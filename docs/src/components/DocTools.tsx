import { useCopy } from "../lib/clipboard";
import { API_CONTEXT } from "../lib/prompts";

const REPO_EDIT_BASE = "https://github.com/teklumt/easy-ping/edit/main/docs/src/content/docs/";
// Flip back to true to bring the link back.
const EDIT_LINK_ENABLED = false;

/**
 * The two actions in a doc page's header.
 *
 * "Copy AI context" is deliberately the same API_CONTEXT block every prompt
 * card on the landing page uses — not a bespoke Markdown dump of this one
 * page. Pasting it before you ask a question is what actually fixes the
 * "AI invents this library's API" problem; a literal page-to-Markdown export
 * would not.
 */
export function DocTools({ slug }: { slug: string }) {
  const { copied, copy } = useCopy();

  return (
    <div className="doc-tools">
      {EDIT_LINK_ENABLED && (
        <a className="tool" href={`${REPO_EDIT_BASE}${slug}.mdx`} target="_blank" rel="noreferrer">
          Edit this page
        </a>
      )}
      <button type="button" className="tool" data-done={copied} onClick={() => copy(API_CONTEXT)}>
        {copied ? "Copied" : "Copy AI context"}
      </button>
    </div>
  );
}
