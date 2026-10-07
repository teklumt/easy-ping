import type { ReactNode } from "react";

/**
 * The callout used for anything a reader must not skim past — a required
 * config field, a footgun, a security note. `tag` is the small uppercase
 * label; keep it to one or two words ("Heads up", "Security", "Vibe coding?").
 */
export function Note({ tag = "Note", children }: { tag?: string; children: ReactNode }) {
  return (
    <div className="note">
      <span className="tag">{tag}</span>
      <div>{children}</div>
    </div>
  );
}
