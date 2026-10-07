import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Link, useLocation } from "react-router-dom";
import { NavTree } from "./Sidebar";
import { SupportDialog } from "./SupportDialog";

type Props = { repo: string };

/**
 * Narrow screens: the top bar keeps the brand, the theme toggle and a
 * hamburger on the right. The drawer slides in from the left with the controls
 * the bar hides (Docs, Support, GitHub) and then the whole docs tree. Closes on backdrop tap,
 * the close button, Escape, or navigating. Renders closed on the server.
 */
export function MobileMenu({ repo }: Props) {
  const [open, setOpen] = useState(false);
  const { pathname } = useLocation();

  // Navigating anywhere closes it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: pathname is the trigger, not an input
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [open]);

  const close = () => setOpen(false);

  return (
    <>
      <button
        type="button"
        className="menu-toggle"
        aria-label="Open menu"
        aria-expanded={open}
        aria-controls="mobile-menu"
        onClick={() => setOpen(true)}
      >
        <span aria-hidden="true" />
        <span aria-hidden="true" />
        <span aria-hidden="true" />
      </button>

      {open &&
        createPortal(
          <div className="drawer-root">
            <button
              type="button"
              className="drawer-backdrop"
              aria-label="Close menu"
              onClick={close}
            />
            <aside
              id="mobile-menu"
              className="drawer"
              role="dialog"
              aria-modal="true"
              aria-label="Menu"
            >
              <div className="drawer-head">
                <span className="drawer-title">easy-ping</span>
                <button type="button" className="drawer-close" aria-label="Close" onClick={close}>
                  ✕
                </button>
              </div>

              <div className="drawer-actions">
                <Link to="/docs/introduction" className="drawer-action" onClick={close}>
                  Docs
                </Link>
                <SupportDialog />
                <a className="drawer-action" href={repo} target="_blank" rel="noreferrer">
                  GitHub
                </a>
              </div>

              <nav className="drawer-nav" aria-label="Documentation">
                <NavTree onNavigate={close} />
              </nav>
            </aside>
          </div>,
          // Outside the top bar: its backdrop-filter would otherwise clip a fixed drawer to 58px.
          document.body,
        )}
    </>
  );
}
