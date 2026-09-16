import { afterAll, beforeAll, describe, it } from "vitest";
import { adapterConformanceCases } from "../../src/testing/conformance";
import { availableBackends, type Backend, type BackendFactory } from "../helpers/backends";

let db: Backend;

describe.each(availableBackends.map((b) => [b.name, b] as const))(
  "adapter conformance (%s)",
  (name, backend: BackendFactory) => {
    beforeAll(async () => {
      db = await backend.create(`conformance_${name}`);
    });

    afterAll(async () => {
      await db.end();
    });

    // A case that needs a row lock has nothing to prove where a claim is a
    // single atomic update, so it is left out rather than faked into passing.
    const cases = adapterConformanceCases.filter(
      (testCase) => testCase.requires !== "rowLock" || backend.rowLock,
    );

    it.each(cases.map((c) => [c.name, c] as const))("%s", async (_name, testCase) => {
      await db.truncate();
      await testCase.run({
        adapter: db.adapter,
        reset: db.truncate,
        setAttempts: db.setAttempts,
        ...(db.lockRow ? { lockRow: db.lockRow } : {}),
      });
    });
  },
);
