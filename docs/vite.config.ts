import mdx from "@mdx-js/rollup";
import react from "@vitejs/plugin-react";
import remarkGfm from "remark-gfm";
import { defineConfig } from "vite";

// MDX before React: Vite runs plugins in order, and the .mdx -> JSX transform
// has to happen before @vitejs/plugin-react's fast-refresh wrapper sees it.
// remark-gfm is what makes pipe tables (used throughout the docs content)
// parse at all — plain CommonMark markdown has no table syntax.
//
// Heading anchors use a literal `<a id="..." />` right in the heading text
// (see content authoring in the README) rather than a `{#id}` convention:
// MDX parses every `{...}` in the document as a JS expression, including
// inside headings, so a bare `{#id}` fails to compile as JSX.
export default defineConfig({
  plugins: [{ enforce: "pre", ...mdx({ remarkPlugins: [remarkGfm] }) }, react()],

  // Deliberately above 15000, not Vite's 5173 default.
  //
  // On Windows, Hyper-V/Docker reserve blocks of TCP ports out of the system
  // "dynamic port range" and reshuffle them on every reboot. Binding inside a
  // reserved block fails with `EACCES: permission denied` — which reads like a
  // filesystem error but means the OS owns that port. Vite only retries past
  // EADDRINUSE, never EACCES, so it cannot recover on its own.
  //
  // Check the range with: netsh int ipv4 show dynamicport tcp
  // On a machine where it starts at 1024, every common dev port (3000, 5173,
  // 8080…) is fair game for reservation; anything above the range's end never
  // is. See "Why the port is pinned" in the README.
  server: { port: 17173 },
  preview: { port: 17174 },

  // The monorepo overrides esbuild to >=0.28, which can no longer lower syntax
  // to Vite 6's default targets (safari14 and friends). These are Vite 7's defaults.
  build: { target: ["chrome107", "edge107", "firefox104", "safari16"] },
});
