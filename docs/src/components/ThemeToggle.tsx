type Props = {
  /** null until the client has read the stored choice; renders as light. */
  theme: "light" | "dark" | null;
  onToggle: () => void;
};

/**
 * Sun and moon stacked in one 36px button; the one for the theme you would
 * switch to is visible, the other is rotated away. Both are always in the DOM,
 * so the swap is a transform transition, not a repaint.
 */
export function ThemeToggle({ theme, onToggle }: Props) {
  const dark = theme === "dark";
  return (
    <button
      type="button"
      className="theme-toggle"
      data-theme={dark ? "dark" : "light"}
      aria-label={dark ? "Switch to light theme" : "Switch to dark theme"}
      title={dark ? "Light theme" : "Dark theme"}
      onClick={onToggle}
    >
      <svg className="theme-icon sun" viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="4.2" />
        <path d="M12 2.5v2.4M12 19.1v2.4M2.5 12h2.4M19.1 12h2.4M5.3 5.3l1.7 1.7M17 17l1.7 1.7M5.3 18.7 7 17M17 7l1.7-1.7" />
      </svg>
      <svg className="theme-icon moon" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M20.5 14.2A8.5 8.5 0 0 1 9.8 3.5a8.5 8.5 0 1 0 10.7 10.7z" />
      </svg>
    </button>
  );
}
