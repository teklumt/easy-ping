import postgres from "postgres";
import { afterAll, beforeAll, describe, it } from "vitest";
import { adapterConformanceCases } from "../../src/testing/conformance";
import {
  createTestDatabase,
  postgresReachable,
  TEST_DATABASE_URL,
  type TestDatabase,
} from "../helpers/pg";

let db: TestDatabase;

const available = await postgresReachable();

describe.skipIf(!available)("drizzle postgres adapter", () => {
  beforeAll(async () => {
    db = await createTestDatabase("adapter");
  });

  afterAll(async () => {
    await db.end();
  });

  it.each(adapterConformanceCases.map((c) => [c.name, c] as const))(
    "%s",
    async (_name, testCase) => {
      await db.truncate();
      await testCase.run({
        adapter: db.adapter,
        reset: db.truncate,
        exec: async (statement) => {
          await db.client.unsafe(statement);
        },
        lockRow: async (deliveryId, fn) => {
          const holder = postgres(TEST_DATABASE_URL, {
            max: 1,
            onnotice: () => {},
            connection: { search_path: "test_adapter" },
          });
          try {
            await holder.begin(async (tx) => {
              await tx`SELECT id FROM notification_delivery WHERE id = ${deliveryId} FOR UPDATE`;
              await fn();
            });
          } finally {
            await holder.end();
          }
        },
      });
    },
  );
});

if (!available) {
  console.warn(
    `\n[easy-notify] Postgres not reachable at ${URL} — adapter conformance suite skipped.\n` +
      "Run `docker compose up -d` from the repo root to exercise it.\n",
  );
}
