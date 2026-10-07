import { useCopy } from "../lib/clipboard";
import { API_CONTEXT, PROMPTS } from "../lib/prompts";

const CARD_COPY: Record<string, string> = {
  setup: "Install, schema, config, route mount and the bell, in order, with the gotchas.",
  push: "VAPID keys, the service worker, device registration and the browser half.",
  mongo: "What changes, what doesn't, and why it wants a replica set.",
  plugin: "Hooks, the scoped store, and adding a channel the core doesn't carry.",
};

/**
 * A link, not a copy button. These used to copy their own absolute URL, which
 * on localhost meant handing someone "http://localhost:17173/llms.txt", a
 * link only their own machine can open. Opening the file is what people
 * actually want: read it, or paste the address bar somewhere useful.
 */
function Chip({ href, label }: { href: string; label: string }) {
  return (
    <a className="chip" href={href} target="_blank" rel="noreferrer">
      {label}
    </a>
  );
}

function PromptCard({ id }: { id: keyof typeof PROMPTS }) {
  const { copied, copy } = useCopy();
  const prompt = PROMPTS[id];
  if (!prompt) return null;

  return (
    <button
      type="button"
      className="prompt-card"
      data-done={copied}
      onClick={() => copy(prompt.text)}
    >
      <span className="task">{prompt.label}</span>
      <p className="what">{CARD_COPY[id]}</p>
      <span className="act">{copied ? "Copied" : "Copy prompt"}</span>
    </button>
  );
}

/**
 * The reason this section exists: every current model's training cutoff
 * predates this library, so a cold request produces a fluent, wrong API.
 * Each button copies real, working prompt text (see src/lib/prompts.ts),
 * nothing here is a mockup.
 */
export function PromptSection() {
  const { copied, copy } = useCopy();

  return (
    <div className="ai">
      <div className="ai-top">
        <div className="ai-say">
          <p className="eyebrow" style={{ marginBottom: 14 }}>
            Built for how you actually work
          </p>
          <h2>Your AI doesn't know this library yet.</h2>
          <p>
            easy-ping shipped after every current model's training cutoff. Ask Cursor or Claude to
            wire it up cold and you'll get a confident, fluent, completely invented API.
          </p>
          <p>
            So we ship the context. Grab a prompt below, paste it in, and your assistant writes
            against the real surface instead of guessing at it.
          </p>
          <div className="ai-links">
            <Chip href="/llms.txt" label="llms.txt" />
            <Chip href="/llms-full.txt" label="llms-full.txt" />
            <button
              type="button"
              className="chip"
              data-done={copied}
              onClick={() => copy(API_CONTEXT)}
            >
              {copied ? "Copied" : "Copy full API context"}
            </button>
          </div>
        </div>

        <div className="ai-demo">
          <span className="caret">without the context</span>
          <div className="ai-bubble">
            <span className="bad">notify.createNotification({"{ … }"})</span>
            <br />
            <span className="dim">{"// plausible. fluent. does not exist."}</span>
          </div>
          <span className="caret" style={{ marginTop: 6 }}>
            with it
          </span>
          <div className="ai-bubble">
            <span className="ok">await notify.send("commentReply", {"{ to, payload }"})</span>
            <br />
            <span className="dim">{"// typed against your own definition"}</span>
          </div>
        </div>
      </div>

      <div className="ai-grid">
        <PromptCard id="setup" />
        <PromptCard id="push" />
        <PromptCard id="telegram" />
        <PromptCard id="reactNative" />
        <PromptCard id="mongo" />
        <PromptCard id="plugin" />
      </div>
    </div>
  );
}
