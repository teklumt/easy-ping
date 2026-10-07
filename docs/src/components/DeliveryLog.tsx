type Row = { channel: string; via: string; status: "sent" | "pending" | "failed" };

const ROWS: readonly Row[] = [
  { channel: "inApp", via: "written to your notification table", status: "sent" },
  { channel: "email", via: "resend · notifications@acme.dev", status: "sent" },
  { channel: "push", via: "web-push · 2 devices · aes128gcm", status: "sent" },
  { channel: "telegram", via: "@acme_bot · 1 linked chat", status: "sent" },
];

/**
 * The hero's second panel: what one send() call actually produces. This is
 * the library's whole thesis rendered as the thing itself, not described in
 * prose, which is why it sits opposite the send() code sample.
 */
export function DeliveryLog() {
  return (
    <div className="panel">
      <div className="panel-head">delivery log</div>
      <div className="log-rows">
        {ROWS.map((row) => (
          <div className="log-row" key={row.channel}>
            <span className="chan">{row.channel}</span>
            <span className="via">{row.via}</span>
            <span className={`pill ${row.status}`}>{row.status}</span>
          </div>
        ))}
      </div>
      <div className="log-foot">
        <span>
          send() returned in{" "}
          <strong style={{ color: "var(--ink)", fontWeight: 600 }}>6&nbsp;ms</strong>
        </span>
        <span>providers ran after the response</span>
      </div>
    </div>
  );
}
