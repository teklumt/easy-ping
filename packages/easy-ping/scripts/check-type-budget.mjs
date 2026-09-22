import { execSync } from "node:child_process";

/**
 * Two gates, not one.
 *
 * Drizzle's pgTable inference costs ~11.4k instantiations on its own — about
 * half the total — and that cost is intentional: it is what gives consumers
 * typed tables. But a single number dominated by a fixed third-party cost
 * cannot detect what this check was built for, which is a plugin-type
 * regression (RFC 0004 §3). A 2k blowup in plugin composition is noise against
 * 23k, and obvious against 12k.
 *
 * So `core` excludes the adapters and holds a tight line, while `full` keeps a
 * loose ceiling on the whole program.
 */
const GATES = [
  {
    name: "core",
    project: "tsconfig.core.json",
    ceiling: Number(process.env.TYPE_BUDGET_CORE ?? 8_000),
  },
  // Raised from 32k when the plugin store landed (30.2k), and from 38k when
  // the security regression suite landed (40.3k; the test file alone is
  // ~2.5k). Dominated by Drizzle's pgTable inference, so it moves with surface
  // area rather than with the plugin-type risk that `core` actually guards.
  { name: "full", project: "tsconfig.json", ceiling: Number(process.env.TYPE_BUDGET ?? 42_000) },
];

let failed = false;

for (const gate of GATES) {
  let output;
  try {
    output = execSync(`tsc --noEmit --extendedDiagnostics --project ${gate.project}`, {
      encoding: "utf8",
      stdio: "pipe",
    });
  } catch (error) {
    process.stdout.write(error.stdout ?? "");
    process.stderr.write(error.stderr ?? "");
    console.error(`typecheck failed for ${gate.project}; type budget not evaluated`);
    process.exit(1);
  }

  const match = output.match(/Instantiations:\s+(\d+)/);
  if (!match?.[1]) {
    console.error(`could not read instantiation count for ${gate.project}`);
    process.exit(1);
  }

  const count = Number(match[1]);
  const percent = Math.round((count / gate.ceiling) * 100);
  const status = count > gate.ceiling ? "OVER" : "ok";

  console.log(
    `${gate.name.padEnd(5)} ${count.toLocaleString().padStart(7)} / ${gate.ceiling.toLocaleString()} (${percent}%) ${status}`,
  );

  if (count > gate.ceiling) failed = true;
}

if (failed) {
  console.error(
    "\nType budget exceeded.\n" +
      "  core over  -> look for a recursive fold over the plugin tuple (RFC 0004 §3)\n" +
      "               or Drizzle types leaking into a boundary that does not need them.\n" +
      "  full over  -> usually a new adapter or provider; raise deliberately.\n" +
      "Raising a ceiling on purpose is fine. Drifting past one is not.",
  );
  process.exit(1);
}
