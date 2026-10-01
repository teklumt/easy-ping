import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type * as NodeSqlite from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { pgListenNotify } from "../src/adapters/postgres/signals";
import { sqliteQuery } from "../src/adapters/sqlite/helpers";
import type { NotificationDefinitions } from "../src/core/definition";
import { ConfigError } from "../src/core/errors";
import { easyPing } from "../src/core/instance";
import type { SchemaDeclaration } from "../src/core/plugin";
import { createRateLimiter } from "../src/core/rate-limit";
import { createPluginStore } from "../src/core/store";
import type { Recipient } from "../src/core/types";
import { toNodeHandler, toWebRequest } from "../src/node";
import { mobilePush, mobilePushSchema } from "../src/plugins/mobile-push";
import { telegram, telegramSchema } from "../src/plugins/telegram";
import { isExpoPushToken } from "../src/providers/expo-push";
import type { TelegramProvider } from "../src/providers/telegram";
import { encryptPayload, InvalidSubscriptionError } from "../src/providers/web-push/crypto";
import { planSqliteMigration } from "../src/schema/migrate-sqlite";
import { availableBackends, type Backend } from "./helpers/backends";

const BASE = "/api/notifications";
const definitions = { ping: { channels: ["inApp"] } } satisfies NotificationDefinitions;
const recipient = (userId: string): Recipient => ({ userId, timezone: "UTC", locale: "en" });
const quiet = { warn: () => {}, error: () => {} };

const sqlite = availableBackends.find((backend) => backend.name === "sqlite");
if (!sqlite) throw new Error("sqlite backend missing");
let db: Backend;

beforeAll(async () => {
  db = await sqlite.create("security-090");
  await db.applySchema(telegramSchema);
  await db.applySchema(mobilePushSchema);
});
afterAll(async () => {
  await db.end();
});

const get = (path: string, headers: Record<string, string> = {}) =>
  new Request(`https://app.dev${BASE}${path}`, { headers });
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`https://app.dev${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

describe("#1 React hook forwards scope and the injectables", () => {
  it("passes scope through to the client, so tabs of different users get different groups", async () => {
    vi.resetModules();
    const created: Record<string, unknown>[] = [];
    vi.doMock("react", () => ({
      useMemo: (fn: () => unknown) => fn(),
      useRef: (value: unknown) => ({ current: value }),
      useState: (init: () => unknown) => [init(), () => {}],
      useEffect: () => {},
      useCallback: (fn: unknown) => fn,
    }));
    vi.doMock("../src/client", async () => {
      const actual = await vi.importActual<typeof import("../src/client")>("../src/client");
      return {
        ...actual,
        createNotifyClient: (options: Record<string, unknown>) => {
          created.push(options);
          return actual.createNotifyClient({ ...options, transport: "poll", locks: null });
        },
      };
    });
    const { useNotifications } = await import("../src/react");
    const locks = { request: async () => {} };
    useNotifications({ scope: "alice", locks, now: () => 1 });
    expect(created[0]).toMatchObject({ scope: "alice", locks });
    expect(typeof created[0]?.now).toBe("function");
    vi.doUnmock("react");
    vi.doUnmock("../src/client");
  });
});

describe("#2 rate limiter", () => {
  it("throttles requests without proxy headers in one shared bucket instead of exempting them", () => {
    const limit = createRateLimiter({ max: 2, windowMs: 60_000 });
    const anonymous = () => new Request("https://app.dev/x");
    expect(limit(anonymous())).toBeNull();
    expect(limit(anonymous())).toBeNull();
    expect(limit(anonymous())?.status).toBe(429);
  });

  it("warns once when it falls back to the shared bucket", () => {
    let warnings = 0;
    const limit = createRateLimiter({
      max: 100,
      windowMs: 60_000,
      onUnkeyed: () => {
        warnings += 1;
      },
    });
    for (let i = 0; i < 5; i += 1) limit(new Request("https://app.dev/x"));
    limit(new Request("https://app.dev/x", { headers: { "x-real-ip": "1.2.3.4" } }));
    expect(warnings).toBe(1);
  });

  it("still exempts a request a custom key function returns null for", () => {
    const limit = createRateLimiter({ max: 1, windowMs: 60_000, key: () => null });
    for (let i = 0; i < 3; i += 1) expect(limit(new Request("https://app.dev/x"))).toBeNull();
  });

  it("bounds memory under spoofed keys by evicting the oldest bucket", () => {
    const limit = createRateLimiter({ max: 1, windowMs: 60_000, maxKeys: 3 });
    const from = (ip: string) => new Request("https://app.dev/x", { headers: { "x-real-ip": ip } });
    expect(limit(from("a"))).toBeNull();
    expect(limit(from("a"))?.status).toBe(429);
    for (const ip of ["b", "c", "d"]) limit(from(ip));
    expect(limit(from("a"))).toBeNull();
    expect(limit(from("d"))?.status).toBe(429);
  });
});

describe("#3 session ids", () => {
  const build = (getUserId: (request: Request) => unknown) =>
    easyPing({
      database: db.adapter,
      secret: "test-signing-secret-0123456789",
      cron: { secret: "cron-secret-0123456789" },
      session: { getUserId: getUserId as never },
      getRecipients: async (ids) => ids.map(recipient),
      notifications: definitions,
      channels: { inApp: { enabled: true } },
      logger: quiet,
    });

  it("treats an empty string or a non-string as unauthenticated", async () => {
    for (const value of ["", 0, {}, true]) {
      const response = await build(async () => value).handler.GET(get("/count"));
      expect(response.status).toBe(401);
    }
  });

  it('lets a user whose id is literally "error" in (the old sentinel collided)', async () => {
    const response = await build(async () => "error").handler.GET(get("/count"));
    expect(response.status).toBe(200);
  });

  it("still answers a throwing session lookup with 500", async () => {
    const response = await build(async () => {
      throw new Error("db down");
    }).handler.GET(get("/count"));
    expect(response.status).toBe(500);
  });
});

describe("#4 push token length", () => {
  it("bounds the Expo token pattern", () => {
    expect(isExpoPushToken(`ExponentPushToken[${"a".repeat(22)}]`)).toBe(true);
    expect(isExpoPushToken(`ExponentPushToken[${"a".repeat(64)}]`)).toBe(true);
    expect(isExpoPushToken(`ExponentPushToken[${"a".repeat(65)}]`)).toBe(false);
  });

  it("the registry rejects an oversized token whatever the provider accepts", async () => {
    const notify = easyPing({
      database: db.adapter,
      secret: "test-signing-secret-0123456789",
      cron: { secret: "cron-secret-0123456789" },
      session: { getUserId: async () => "u1" },
      getRecipients: async (ids) => ids.map(recipient),
      notifications: definitions,
      channels: { inApp: { enabled: true } },
      logger: quiet,
      plugins: [
        mobilePush({
          provider: { name: "lenient", isValidToken: () => true, send: async () => [] },
          render: () => ({ title: "t", body: "b" }),
        }),
      ],
    });
    const response = await notify.handler.POST(
      post("/mobile-push/devices", { token: "x".repeat(600), platform: "ios" }),
    );
    expect(response.status).toBe(400);
  });
});

describe("#5 Node adapter", () => {
  const request = (proto: string | undefined) =>
    ({
      method: "GET",
      url: "/api/notifications",
      headers: { host: "app.dev", ...(proto === undefined ? {} : { "x-forwarded-proto": proto }) },
    }) as never;

  it("takes the first hop of x-forwarded-proto and ignores anything else", () => {
    expect(toWebRequest(request("https, http")).url).toBe("https://app.dev/api/notifications");
    expect(toWebRequest(request("HTTPS")).url).toBe("https://app.dev/api/notifications");
    expect(toWebRequest(request("javascript")).url).toBe("http://app.dev/api/notifications");
    expect(toWebRequest(request(undefined)).url).toBe("http://app.dev/api/notifications");
  });

  it("finishes the handler when the client leaves mid-backpressure", async () => {
    let settled = false;
    const chunk = new Uint8Array(1024 * 1024);
    const node = toNodeHandler(async () => {
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(chunk);
        },
      });
      return new Response(stream);
    });
    const server = createServer((req, res) => {
      void node(req, res).then(() => {
        settled = true;
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const controller = new AbortController();
    const response = await fetch(`http://127.0.0.1:${port}/`, { signal: controller.signal });
    await response.body?.getReader().read();
    await new Promise((resolve) => setTimeout(resolve, 200));
    controller.abort();
    const deadline = Date.now() + 3_000;
    while (!settled && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(settled).toBe(true);
  });
});

describe("#6 pg_notify binds its values", () => {
  it("sends channel and payload as parameters, never inside the SQL text", async () => {
    const calls: { text: string; values?: readonly unknown[] | undefined }[] = [];
    const adapter = pgListenNotify({
      query: async (text, values) => {
        calls.push({ text, values });
      },
      on: () => {},
      off: () => {},
    });
    await adapter.notify("easy_ping", "o1|inbox:o'brien\\");
    expect(calls[0]).toEqual({
      text: "SELECT pg_notify($1, $2)",
      values: ["easy_ping", "o1|inbox:o'brien\\"],
    });
  });
});

describe("#7 Telegram", () => {
  const sent: string[] = [];
  const provider: TelegramProvider = {
    name: "fake",
    send: async (message) => {
      sent.push(message.text);
      return { ok: true, messageId: 1 };
    },
    getUpdates: async () => [],
    setWebhook: async () => {},
    deleteWebhook: async () => {},
    getMe: async () => ({ id: 1, username: "bot" }),
  };
  const build = () => {
    const plugin = telegram({ provider, botUsername: "bot", render: () => ({ text: "x" }) });
    const notify = easyPing({
      database: db.adapter,
      secret: "test-signing-secret-0123456789",
      cron: { secret: "cron-secret-0123456789" },
      session: { getUserId: async () => "u1" },
      getRecipients: async (ids) => ids.map(recipient),
      notifications: definitions,
      channels: { inApp: { enabled: true } },
      logger: quiet,
      plugins: [plugin],
    });
    return { plugin, notify };
  };

  it("ignores malformed updates without writing anything", async () => {
    await db.truncate();
    const { plugin } = build();
    for (const update of [
      null,
      "nope",
      { update_id: 1, message: { text: "/stop", chat: { id: { evil: 1 }, type: "private" } } },
      { update_id: 2, message: { text: 42, chat: { id: 1, type: "private" } } },
      { update_id: 3, message: { text: "/start x", chat: { id: 1, type: 7 } } },
      { update_id: 4, my_chat_member: { chat: { id: 1, type: "private" }, new_chat_member: {} } },
      { update_id: 5, message: { text: "/start x", chat: { id: "1; DROP", type: "private" } } },
    ]) {
      await expect(plugin.handleUpdate(update as never)).resolves.toBeUndefined();
    }
    expect(await db.rows("notification_telegram_chat")).toEqual([]);
  });

  it("keeps one live link code per user: a new link retires the previous one", async () => {
    await db.truncate();
    const { plugin, notify } = build();
    const mint = async () =>
      ((await (await notify.handler.POST(post("/telegram/link", {}))).json()) as { code: string })
        .code;
    const first = await mint();
    const second = await mint();
    expect(await db.rows("notification_telegram_link")).toHaveLength(1);

    await plugin.handleUpdate({
      update_id: 1,
      message: { text: `/start ${first}`, chat: { id: 10, type: "private" } },
    });
    expect(await db.rows("notification_telegram_chat")).toHaveLength(0);
    await plugin.handleUpdate({
      update_id: 2,
      message: { text: `/start ${second}`, chat: { id: 10, type: "private" } },
    });
    expect(await db.rows("notification_telegram_chat")).toHaveLength(1);
  });
});

describe("#8 off-curve p256dh", () => {
  it("is reported as an invalid subscription, so the device is pruned rather than retried", async () => {
    const offCurve = Buffer.from([0x04, ...new Uint8Array(64).fill(7)]).toString("base64url");
    const auth = Buffer.from(new Uint8Array(16).fill(9)).toString("base64url");
    await expect(
      encryptPayload(new TextEncoder().encode("hi"), offCurve, auth),
    ).rejects.toBeInstanceOf(InvalidSubscriptionError);
  });
});

describe("#9 core routes cannot be shadowed", () => {
  it("refuses a plugin that registers a core route", () => {
    for (const [method, path] of [
      ["GET", "/"],
      ["POST", "/read"],
      ["GET", "/events"],
      ["POST", "/cron"],
    ] as const) {
      expect(() =>
        easyPing({
          database: db.adapter,
          secret: "test-signing-secret-0123456789",
          cron: { secret: "cron-secret-0123456789" },
          session: { getUserId: async () => "u1" },
          getRecipients: async (ids) => ids.map(recipient),
          notifications: definitions,
          channels: { inApp: { enabled: true } },
          logger: quiet,
          plugins: [
            {
              id: "shadow",
              routes: [
                { method, path, scope: { type: "user" }, handler: async () => new Response("x") },
              ],
            },
          ],
        }),
      ).toThrow(ConfigError);
    }
  });
});

const KEY_ONLY = {
  tag: {
    tableName: "sec090_tag",
    fields: { userId: { type: "string", required: true }, tag: { type: "string", required: true } },
    primaryKey: ["userId", "tag"],
  },
} satisfies SchemaDeclaration;

describe.each(availableBackends)(
  "#10 upsert where every column is in the conflict key: $name",
  (backend) => {
    let target: Backend;
    beforeAll(async () => {
      target = await backend.create("sec090-upsert");
      await target.applySchema(KEY_ONLY);
    });
    afterAll(async () => {
      await target.end();
    });

    it("is a no-op on conflict instead of a syntax error", async () => {
      const store = createPluginStore("p", KEY_ONLY, target.adapter, "");
      const row = { userId: "u1", tag: "a" };
      await store.upsert("sec090_tag", [row], { onConflict: ["userId", "tag"] });
      await store.upsert("sec090_tag", [row], { onConflict: ["userId", "tag"] });
      expect(await store.find("sec090_tag", { userId: "u1" })).toHaveLength(1);
    });
  },
);

describe("#11 and #13 plugin store guards", () => {
  const schema = {
    own: {
      tableName: "notification_telegram_link",
      fields: {
        code: { type: "string", required: true },
        userId: { type: "string", required: true },
        createdAt: { type: "date", required: true },
        expiresAt: { type: "date", required: true },
      },
      primaryKey: ["code"],
    },
    neighbour: { ...telegramSchema.telegramChat, readOnly: true },
  } satisfies SchemaDeclaration;

  it("refuses every write to a readOnly table but still reads it", async () => {
    await db.truncate();
    const store = createPluginStore("p", schema, db.adapter, "");
    const table = "notification_telegram_chat";
    await expect(store.find(table, { userId: "u1" })).resolves.toEqual([]);
    await expect(
      store.insert(table, [
        {
          id: "1",
          userId: "u",
          chatId: "1",
          chatType: "private",
          linkedAt: new Date(),
          lastSeenAt: new Date(),
        },
      ]),
    ).rejects.toBeInstanceOf(ConfigError);
    await expect(store.upsert(table, [{ id: "1" }], { onConflict: ["id"] })).rejects.toBeInstanceOf(
      ConfigError,
    );
    await expect(store.update(table, { id: "1" }, { title: "x" })).rejects.toBeInstanceOf(
      ConfigError,
    );
    await expect(store.remove(table, { id: "1" })).rejects.toBeInstanceOf(ConfigError);
  });

  it("refuses update and remove with an empty where clause", async () => {
    const store = createPluginStore("p", schema, db.adapter, "");
    const table = "notification_telegram_link";
    await expect(store.remove(table, {})).rejects.toThrow(/every row/);
    await expect(store.update(table, {}, { userId: "x" })).rejects.toThrow(/every row/);
  });
});

describe("SQLite planner flags plans that must run in a transaction", () => {
  it("sets requiresTransaction only when a table is rebuilt", async () => {
    const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as typeof NodeSqlite;
    const sqliteDb = new DatabaseSync(":memory:");
    const query = sqliteQuery(sqliteDb);
    const v1 = {
      w: { tableName: "w", fields: { id: { type: "string", required: true } }, primaryKey: ["id"] },
    } satisfies SchemaDeclaration;
    const fresh = await planSqliteMigration(query, v1);
    expect(fresh.requiresTransaction).toBeUndefined();
    for (const statement of fresh.statements) sqliteDb.exec(statement);

    const withTimestamp = {
      w: {
        ...v1.w,
        fields: { ...v1.w.fields, at: { type: "date", required: true, defaultNow: true } },
      },
    } satisfies SchemaDeclaration;
    expect((await planSqliteMigration(query, withTimestamp)).requiresTransaction).toBe(true);
    sqliteDb.close();
  });
});
