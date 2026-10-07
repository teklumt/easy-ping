import { useEffect } from "react";
import { applyHead, captureHead, type HeadMeta } from "../lib/head";

/**
 * Per-page <head>. Rendered once per route: during prerendering the tags are
 * captured and written into the static HTML; in the browser they are applied
 * to the live document on every navigation. No dependency, no context.
 */
export function Head(meta: HeadMeta) {
  captureHead(meta);
  const key = JSON.stringify(meta);
  // key covers every field; the object identity changes each render.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional
  useEffect(() => {
    applyHead(meta);
  }, [key]);
  return null;
}
