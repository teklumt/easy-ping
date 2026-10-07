import { useEffect, useState } from "react";

type Entry = { id: string; label: string };

/**
 * The "on this page" rail. Tracks scroll with an IntersectionObserver rather
 * than a scroll listener — cheaper, and it naturally handles headings of
 * varying height instead of guessing offsets.
 */
export function Toc({ items }: { items: readonly Entry[] }) {
  const [activeId, setActiveId] = useState<string | null>(items[0]?.id ?? null);

  useEffect(() => {
    if (items.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setActiveId(entry.target.id);
            break;
          }
        }
      },
      { rootMargin: "-80px 0px -70% 0px" },
    );

    const elements = items
      .map((item) => document.getElementById(item.id))
      .filter((el): el is HTMLElement => el !== null);

    for (const el of elements) observer.observe(el);
    return () => observer.disconnect();
  }, [items]);

  if (items.length === 0) return null;

  return (
    <aside className="toc">
      <h4>On this page</h4>
      {items.map((item) => (
        <a key={item.id} href={`#${item.id}`} className={item.id === activeId ? "active" : ""}>
          {item.label}
        </a>
      ))}
    </aside>
  );
}
