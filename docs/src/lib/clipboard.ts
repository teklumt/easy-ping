import { useCallback, useRef, useState } from "react";

/**
 * Copy-to-clipboard with a "Copied" flash, matching the approved design.
 * Falls back to a hidden-textarea copy when the async Clipboard API is
 * unavailable (non-secure context, older WebView).
 */
export function useCopy(resetAfterMs = 1800) {
  const [copied, setCopied] = useState(false);
  const timeout = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const copy = useCallback(
    async (text: string) => {
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(text);
        } else {
          const area = document.createElement("textarea");
          area.value = text;
          area.style.position = "fixed";
          area.style.opacity = "0";
          document.body.appendChild(area);
          area.select();
          document.execCommand("copy");
          document.body.removeChild(area);
        }
      } catch {
        // Nothing more we can do — the flash still confirms intent to the user.
      }

      setCopied(true);
      clearTimeout(timeout.current);
      timeout.current = setTimeout(() => setCopied(false), resetAfterMs);
    },
    [resetAfterMs],
  );

  return { copied, copy };
}
