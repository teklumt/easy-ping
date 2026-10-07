import type { ReactNode } from "react";
import { Children, isValidElement, useId, useState } from "react";

/**
 * Switches between sibling <CodeBlock bare> panes under one tab bar — the
 * Drizzle / Raw SQL / MongoDB choice on the quickstart page, for instance.
 * The active pane's own filename (if any) is intentionally not shown: the
 * tab label already says which path you're on.
 */
export function Tabs({ labels, children }: { labels: readonly string[]; children: ReactNode }) {
  const [active, setActive] = useState(0);
  const groupId = useId();
  const panes = Children.toArray(children).filter(isValidElement);

  return (
    <div className="panel">
      <div className="tabs" role="tablist">
        {labels.map((label, index) => (
          <button
            key={label}
            type="button"
            role="tab"
            id={`${groupId}-tab-${index}`}
            aria-selected={index === active}
            aria-controls={`${groupId}-panel-${index}`}
            onClick={() => setActive(index)}
          >
            {label}
          </button>
        ))}
      </div>
      {panes.map((pane, index) => (
        <div
          key={labels[index]}
          role="tabpanel"
          id={`${groupId}-panel-${index}`}
          aria-labelledby={`${groupId}-tab-${index}`}
          hidden={index !== active}
        >
          {pane}
        </div>
      ))}
    </div>
  );
}
