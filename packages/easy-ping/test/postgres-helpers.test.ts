import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPostgresTables, pgTransaction } from "../src/adapters/postgres";
import { pushSchema } from "../src/plugins/push";
import { createTestDatabase, postgresReachable, type TestDatabase } from "./helpers/pg";

// The two helpers every integration was hand-writing.

let db: TestDatabase;
const available = await postgresReachable();

describe("pgTransaction", () => {
  type Call = string;

  /** A pool that records the statements a real one would have run. */
  function stubPool(behaviour: { failOn?: string } = {}) {
    const calls: Call[] = [];
    let released = 0;

    const pool = {
      connect: async () => ({
        query: async (text: string) => {
          calls.push(text);
          if (behaviour.failOn && text.includes(behaviour.failOn)) {
            throw new Error("statement blew up");
          }
          return { rows: [{ ok: true }] };
        },
        release: () => {
          released += 1;
        },
      }),
    };

    return { pool, calls, released: () => released };
  }

  it("wraps the callback in BEGIN and COMMIT", async () => {
    const { pool, calls } = stubPool();

    const result = await pgTransaction(pool)(async (query) => {
      await query("SELECT 1", []);
      return "value";
    });

    expect(result).toBe("value");
    expect(calls).toEqual(["BEGIN", "SELECT 1", "COMMIT"]);
  });

  it("rolls back and rethrows when the callback throws", async () => {
    const { pool, calls } = stubPool();

    await expect(
      pgTransaction(pool)(async () => {
        throw new Error("application error");
      }),
    ).rejects.toThrow("application error");

    expect(calls).toEqual(["BEGIN", "ROLLBACK"]);
  });

  it("releases the client on every path", async () => {
    // A dropped release leaks a connection per send; it only shows under load.
    const ok = stubPool();
    await pgTransaction(ok.pool)(async () => "fine");
    expect(ok.released()).toBe(1);

    const bad = stubPool({ failOn: "SELECT" });
    await expect(
      pgTransaction(bad.pool)(async (query) => query("SELECT boom", [])),
    ).rejects.toThrow();
    expect(bad.released()).toBe(1);
  });
});

describe.skipIf(!available)("createPostgresTables", () => {
  beforeAll(async () => {
    db = await createTestDatabase("pg_helpers");
  });

  afterAll(async () => {
    await db.end();
  });

  beforeEach(async () => {
    await db.truncate();
  });

  const query = async (text: string, params: readonly unknown[]) =>
    (await db.client.unsafe(text, [...params] as never[])) as unknown as Record<string, unknown>[];

  const tableNames = async () => {
    const rows = await db.client.unsafe(
      "select table_name from information_schema.tables where table_schema = current_schema()",
    );
    return (rows as unknown as { table_name: string }[]).map((r) => r.table_name).sort();
  };

  it("creates the core tables and is safe to re-run", async () => {
    const first = await createPostgresTables(query);
    expect(first).toBeGreaterThan(0);

    const tables = await tableNames();
    expect(tables).toContain("notification");
    expect(tables).toContain("notification_delivery");

    // Every statement is IF NOT EXISTS, so booting twice must not throw.
    await expect(createPostgresTables(query)).resolves.toBeGreaterThan(0);
  });

  it("creates plugin tables from the schema the plugin exports", async () => {
    // pushSchema is a standalone value precisely so this needs no provider
    // and no render function invented just to read a column list.
    await createPostgresTables(query, { plugins: [pushSchema] });

    expect(await tableNames()).toContain("notification_push_device");
  });
});
