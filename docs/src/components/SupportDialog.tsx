import { useEffect, useRef } from "react";

const EMAIL = "teklumo.jembere@gmail.com";
const TELEGRAM = "tsemadre";
const SUBJECT = "easy-ping";

/**
 * Contact options, in a native <dialog>.
 *
 * `showModal()` gives Escape-to-close, focus containment and an inert
 * background for free, all things a hand-rolled div modal has to
 * reimplement, usually incompletely.
 */
export function SupportDialog() {
  const ref = useRef<HTMLDialogElement>(null);

  // Click-outside-to-close, bound natively rather than via a JSX onClick: a
  // click that lands on the dialog element itself is a click on its backdrop,
  // while anything inside the panel hits a child instead. Escape is already
  // handled by showModal(), so no keyboard equivalent is needed here.
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;

    const closeOnBackdrop = (event: MouseEvent) => {
      if (event.target === dialog) dialog.close();
    };

    dialog.addEventListener("click", closeOnBackdrop);
    return () => dialog.removeEventListener("click", closeOnBackdrop);
  }, []);

  return (
    <>
      <button type="button" className="support-trigger" onClick={() => ref.current?.showModal()}>
        Support
      </button>

      <dialog ref={ref} className="support" aria-labelledby="support-title">
        <div className="support-inner">
          <div className="support-head">
            <h2 id="support-title">Get in touch</h2>
            <button
              type="button"
              className="support-close"
              aria-label="Close"
              onClick={() => ref.current?.close()}
            >
              ✕
            </button>
          </div>

          <p className="support-lede">
            Questions, bug reports, or anything about easy-ping. Either of these reaches me.
          </p>

          <a
            className="support-row"
            href={`mailto:${EMAIL}?subject=${encodeURIComponent(SUBJECT)}`}
          >
            <span className="support-kind">Email</span>
            <span className="support-value">{EMAIL}</span>
          </a>

          <a
            className="support-row"
            href={`https://t.me/${TELEGRAM}`}
            target="_blank"
            rel="noreferrer"
          >
            <span className="support-kind">Telegram</span>
            <span className="support-value">@{TELEGRAM}</span>
          </a>

          <p className="support-foot">
            For anything others would benefit from, a{" "}
            <a href="https://github.com/teklumt/easy-ping/issues" target="_blank" rel="noreferrer">
              GitHub issue
            </a>{" "}
            is better than a DM, because it's searchable.
          </p>
        </div>
      </dialog>
    </>
  );
}
