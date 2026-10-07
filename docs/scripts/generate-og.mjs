// Renders public/og.png (1200x630), the image behind every social preview.
//
// Run by hand (`pnpm og`) and committed: it rasterises with the fonts on the
// machine that runs it, and the deploy host has none.

import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";
import { CURRENT_VERSION } from "../src/lib/releases.ts";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const sans = "Segoe UI, Inter, Helvetica, Arial, sans-serif";
const mono = "Cascadia Mono, Consolas, Menlo, monospace";

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#12161f"/>
      <stop offset="1" stop-color="#1f2634"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.85" cy="0.1" r="0.6">
      <stop offset="0" stop-color="#ff6152" stop-opacity="0.35"/>
      <stop offset="1" stop-color="#ff6152" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="1200" height="630" fill="url(#bg)"/>
  <rect width="1200" height="630" fill="url(#glow)"/>
  <g fill="none" stroke="#d7dde8" stroke-opacity="0.07">
    ${[120, 240, 360, 480, 600, 720, 840, 960, 1080].map((x) => `<path d="M${x} 0V630"/>`).join("")}
    ${[126, 252, 378, 504].map((y) => `<path d="M0 ${y}H1200"/>`).join("")}
  </g>
  <g transform="translate(96 96)">
    <circle cx="30" cy="30" r="30" fill="#ff6152"/>
    <path d="M30 13a10 10 0 0 0-10 10v7l-5 7h30l-5-7v-7a10 10 0 0 0-10-10zm-5 27a5 5 0 0 0 10 0z" fill="#12161f"/>
    <text x="80" y="41" font-family="${mono}" font-size="40" font-weight="700" fill="#ffffff">easy-ping</text>
    <text x="300" y="41" font-family="${mono}" font-size="20" fill="#ff8a7a">v${CURRENT_VERSION}</text>
  </g>
  <text x="96" y="290" font-family="${sans}" font-size="60" font-weight="700" fill="#ffffff" letter-spacing="-1">Self-hosted notifications</text>
  <text x="96" y="360" font-family="${sans}" font-size="60" font-weight="700" fill="#ffffff" letter-spacing="-1">for TypeScript.</text>
  <text x="96" y="420" font-family="${sans}" font-size="27" fill="#c8d0dc">In-app inbox, email, web push, mobile push and Telegram. Your database.</text>
  <rect x="96" y="470" width="1008" height="78" rx="14" fill="#0b0e14" stroke="#d7dde8" stroke-opacity="0.14"/>
  <text x="124" y="518" font-family="${mono}" font-size="24" fill="#d7dde8"><tspan fill="#ff8a7a">await</tspan> notify.send(<tspan fill="#9ecbff">"commentReply"</tspan>, { to: userId, payload });</text>
  <text x="1104" y="590" text-anchor="end" font-family="${sans}" font-size="20" fill="#8b93a7">Postgres · MySQL · SQLite · MongoDB · MIT · npm</text>
</svg>`;

const png = new Resvg(svg, {
  fitTo: { mode: "width", value: 1200 },
  font: { loadSystemFonts: true, defaultFontFamily: "Segoe UI" },
})
  .render()
  .asPng();

await writeFile(join(root, "public", "og.png"), png);
console.log(`wrote public/og.png (${(png.length / 1024).toFixed(0)} KB)`);
