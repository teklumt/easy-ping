import { MongoClient } from "mongodb";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mongoSignals } from "../src/adapters/mongodb/signals";
import { type ListenNotifyLike, postgresSignals } from "../src/adapters/postgres/signals";
import { inboxChannel } from "../src/core/signals";
import { mongoReachable, TEST_MONGO_URL } from "./helpers/mongo";
import { postgresReachable, TEST_DATABASE_URL } from "./helpers/pg";
import { waitUntil } from "./helpers/wait";

const settle = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

/** A Postgres server in miniature: NOTIFY reaches every listener, including the sender's own. */
function fakePostgres() {
  const listeners = new Map<string, Set<(payload: string) => void>>();
  const notified: string[] = [];
  const sql: ListenNotifyLike = {
    async listen(channel, onNotify) {
      listeners.set(channel, (listeners.get(channel) ?? new Set()).add(onNotify));
      return {
        unlisten: async () => {
          listeners.get(channel)?.delete(onNotify);
        },
      };
    },
    async notify(channel, payload) {
      notified.push(payload);
      for (const listener of listeners.get(channel) ?? []) listener(payload);
    },
  };
  return { sql, notified, listenerCount: (channel: string) => listeners.get(channel)?.size ?? 0 };
}

describe("postgresSignals over a fake server", () => {
  it("wakes another process's subscriber once, and does not double-fire its own", async () => {
    const pg = fakePostgres();
    const here = postgresSignals(pg.sql);
    const there = postgresSignals(pg.sql);

    let hereHits = 0;
    let thereHits = 0;
    here.subscribe(inboxChannel("u1"), () => {
      hereHits += 1;
    });
    there.subscribe(inboxChannel("u1"), () => {
      thereHits += 1;
    });
    await waitUntil(() => pg.listenerCount("easy_ping") === 2);

    here.publish(inboxChannel("u1"));
    await waitUntil(() => thereHits === 1);
    await settle();

    expect(hereHits).toBe(1);
    expect(pg.notified).toHaveLength(1);
    expect(here.crossProcess).toBe(true);

    await here.close?.();
    await there.close?.();
    expect(pg.listenerCount("easy_ping")).toBe(0);
  });

  it("routes by logical channel and honours a custom Postgres channel", async () => {
    const pg = fakePostgres();
    const a = postgresSignals(pg.sql, { channel: "custom" });
    const b = postgresSignals(pg.sql, { channel: "custom" });
    const seen: string[] = [];
    b.subscribe(inboxChannel("u1"), () => seen.push("u1"));
    b.subscribe("deliveries", () => seen.push("deliveries"));
    await waitUntil(() => pg.listenerCount("custom") === 1);

    a.publish(inboxChannel("u2"));
    a.publish("deliveries");
    await waitUntil(() => seen.length === 1);
    await settle();
    expect(seen).toEqual(["deliveries"]);
  });
});

/** A change stream in miniature: every insert reaches every watcher, including the inserter's. */
function fakeMongo() {
  const watchers = new Set<(change: { fullDocument?: Record<string, unknown> }) => void>();
  const created: string[] = [];
  const inserted: unknown[] = [];
  const db = {
    async createCollection(name: string) {
      if (created.includes(name)) throw Object.assign(new Error("exists"), { code: 48 });
      created.push(name);
    },
    collection: () => ({
      async insertOne(doc: Record<string, unknown>) {
        inserted.push(doc);
        for (const watcher of watchers) watcher({ fullDocument: doc });
      },
      watch: () => {
        const handlers = new Set<(change: { fullDocument?: Record<string, unknown> }) => void>();
        const relay = (change: { fullDocument?: Record<string, unknown> }) => {
          for (const handler of handlers) handler(change);
        };
        watchers.add(relay);
        return {
          on: (event: string, handler: (arg: never) => void) => {
            if (event === "change") handlers.add(handler as never);
          },
          close: async () => {
            watchers.delete(relay);
          },
        };
      },
    }),
  };
  return { db, created, inserted, watcherCount: () => watchers.size };
}

describe("mongoSignals over a fake change stream", () => {
  it("creates the capped collection once and wakes only other processes", async () => {
    const mongo = fakeMongo();
    const here = mongoSignals(mongo.db as never);
    const there = mongoSignals(mongo.db as never);
    let hereHits = 0;
    let thereHits = 0;
    here.subscribe("deliveries", () => {
      hereHits += 1;
    });
    there.subscribe("deliveries", () => {
      thereHits += 1;
    });
    await waitUntil(() => mongo.watcherCount() === 2);

    here.publish("deliveries");
    await waitUntil(() => thereHits === 1);
    await settle();

    expect(hereHits).toBe(1);
    expect(mongo.created).toEqual(["easy_ping_signals"]);
    expect(mongo.inserted).toHaveLength(1);

    await here.close?.();
    await there.close?.();
    expect(mongo.watcherCount()).toBe(0);
  });
});

const pgAvailable = await postgresReachable();

describe.skipIf(!pgAvailable)("postgresSignals against Postgres", () => {
  let a: ReturnType<typeof postgres>;
  let b: ReturnType<typeof postgres>;

  beforeAll(() => {
    a = postgres(TEST_DATABASE_URL, { max: 2, onnotice: () => {} });
    b = postgres(TEST_DATABASE_URL, { max: 2, onnotice: () => {} });
  });

  afterAll(async () => {
    await Promise.all([a.end(), b.end()]);
  });

  it("delivers a publish on one connection to a subscriber on another", async () => {
    const here = postgresSignals(a, { channel: "easy_ping_test" });
    const there = postgresSignals(b, { channel: "easy_ping_test" });
    let hits = 0;
    there.subscribe(inboxChannel("u1"), () => {
      hits += 1;
    });
    await settle(200);

    here.publish(inboxChannel("u1"));
    await waitUntil(() => hits === 1, { timeout: 3_000 });

    await here.close?.();
    await there.close?.();
  });
});

const mongoAvailable = await mongoReachable();

describe.skipIf(!mongoAvailable)("mongoSignals against MongoDB", () => {
  let client: MongoClient;

  beforeAll(async () => {
    client = new MongoClient(TEST_MONGO_URL);
    await client.connect();
    await client.db("easyping_signals_test").dropDatabase();
  });

  afterAll(async () => {
    await client.close();
  });

  it("delivers a publish from one instance to a subscriber on another", async () => {
    const db = client.db("easyping_signals_test");
    const here = mongoSignals(db);
    const there = mongoSignals(db);
    let hits = 0;
    there.subscribe(inboxChannel("u1"), () => {
      hits += 1;
    });
    await settle(300);

    here.publish(inboxChannel("u1"));
    await waitUntil(() => hits === 1, { timeout: 5_000 });

    await here.close?.();
    await there.close?.();
  });
});
