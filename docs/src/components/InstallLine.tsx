import { useCopy } from "../lib/clipboard";

export function InstallLine({ command }: { command: string }) {
  const { copied, copy } = useCopy();

  return (
    <div className="install">
      <span className="prompt">$</span>
      <span>{command}</span>
      <button type="button" className="copy" data-done={copied} onClick={() => copy(command)}>
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
