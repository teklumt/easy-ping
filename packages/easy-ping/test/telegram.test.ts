import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { EasyPingConfig } from "../src/core/config";
import type { NotificationDefinitions } from "../src/core/definition";
import { escapeHtml } from "../src/core/html";
import { easyPing } from "../src/core/instance";
import type { Recipient } from "../src/core/types";
import { isButtonUrlAllowed, telegram, telegramSchema } from "../src/plugins/telegram";
import type {
  TelegramMessage,
  TelegramProvider,
  TelegramSendResult,
  TelegramUpdate,
} from "../src/providers/telegram";
import { availableBackends, type Backend } from "./helpers/backends";

const BASE = "/api/notifications";
const CRON = "cron-secret-0123456789";
const HOOK = "webhook-secret-value";

const definitions = {
  commentReply: { channels: ["telegram"] },
  both: { channels: ["inApp", "telegram"] },
} satisfies NotificationDefinitions;

const recipient = (userId: string): Recipient => ({
  userId,
  email: `${userId}@x.dev`,
  timezone: "UTC",
  locale: "en",
});

const sqlite = availableBackends.find((backend) => backend.name === "sqlite");
if (!sqlite) throw new Error("sqlite backend missing");

let db: Backend;
let outbox: TelegramMessage[] = [];
let behaviour: (message: TelegramMessage) => TelegramSendResult = () => ({
  ok: true,
  messageId: 1,
});
let polled: TelegramUpdate[][] = [];

const provider: TelegramProvider = {
  name: "fake-telegram",
  send: async (message) => {
    outbox.push(message);
    return behaviour(message);
  },
  getUpdates: async ({ signal }) => {
    const next = polled.shift();
    if (next) return next;
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 20);
      signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        resolve(undefined);
      });
    });
    return [];
  },
  setWebhook: async () => {},
  deleteWebhook: async () => {},
  getMe: async () => ({ id: 1, username: "easy_ping_bot" }),
};

function build(
  pluginOverrides: Partial<Parameters<typeof telegram>[0]> = {},
  overrides: Partial<EasyPingConfig<typeof definitions>> = {},
) {
  const plugin = telegram({
    provider,
    botUsername: "@easy_ping_bot",
    webhookSecret: HOOK,
    maxChatsPerUser: 2,
    render: ({ type, payload }) => ({
      text: `<b>${escapeHtml((payload as { who?: string }).who ?? "someone")}</b> ${type}`,
      button: { text: "Open", url: "https://app.dev/inbox" },
    }),
    ...pluginOverrides,
  });
  const notify = easyPing({
    database: db.adapter,
    secret: "test-signing-secret-0123456789",
    cron: { secret: CRON },
    session: { getUserId: async (request) => request.headers.get("x-user") },
    getRecipients: async (ids) => ids.map(recipient),
    notifications: definitions,
    channels: { inApp: { enabled: true } },
    delivery: { mode: "cron" },
    logger: { warn: () => {}, error: () => {} },
    plugins: [plugin],
    ...overrides,
  });
  return { notify, plugin };
}

const post = (path: string, body: unknown = {}, headers: Record<string, string> = {}) =>
  new Request(`https://app.dev${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
const asUser = (userId: string) => ({ "x-user": userId });

const runCron = (notify: ReturnType<typeof build>["notify"]) =>
  notify.handler.POST(
    new Request(`https://app.dev${BASE}/cron`, {
      method: "POST",
      headers: { authorization: `Bearer ${CRON}` },
    }),
  );

const startUpdate = (chatId: number, code: string, extra: Record<string, unknown> = {}) => ({
  update_id: 1,
  message: {
    text: `/start ${code}`,
    chat: { id: chatId, type: "private", username: "dana", ...extra },
    from: { id: chatId, first_name: "Dana" },
  },
});

async function mintCode(notify: ReturnType<typeof build>["notify"], userId: string) {
  const response = await notify.handler.POST(post("/telegram/link", {}, asUser(userId)));
  expect(response.status).toBe(200);
  return (await response.json()) as { url: string; code: string; expiresAt: string };
}

/** Links chat -> user the way a real tap does: mint a code, then deliver the /start update. */
async function linkChat(
  built: ReturnType<typeof build>,
  userId: string,
  chatId: number,
  via: "webhook" | "direct" = "direct",
) {
  const { code } = await mintCode(built.notify, userId);
  if (via === "direct") {
    await built.plugin.handleUpdate(startUpdate(chatId, code));
  } else {
    const response = await built.notify.handler.POST(
      post("/telegram/webhook", startUpdate(chatId, code), {
        "x-telegram-bot-api-secret-token": HOOK,
      }),
    );
    expect(response.status).toBe(200);
  }
}

const chats = () => db.rows("notification_telegram_chat");
const links = () => db.rows("notification_telegram_link");

describe("telegram plugin", () => {
  beforeAll(async () => {
    db = await sqlite.create("telegram");
    await db.applySchema(telegramSchema);
  });
  afterAll(async () => {
    await db.end();
  });
  beforeEach(async () => {
    await db.truncate();
    outbox = [];
    polled = [];
    behaviour = () => ({ ok: true, messageId: 1 });
  });

  describe("linking", () => {
    it("mints a one-time deep link that a /start tap turns into a linked chat", async () => {
      const built = build();
      const minted = await mintCode(built.notify, "u1");
      expect(minted.url).toBe(`https://t.me/easy_ping_bot?start=${minted.code}`);
      expect(await links()).toHaveLength(1);

      await built.plugin.handleUpdate(startUpdate(4242, minted.code));

      const rows = await chats();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ user_id: "u1", chat_id: "4242", username: "dana" });
      expect(await links()).toHaveLength(0);
      expect(outbox.at(-1)?.text).toContain("Connected");

      // The code is spent.
      await built.plugin.handleUpdate(startUpdate(5555, minted.code));
      expect(await chats()).toHaveLength(1);
      expect(outbox.at(-1)?.text).toContain("expired");
    });

    it("refuses an expired code", async () => {
      const built = build({ linkTtlMinutes: 0 });
      const { code } = await mintCode(built.notify, "u1");
      await new Promise((resolve) => setTimeout(resolve, 5));
      await built.plugin.handleUpdate(startUpdate(1, code));
      expect(await chats()).toHaveLength(0);
      expect(outbox.at(-1)?.text).toContain("expired");
    });

    it("accepts updates through the webhook only with the shared secret", async () => {
      const built = build();
      const { code } = await mintCode(built.notify, "u1");

      const wrong = await built.notify.handler.POST(
        post("/telegram/webhook", startUpdate(1, code), {
          "x-telegram-bot-api-secret-token": "nope",
        }),
      );
      expect(wrong.status).toBe(401);
      const missing = await built.notify.handler.POST(
        post("/telegram/webhook", startUpdate(1, code)),
      );
      expect(missing.status).toBe(401);
      expect(await chats()).toHaveLength(0);

      await linkChat(built, "u1", 1, "webhook");
      expect(await chats()).toHaveLength(1);
    });

    it("is not mounted at all without a webhook secret", async () => {
      const built = build({ webhookSecret: undefined });
      expect(built.notify.listRoutes().some((route) => route.path === "/telegram/webhook")).toBe(
        false,
      );
      const response = await built.notify.handler.POST(post("/telegram/webhook", {}, asUser("u1")));
      expect(response.status).toBe(404);
    });

    it("moves a chat to the account that minted the fresh code", async () => {
      const built = build();
      await linkChat(built, "u1", 7);
      await linkChat(built, "u2", 7);
      const rows = await chats();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.user_id).toBe("u2");
    });

    it("evicts the least recently seen chat past maxChatsPerUser", async () => {
      const built = build();
      await linkChat(built, "u1", 1);
      await linkChat(built, "u1", 2);
      await linkChat(built, "u1", 3);
      const rows = await chats();
      expect(rows.map((row) => row.chat_id).sort()).toEqual(["2", "3"]);
    });

    it("unlinks on /stop, on being blocked, and through the user route", async () => {
      const built = build();
      await linkChat(built, "u1", 1);
      await linkChat(built, "u1", 2);
      await linkChat(built, "u2", 3);

      await built.plugin.handleUpdate({
        update_id: 2,
        message: { text: "/stop", chat: { id: 1, type: "private" } },
      });
      expect(outbox.at(-1)?.text).toContain("Disconnected");

      await built.plugin.handleUpdate({
        update_id: 3,
        my_chat_member: { chat: { id: 2, type: "private" }, new_chat_member: { status: "kicked" } },
      });
      expect(await chats()).toHaveLength(1);

      // u1 cannot remove u2's chat by id.
      const foreign = await built.notify.handler.POST(
        post("/telegram/unlink", { chatId: "3" }, asUser("u1")),
      );
      expect(await foreign.json()).toEqual({ removed: 0 });
      const own = await built.notify.handler.POST(post("/telegram/unlink", {}, asUser("u2")));
      expect(await own.json()).toEqual({ removed: 1 });
      expect(await chats()).toHaveLength(0);
    });

    it("lists a user's chats and nobody else's", async () => {
      const built = build();
      await linkChat(built, "u1", 1);
      await linkChat(built, "u2", 2);
      const response = await built.notify.handler.GET(
        new Request(`https://app.dev${BASE}/telegram/chats`, { headers: asUser("u1") }),
      );
      const body = (await response.json()) as { chats: { chatId: string }[] };
      expect(body.chats.map((chat) => chat.chatId)).toEqual(["1"]);
    });

    it("answers a bare /start with instructions and ignores other text", async () => {
      const built = build();
      await built.plugin.handleUpdate({
        update_id: 1,
        message: { text: "/start@easy_ping_bot", chat: { id: 1, type: "private" } },
      });
      expect(outbox.at(-1)?.text).toContain("Connect Telegram");
      await built.plugin.handleUpdate({
        update_id: 2,
        message: { text: "hello", chat: { id: 1, type: "private" } },
      });
      expect(outbox).toHaveLength(1);
    });
  });

  describe("delivery", () => {
    it("sends the rendered HTML with a button to every linked chat", async () => {
      const built = build();
      await linkChat(built, "u1", 1);
      await linkChat(built, "u1", 2);
      outbox = [];

      await built.notify.send("commentReply", { to: "u1", payload: { who: "<Dana>" } });
      await runCron(built.notify);

      expect(outbox).toHaveLength(2);
      expect(outbox.map((m) => m.chatId).sort()).toEqual(["1", "2"]);
      expect(outbox[0]?.text).toBe("<b>&lt;Dana&gt;</b> commentReply");
      expect(outbox[0]?.buttons).toEqual([{ text: "Open", url: "https://app.dev/inbox" }]);
      const deliveries = await db.rows("notification_delivery");
      expect(deliveries.filter((row) => row.channel === "telegram")[0]?.status).toBe("sent");
    });

    it("drops a button Telegram would refuse instead of failing the message", async () => {
      const built = build({
        render: () => ({ text: "hi", button: { text: "Open", url: "http://localhost:3210" } }),
      });
      await linkChat(built, "u1", 1);
      outbox = [];
      await built.notify.send("commentReply", { to: "u1", payload: {} });
      await runCron(built.notify);
      expect(outbox).toHaveLength(1);
      expect(outbox[0]?.buttons).toBeUndefined();
      expect((await db.rows("notification_delivery"))[0]?.status).toBe("sent");
    });

    it("skips, not fails, a user with no linked chat", async () => {
      const built = build();
      await built.notify.send("both", { to: "u9", payload: {} });
      await runCron(built.notify);
      const rows = await db.rows("notification_delivery");
      const byChannel = Object.fromEntries(rows.map((row) => [row.channel, row.status]));
      expect(byChannel).toEqual({ inApp: "sent", telegram: "skipped" });
      expect(outbox).toHaveLength(0);
    });

    it("prunes a chat that blocked the bot and fails without retry when none remain", async () => {
      const built = build();
      await linkChat(built, "u1", 1);
      behaviour = () => ({
        ok: false,
        error: "Forbidden: bot was blocked",
        retryable: false,
        gone: true,
      });

      await built.notify.send("commentReply", { to: "u1", payload: {} });
      await runCron(built.notify);

      expect(await chats()).toHaveLength(0);
      const [delivery] = await db.rows("notification_delivery");
      expect(delivery).toMatchObject({ status: "failed", attempts: 1 });
      expect(String(delivery?.last_error)).toContain("gone");
    });

    it("keeps a rate-limited delivery pending for another attempt", async () => {
      const built = build();
      await linkChat(built, "u1", 1);
      behaviour = () => ({
        ok: false,
        error: "429",
        retryable: true,
        gone: false,
        retryAfterSeconds: 3,
      });

      await built.notify.send("commentReply", { to: "u1", payload: {} });
      await runCron(built.notify);

      const [delivery] = await db.rows("notification_delivery");
      expect(delivery).toMatchObject({ status: "pending", attempts: 1 });
      expect(await chats()).toHaveLength(1);
    });
  });

  describe("polling", () => {
    it("feeds long-polled updates through the same linking logic and stops cleanly", async () => {
      const built = build();
      const { code } = await mintCode(built.notify, "u1");
      polled = [[startUpdate(31, code)]];

      const poller = built.plugin.poll();
      const deadline = Date.now() + 2_000;
      while ((await chats()).length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      poller.stop();
      await new Promise((resolve) => setTimeout(resolve, 30));

      const rows = await chats();
      expect(rows[0]).toMatchObject({ user_id: "u1", chat_id: "31" });
    });
  });
});

describe("isButtonUrlAllowed", () => {
  it("accepts public http(s) and tg links, refuses local and private targets", () => {
    expect(isButtonUrlAllowed("https://app.dev/inbox")).toBe(true);
    expect(isButtonUrlAllowed("http://example.com/x")).toBe(true);
    expect(isButtonUrlAllowed("tg://resolve?domain=easyping_123bot")).toBe(true);
    for (const bad of [
      "http://localhost:3210",
      "http://127.0.0.1",
      "http://app.local",
      "http://[::1]/",
      "javascript:alert(1)",
      "not a url",
    ]) {
      expect(isButtonUrlAllowed(bad)).toBe(false);
    }
  });
});
