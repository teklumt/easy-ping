// The readme and license live at the monorepo root, but npm only picks those
// up from the package directory — publishing without this gives the package a
// blank page on npmjs.com and ships no license text.
//
// Runs on prepack, so `pnpm publish` gets them without anyone remembering.

import { copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkg = dirname(dirname(fileURLToPath(import.meta.url)));
const root = join(pkg, "..", "..");

for (const [from, to] of [
  ["readme.md", "README.md"],
  ["LICENSE", "LICENSE"],
]) {
  copyFileSync(join(root, from), join(pkg, to));
  console.log(`copied ${from} -> ${to}`);
}
