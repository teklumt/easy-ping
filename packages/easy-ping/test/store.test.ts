import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ConfigError } from "../src/core/errors";
import type { SchemaDeclaration } from "../src/core/plugin";
import { createPluginStore, type PluginStore } from "../src/core/store";
import { availableBackends, type Backend, type BackendFactory } from "./helpers/backends";

const TABLE = "digest_bucket";

const schema = {
  digestBucket: {
    tableName: TABLE,
    fields: {
      id: { type: "string", required: true },
      userId: { type: "string", required: true },
      window: { type: "string", required: true },
      itemCount: { type: "number", required: true },
      active: { type: "boolean", required: true },
      payload: { type: "json" },
      sendAfter: { type: "date" },
    },
    primaryKey: ["id"],
  },
} satisfies SchemaDeclaration;

let db: Backend;
let store: PluginStore;

const row = (id: string, over: Partial<Record<string, unknown>> = {}) => ({
  id,
  userId: "u1",
  window: "daily",
  itemCount: 1,
  active: true,
  ...over,
});

// The dialects diverge here, so the contract runs against every backend.
describe.each(availableBackends.map((b) => [b.name, b] as const))(
  "plugin store (%s)",
  (name, backend: BackendFactory) => {
    beforeAll(async () => {
      db = await backend.create(`store_${name}`);
      await db.applySchema(schema);
      store = createPluginStore("digests", schema, db.adapter, "");
    });

    afterAll(async () => {
      await db.end();
    });

    beforeEach(async () => {
      await db.truncate();
    });

    describe("scoping", () => {
      it("refuses a table the plugin does not declare", async () => {
        // Without this a plugin could read every user's notifications.
        await expect(store.find("notification")).rejects.toBeInstanceOf(ConfigError);
      });

      it("refuses an unknown field in a where clause", async () => {
        await expect(store.find(TABLE, { nope: "x" })).rejects.toThrow(/unknown field "nope"/);
      });

      it("refuses an unknown field on insert", async () => {
        await expect(store.insert(TABLE, [{ id: "a", bogus: 1 }])).rejects.toThrow(/bogus/);
      });

      it("refuses filtering on a json column", async () => {
        // A bare object value cannot be told apart from an operator.
        await expect(store.find(TABLE, { payload: "x" })).rejects.toThrow(/json field/);
      });
    });

    describe("round trip", () => {
      it("maps snake_case columns back to the declared field names", async () => {
        await store.insert(TABLE, [row("a", { itemCount: 7 })]);
        const [found] = await store.find<{ userId: string; itemCount: number }>(TABLE);

        // SELECT * yields user_id / item_count; typing them as camelCase without
        // mapping makes every property undefined at runtime.
        expect(found?.userId).toBe("u1");
        expect(found?.itemCount).toBe(7);
      });

      it("upserts on conflict rather than throwing", async () => {
        await store.upsert(TABLE, [row("a", { itemCount: 1 })], { onConflict: ["id"] });
        await store.upsert(TABLE, [row("a", { itemCount: 9 })], { onConflict: ["id"] });

        const rows = await store.find<{ itemCount: number }>(TABLE);
        expect(rows).toHaveLength(1);
        expect(rows[0]?.itemCount).toBe(9);
      });

      it("round-trips a json column", async () => {
        // postgres-js cannot bind a plain object, so the store serialises json
        // fields on write. Getting this wrong fails the insert outright.
        const payload = { nested: { items: [1, 2, 3] }, flag: true };
        await store.insert(TABLE, [row("a", { payload })]);

        const [found] = await store.find<{ payload: typeof payload }>(TABLE);
        expect(found?.payload).toEqual(payload);
      });

      it("accepts a null json column", async () => {
        await store.insert(TABLE, [row("a", { payload: null })]);
        const [found] = await store.find<{ payload: unknown }>(TABLE);
        expect(found?.payload).toBeNull();
      });

      it("round-trips dates and booleans", async () => {
        const sendAfter = new Date("2026-03-01T09:00:00.000Z");
        await store.insert(TABLE, [row("a", { sendAfter, active: false })]);

        const [found] = await store.find<{ sendAfter: Date; active: boolean }>(TABLE);
        expect(found?.active).toBe(false);
        expect(new Date(found?.sendAfter ?? 0).toISOString()).toBe(sendAfter.toISOString());
      });
    });

    describe("operators", () => {
      beforeEach(async () => {
        await store.insert(TABLE, [
          row("a", { userId: "u1", itemCount: 1 }),
          row("b", { userId: "u2", itemCount: 5 }),
          row("c", { userId: "u3", itemCount: 9, window: "weekly" }),
        ]);
      });

      it("in", async () => {
        const rows = await store.find(TABLE, { userId: { in: ["u1", "u3"] } });
        expect(rows).toHaveLength(2);
      });

      it("an empty in matches nothing rather than everything", async () => {
        expect(await store.find(TABLE, { userId: { in: [] } })).toHaveLength(0);
      });

      it("comparison operators", async () => {
        expect(await store.find(TABLE, { itemCount: { lt: 5 } })).toHaveLength(1);
        expect(await store.find(TABLE, { itemCount: { lte: 5 } })).toHaveLength(2);
        expect(await store.find(TABLE, { itemCount: { gt: 5 } })).toHaveLength(1);
        expect(await store.find(TABLE, { itemCount: { gte: 5 } })).toHaveLength(2);
      });

      it("equality and not", async () => {
        expect(await store.find(TABLE, { window: "daily" })).toHaveLength(2);
        expect(await store.find(TABLE, { window: { not: "daily" } })).toHaveLength(1);
      });

      it("null and not-null", async () => {
        expect(await store.find(TABLE, { sendAfter: null })).toHaveLength(3);
        expect(await store.find(TABLE, { sendAfter: { not: null } })).toHaveLength(0);
      });

      it("combines conditions with AND", async () => {
        const rows = await store.find(TABLE, { window: "daily", itemCount: { gte: 5 } });
        expect(rows).toHaveLength(1);
      });

      it("orders and limits", async () => {
        const rows = await store.find<{ id: string }>(
          TABLE,
          {},
          { orderBy: { field: "itemCount", direction: "desc" }, limit: 2 },
        );
        expect(rows.map((r) => r.id)).toEqual(["c", "b"]);
      });
    });

    describe("mutation", () => {
      beforeEach(async () => {
        await store.insert(TABLE, [row("a"), row("b", { userId: "u2" })]);
      });

      it("updates matching rows and reports the count", async () => {
        const updated = await store.update(TABLE, { userId: "u1" }, { itemCount: 42 });
        expect(updated).toBe(1);

        const [found] = await store.find<{ itemCount: number }>(TABLE, { userId: "u1" });
        expect(found?.itemCount).toBe(42);
      });

      it("removes matching rows and reports the count", async () => {
        expect(await store.remove(TABLE, { userId: "u2" })).toBe(1);
        expect(await store.find(TABLE)).toHaveLength(1);
      });

      it("an unmatched where changes nothing", async () => {
        expect(await store.update(TABLE, { userId: "ghost" }, { itemCount: 1 })).toBe(0);
        expect(await store.remove(TABLE, { userId: "ghost" })).toBe(0);
      });
    });

    it("applies the configured table prefix", async () => {
      await store.insert(TABLE, [row("a")]);
      const prefixed = createPluginStore("digests", schema, db.adapter, "app_");

      // Postgres errors on a missing table, Mongo reads it as empty; either is fine, reading unprefixed rows is not.
      expect(await prefixed.find(TABLE).catch(() => [])).toHaveLength(0);
    });
  },
);
