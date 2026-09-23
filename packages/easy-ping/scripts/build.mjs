// Cleans dist/ and runs tsup with a heap large enough for the .d.ts build.
//
// tsup builds the declarations for all 20 entry points in one worker thread,
// which outgrew the default heap on the CI runner at 0.7.0
// (ERR_WORKER_OUT_OF_MEMORY). The flag has to be set here, on the process
// that spawns tsup: Turbo runs tasks in strict env mode and drops a
// NODE_OPTIONS set in the workflow before the script ever sees it.
// EASY_PING_BUILD_HEAP_MB exists so the failure can be reproduced on purpose.

import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";

rmSync("dist", { recursive: true, force: true });

const heapMb = Number(process.env.EASY_PING_BUILD_HEAP_MB ?? 4096);
const nodeOptions = `${process.env.NODE_OPTIONS ?? ""} --max-old-space-size=${heapMb}`.trim();

const result = spawnSync("pnpm", ["exec", "tsup"], {
  stdio: "inherit",
  shell: true,
  env: { ...process.env, NODE_OPTIONS: nodeOptions },
});

process.exit(result.status ?? 1);
