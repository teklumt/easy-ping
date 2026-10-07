import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { CURRENT_VERSION } from "../lib/releases";
import { Logo } from "./Logo";
import { MobileMenu } from "./MobileMenu";
import { SupportDialog } from "./SupportDialog";
import { ThemeToggle } from "./ThemeToggle";

const REPO = "https://github.com/teklumt/easy-ping";
const VERSION = `v${CURRENT_VERSION}`;

type Theme = "light" | "dark";

/**
 * localStorage throws outright when site data is blocked, and a throw in a
 * render path takes the whole app down with it — so every access is guarded.
 */
function readStoredTheme(): Theme | null {
  try {
    const saved = window.localStorage.getItem("theme");
    return saved === "dark" || saved === "light" ? saved : null;
  } catch {
    return null;
  }
}

const COLOR_SCHEME_QUERY = "(prefers-color-scheme: dark)";

const systemTheme = (): Theme =>
  typeof window.matchMedia === "function" && window.matchMedia(COLOR_SCHEME_QUERY).matches
    ? "dark"
    : "light";

/**
 * Sticky top chrome, present on every route. `top: 0` here (not
 * `env(safe-area-inset-top, ...)`) is deliberate — this is a normal desktop
 * site, not an installed app, so there is no system status bar to clear.
 */
export function TopBar() {
  const onDocs = useLocation().pathname.startsWith("/docs");

  // Resolved after mount: the markup is prerendered, so the first render must
  // not read the browser. index.html stamps the attribute before first paint;
  // this only keeps the toggle's label in step with it.
  const [theme, setTheme] = useState<Theme | null>(null);

  useEffect(() => {
    setTheme(readStoredTheme() ?? systemTheme());
  }, []);

  useEffect(() => {
    if (theme) document.documentElement.dataset.theme = theme;
  }, [theme]);

  // With no explicit choice stored, keep following the OS if it changes while
  // the page is open.
  useEffect(() => {
    if (readStoredTheme()) return;

    const query = window.matchMedia?.(COLOR_SCHEME_QUERY);
    if (!query) return;

    const follow = (event: MediaQueryListEvent) => setTheme(event.matches ? "dark" : "light");
    query.addEventListener("change", follow);
    return () => query.removeEventListener("change", follow);
  }, []);

  function toggleTheme() {
    const next: Theme = theme === "dark" ? "light" : "dark";
    try {
      window.localStorage.setItem("theme", next);
    } catch {
      // The choice still applies to this page view; it just won't persist.
    }
    setTheme(next);
  }

  return (
    <header className="topbar">
      <Link to="/" className="brand">
        <Logo />
        easy-ping
      </Link>
      <Link className="ver" to="/docs/changelog" title="Changelog">
        {VERSION}
      </Link>
      <nav className="nav-top" aria-label="Main">
        <Link to="/docs/introduction" className={onDocs ? "active" : ""}>
          Docs
        </Link>
      </nav>
      <ThemeToggle theme={theme} onToggle={toggleTheme} />
      {/* Hidden below 760px; Support and GitHub move into the drawer. */}
      <div className="topbar-actions">
        <SupportDialog />
        <a className="ghost" href={REPO} target="_blank" rel="noreferrer">
          GitHub
        </a>
      </div>
      <MobileMenu repo={REPO} />
    </header>
  );
}
