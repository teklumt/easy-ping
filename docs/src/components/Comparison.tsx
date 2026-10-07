/**
 * The comparison table.
 *
 * Every cell here is a checkable fact, not a slogan, and two rows are
 * deliberately ones easy-ping loses, because a table where the home team
 * wins everything is one nobody believes. Sources and the date they were
 * checked are printed under the table. Re-check them before a release.
 */

type Column = { key: string; name: string; note: string; ours?: boolean };

const COLUMNS: readonly Column[] = [
  { key: "easy", name: "easy-ping", note: "a library", ours: true },
  { key: "novu", name: "Novu", note: "self-hosted" },
  { key: "saas", name: "Knock · Courier", note: "hosted SaaS" },
];

type Row = {
  label: string;
  easy: string;
  novu: string;
  saas: string;
  /** Marks a row where easy-ping is the one behind. */
  against?: boolean;
};

const ROWS: readonly Row[] = [
  {
    label: "What you deploy",
    easy: "Nothing. It runs inside the app you already have.",
    novu: "Four services. API, worker, dashboard and websocket.",
    saas: "Nothing. It runs in their cloud.",
  },
  {
    label: "Infrastructure it adds",
    easy: "None",
    novu: "MongoDB, Redis and S3, on top of your own",
    saas: "None",
  },
  {
    label: "Where notifications are stored",
    easy: "Your Postgres, MySQL, SQLite or MongoDB, in tables you can query",
    novu: "Novu's own MongoDB",
    saas: "Their database, reachable by API",
  },
  {
    label: "Cost per notification",
    easy: "None",
    novu: "None, but you pay for the servers",
    saas: "Metered per send",
  },
  {
    label: "License",
    easy: "MIT, all of it",
    novu: "MIT core, commercial enterprise modules",
    saas: "Proprietary",
  },
  {
    label: "How you integrate",
    easy: "One config file, one send(), one hook",
    novu: "HTTP API plus an embeddable inbox",
    saas: "HTTP API plus an embeddable inbox",
  },
  {
    label: "Visual workflow editor",
    easy: "No. A notification is code, reviewed like code",
    novu: "Yes",
    saas: "Yes",
    against: true,
  },
  {
    label: "Channels out of the box",
    easy: "In-app, email, web push, mobile push, Telegram",
    novu: "Dozens of providers across every channel",
    saas: "Dozens of providers across every channel",
    against: true,
  },
];

export function Comparison() {
  return (
    <div className="cmp">
      <div className="tablewrap">
        <table className="cmp-table">
          <thead>
            <tr>
              {/* The corner of a table with both row and column headers is an
                  empty cell, not a header of anything. */}
              <td className="cmp-corner" />
              {COLUMNS.map((column) => (
                <th key={column.key} className={column.ours ? "cmp-ours" : undefined}>
                  <span className="cmp-name">{column.name}</span>
                  <span className="cmp-note">{column.note}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ROWS.map((row) => (
              <tr key={row.label}>
                <th scope="row">{row.label}</th>
                <td className={`cmp-ours${row.against ? " cmp-against" : ""}`}>{row.easy}</td>
                <td>{row.novu}</td>
                <td>{row.saas}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="cmp-source">
        Checked 22 September 2026 against{" "}
        <a href="https://github.com/novuhq/novu" target="_blank" rel="noreferrer">
          Novu's repository
        </a>{" "}
        and{" "}
        <a
          href="https://docs.novu.co/community/self-hosting-novu/deploy-with-docker"
          target="_blank"
          rel="noreferrer"
        >
          self-hosting guide
        </a>
        , and the{" "}
        <a href="https://knock.app/pricing" target="_blank" rel="noreferrer">
          Knock
        </a>{" "}
        and{" "}
        <a href="https://www.courier.com/pricing" target="_blank" rel="noreferrer">
          Courier
        </a>{" "}
        pricing pages. They are good tools solving a bigger problem. If you need a workflow editor
        that a non-developer can edit, use one of them.
      </p>
    </div>
  );
}
