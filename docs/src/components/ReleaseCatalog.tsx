import { type ChangeKind, RELEASES } from "../lib/releases";

const KIND_LABEL: Record<ChangeKind, string> = {
  added: "Added",
  fixed: "Fixed",
  changed: "Changed",
  security: "Security",
};

const formatDate = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });

/**
 * Entries are written in the same voice as the docs, so they carry markdown
 * backticks. Nothing else in them is markdown, so a full parser would be
 * overkill — code spans are the whole vocabulary.
 */
function withCode(text: string) {
  return text.split(/`([^`]+)`/).map((part, index) =>
    index % 2 === 1 ? (
      // biome-ignore lint/suspicious/noArrayIndexKey: split output is positional
      <code key={index}>{part}</code>
    ) : (
      part
    ),
  );
}
/**
 * The release catalog. Entries live in src/lib/releases.ts.
 *
 * Grouped by kind within a release rather than listed flat, so someone
 * scanning for "did anything break" can find the fixes without reading the
 * additions.
 */
export function ReleaseCatalog() {
  return (
    <div className="releases">
      {RELEASES.map((release) => {
        const kinds = (["security", "fixed", "changed", "added"] as const).filter((kind) =>
          release.changes.some((change) => change.kind === kind),
        );

        return (
          <section className="release" key={release.version}>
            <div className="release-head">
              <h2 id={`v${release.version}`} className="release-version">
                {release.version}
                {release.current ? <span className="release-current">current</span> : null}
              </h2>
              <time className="release-date" dateTime={release.date}>
                {formatDate(release.date)}
              </time>
            </div>

            <p className="release-summary">{withCode(release.summary)}</p>

            {kinds.map((kind) => (
              <div className="release-group" key={kind}>
                <h3 className={`release-kind kind-${kind}`}>{KIND_LABEL[kind]}</h3>
                <ul className="release-list">
                  {release.changes
                    .filter((change) => change.kind === kind)
                    .map((change) => (
                      <li key={change.title}>
                        <strong>{withCode(change.title)}</strong>
                        {change.detail ? <span>{withCode(change.detail)}</span> : null}
                      </li>
                    ))}
                </ul>
              </div>
            ))}
          </section>
        );
      })}
    </div>
  );
}
