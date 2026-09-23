import type { DeliveryOutcome } from "../../core/adapter";
import { encodeBase64Url } from "../../core/base64url";
import type { Logger } from "../../core/errors";
import { readJsonBody } from "../../core/handler";
import { escapeHtml } from "../../core/html";
import type {
  DeliverContext,
  EasyPingPlugin,
  PluginInitContext,
  RouteDefinition,
  SchemaDeclaration,
} from "../../core/plugin";
import {
  type TelegramProvider,
  type TelegramUpdate,
  telegramStartLink,
} from "../../providers/telegram";

const CHAT = "notification_telegram_chat";
const LINK = "notification_telegram_link";

export type TelegramChat = {
  id: string;
  userId: string;
  chatId: string;
  /** "private", "group", "supergroup" or "channel". */
  chatType: string;
  username: string | null;
  title: string | null;
  linkedAt: Date;
  lastSeenAt: Date;
};

export type TelegramLink = {
  code: string;
  userId: string;
  createdAt: Date;
  expiresAt: Date;
};

export type TelegramRendered = {
  /** Telegram HTML. Anything user-typed inside it goes through escapeHtml(). */
  text: string;
  /** Adds one inline button under the message. */
  button?: { text: string; url: string } | undefined;
};

export type TelegramOptions = {
  provider: TelegramProvider;
  /** Without the @. Builds the https://t.me/<bot>?start=<code> link. */
  botUsername: string;
  render: (input: { type: string; payload: unknown }) => TelegramRendered;
  /**
   * Shared with Telegram through setWebhook; Telegram echoes it in
   * X-Telegram-Bot-Api-Secret-Token and the webhook route accepts nothing else.
   * Unset, the route is not mounted and updates must come through poll().
   */
  webhookSecret?: string | undefined;
  /** How long a "Connect Telegram" link stays valid. Default 10 minutes. */
  linkTtlMinutes?: number | undefined;
  /** Linking past this evicts the user's least recently seen chat. Default 5. */
  maxChatsPerUser?: number | undefined;
  /** Bot replies, if the defaults are not your voice. */
  messages?: Partial<typeof DEFAULT_MESSAGES> | undefined;
};

const DEFAULT_MESSAGES = {
  connected: "Connected. You will receive notifications here.",
  disconnected: "Disconnected. You will not receive notifications here any more.",
  expired: "That link has expired. Open the app and connect Telegram again.",
  start: "Open the app and use “Connect Telegram” to link this chat.",
};

/** The tables this plugin owns, exported so DDL needs no plugin instance. */
export const telegramSchema = {
  telegramChat: {
    tableName: CHAT,
    fields: {
      id: { type: "string", required: true },
      userId: { type: "string", required: true },
      chatId: { type: "string", required: true },
      chatType: { type: "string", required: true },
      username: { type: "string" },
      title: { type: "string" },
      linkedAt: { type: "date", required: true, defaultNow: true },
      lastSeenAt: { type: "date", required: true, defaultNow: true },
    },
    primaryKey: ["id"],
    indexes: [
      { on: ["userId"], name: "telegram_chat_user_idx" },
      // A chat belongs to one account at a time; re-linking moves it.
      { on: ["chatId"], unique: true, name: "telegram_chat_chat_idx" },
    ],
  },
  telegramLink: {
    tableName: LINK,
    fields: {
      code: { type: "string", required: true },
      userId: { type: "string", required: true },
      createdAt: { type: "date", required: true, defaultNow: true },
      expiresAt: { type: "date", required: true },
    },
    primaryKey: ["code"],
    indexes: [{ on: ["userId"], name: "telegram_link_user_idx" }],
  },
} as const satisfies SchemaDeclaration;

const randomCode = () => encodeBase64Url(crypto.getRandomValues(new Uint8Array(24)));

/** Telegram refuses buttons to localhost, private hosts and non-http schemes with a 400 for the whole message. */
export function isButtonUrlAllowed(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return url.protocol === "tg:";
  const host = url.hostname.toLowerCase();
  return !(
    host === "localhost" ||
    /\.(localhost|local|internal|lan)$/.test(host) ||
    /^\d+\.\d+\.\d+\.\d+$/.test(host) ||
    host.startsWith("[")
  );
}

const encoder = new TextEncoder();

async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const [left, right] = await Promise.all(
    [a, b].map(
      async (value) => new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))),
    ),
  );
  let diff = 0;
  for (let i = 0; i < 32; i += 1) diff |= (left?.[i] ?? 0) ^ (right?.[i] ?? 0);
  return diff === 0;
}

export type TelegramPlugin = EasyPingPlugin<"telegram", typeof telegramSchema> & {
  /** Feeds one Bot API update through the linking logic. The webhook route and poll() both call it. */
  handleUpdate(update: TelegramUpdate): Promise<void>;
  /**
   * Long-polls getUpdates instead of a webhook: for development, or a host
   * with no public URL. One poller per bot token, or Telegram splits updates
   * between them. Call stop() on shutdown.
   */
  poll(options?: { logger?: Logger | undefined }): { stop(): void };
};

/** Telegram over a bot the user connects with one tap. Fans out per linked chat; blocked chats are pruned. */
export function telegram(options: TelegramOptions): TelegramPlugin {
  let ctx: PluginInitContext;
  const messages = { ...DEFAULT_MESSAGES, ...options.messages };
  const ttlMs = (options.linkTtlMinutes ?? 10) * 60_000;
  const maxChats = Math.max(1, options.maxChatsPerUser ?? 5);
  const botUsername = options.botUsername.replace(/^@/, "");

  const reply = async (chatId: string, text: string) => {
    const result = await options.provider.send({ chatId, text: escapeHtml(text) });
    if (!result.ok) ctx.logger.warn(`telegram reply to chat failed: ${result.error}`);
  };

  async function link(code: string, chat: NonNullable<TelegramUpdate["message"]>["chat"]) {
    const [pending] = await ctx.store.find<TelegramLink>(LINK, { code }, { limit: 1 });
    const chatId = String(chat.id);

    if (!pending || pending.expiresAt.getTime() < Date.now()) {
      if (pending) await ctx.store.remove(LINK, { code });
      await reply(chatId, messages.expired);
      return;
    }
    // One-time: the code is spent whether or not the rest succeeds.
    await ctx.store.remove(LINK, { code });

    const now = new Date();
    const details = {
      chatType: chat.type,
      username: chat.username ?? null,
      title: chat.title ?? null,
      lastSeenAt: now,
    };
    const [existing] = await ctx.store.find<TelegramChat>(CHAT, { chatId }, { limit: 1 });

    if (existing) {
      // Re-linking moves the chat to whoever holds the fresh code: the Telegram
      // user tapped it, and the app session that minted it is theirs.
      await ctx.store.update(
        CHAT,
        { id: existing.id },
        { userId: pending.userId, linkedAt: now, ...details },
      );
    } else {
      const chats = await ctx.store.find<TelegramChat>(
        CHAT,
        { userId: pending.userId },
        { orderBy: { field: "lastSeenAt", direction: "asc" } },
      );
      const excess = chats.length - maxChats + 1;
      if (excess > 0) {
        await ctx.store.remove(CHAT, { id: { in: chats.slice(0, excess).map((row) => row.id) } });
      }
      await ctx.store.insert(CHAT, [
        { id: crypto.randomUUID(), userId: pending.userId, chatId, linkedAt: now, ...details },
      ]);
    }
    await reply(chatId, messages.connected);
  }

  async function handleUpdate(update: TelegramUpdate): Promise<void> {
    const member = update.my_chat_member;
    if (member && ["kicked", "left"].includes(member.new_chat_member.status)) {
      await ctx.store.remove(CHAT, { chatId: String(member.chat.id) });
      return;
    }

    const message = update.message;
    if (!message?.text) return;
    const chatId = String(message.chat.id);
    const [command, argument] = message.text.trim().split(/\s+/, 2);
    // "/start@botname" arrives in groups.
    const name = command?.split("@")[0];

    if (name === "/start") {
      if (argument) await link(argument, message.chat);
      else await reply(chatId, messages.start);
      return;
    }
    if (name === "/stop") {
      const removed = await ctx.store.remove(CHAT, { chatId });
      if (removed > 0) await reply(chatId, messages.disconnected);
    }
  }

  const routes: RouteDefinition[] = [
    {
      path: "/telegram/link",
      method: "POST",
      scope: { type: "user" },
      handler: async ({ userId }) => {
        const owner = userId ?? "";
        const now = Date.now();
        // A user's stale codes go, so the table cannot fill with abandoned links.
        await ctx.store.remove(LINK, { userId: owner, expiresAt: { lt: new Date(now) } });

        const code = randomCode();
        const expiresAt = new Date(now + ttlMs);
        await ctx.store.insert(LINK, [
          { code, userId: owner, createdAt: new Date(now), expiresAt },
        ]);
        return Response.json({
          url: telegramStartLink(botUsername, code),
          code,
          expiresAt: expiresAt.toISOString(),
        });
      },
    },
    {
      path: "/telegram/chats",
      method: "GET",
      scope: { type: "user" },
      handler: async ({ userId }) => {
        const chats = await ctx.store.find<TelegramChat>(
          CHAT,
          { userId: userId ?? "" },
          { orderBy: { field: "linkedAt", direction: "desc" } },
        );
        return Response.json({
          chats: chats.map((chat) => ({
            chatId: chat.chatId,
            chatType: chat.chatType,
            username: chat.username,
            title: chat.title,
            linkedAt: chat.linkedAt.toISOString(),
          })),
        });
      },
    },
    {
      path: "/telegram/unlink",
      method: "POST",
      scope: { type: "user" },
      handler: async ({ request, userId }) => {
        const parsed = await readJsonBody(request);
        if ("error" in parsed) return parsed.error;
        const { chatId } = parsed.body;
        const owner = userId ?? "";
        // Scoped by userId too: a chat id is not a secret.
        const removed = await ctx.store.remove(
          CHAT,
          typeof chatId === "string" && chatId !== ""
            ? { userId: owner, chatId }
            : { userId: owner },
        );
        return Response.json({ removed });
      },
    },
  ];

  if (options.webhookSecret) {
    const secret = options.webhookSecret;
    routes.push({
      path: "/telegram/webhook",
      method: "POST",
      scope: {
        type: "custom",
        justification:
          "called by Telegram, authenticated by the X-Telegram-Bot-Api-Secret-Token header set through setWebhook",
      },
      handler: async ({ request }) => {
        const presented = request.headers.get("x-telegram-bot-api-secret-token") ?? "";
        if (!(await timingSafeEqual(presented, secret))) return new Response(null, { status: 401 });

        const parsed = await readJsonBody(request);
        if ("error" in parsed) return parsed.error;
        try {
          await handleUpdate(parsed.body as unknown as TelegramUpdate);
        } catch (error) {
          // Telegram retries non-2xx for hours; a bad update is logged and acknowledged.
          ctx.logger.error("telegram update failed", { error });
        }
        return Response.json({ ok: true });
      },
    });
  }

  return {
    id: "telegram",
    channels: ["telegram"],
    schema: telegramSchema,

    init: (context) => {
      ctx = context;
    },

    hooks: {
      deliver: async (context: DeliverContext): Promise<DeliveryOutcome> => {
        const chats = await ctx.store.find<TelegramChat>(CHAT, {
          userId: context.notification.userId,
        });
        if (chats.length === 0) return { result: "skipped", reason: "no linked telegram chat" };

        const rendered = options.render({
          type: context.notification.type,
          payload: context.notification.payload,
        });
        let button = rendered.button;
        if (button && !isButtonUrlAllowed(button.url)) {
          ctx.logger.warn(
            `telegram: dropped button "${button.url}"; Telegram accepts only public http(s) links`,
          );
          button = undefined;
        }

        const results = await Promise.all(
          chats.map((chat) =>
            options.provider.send({
              chatId: chat.chatId,
              text: rendered.text,
              buttons: button ? [button] : undefined,
              signal: context.signal,
            }),
          ),
        );

        const prune: string[] = [];
        let delivered = 0;
        let retryable = false;
        let lastError = "";
        results.forEach((result, index) => {
          const chat = chats[index];
          if (!chat) return;
          if (result.ok) {
            delivered += 1;
            return;
          }
          lastError = result.error;
          if (result.gone) prune.push(chat.id);
          else if (result.retryable) retryable = true;
        });

        if (prune.length > 0) await ctx.store.remove(CHAT, { id: { in: prune } });
        if (delivered > 0) return { result: "sent" };
        if (prune.length === chats.length) {
          return { result: "failed", error: "every linked chat is gone", retryable: false };
        }
        return { result: "failed", error: lastError || "telegram refused the message", retryable };
      },
    },

    routes,
    handleUpdate,

    poll(pollOptions = {}) {
      const logger = pollOptions.logger ?? ctx.logger;
      const controller = new AbortController();
      let offset: number | undefined;

      void (async () => {
        while (!controller.signal.aborted) {
          try {
            const updates = await options.provider.getUpdates({
              offset,
              signal: controller.signal,
            });
            for (const update of updates) {
              offset = update.update_id + 1;
              await handleUpdate(update).catch((error) =>
                logger.error("telegram update failed", { error }),
              );
            }
          } catch (error) {
            if (controller.signal.aborted) return;
            logger.error("telegram polling failed", { error });
            await new Promise((resolve) => setTimeout(resolve, 3_000));
          }
        }
      })();

      return { stop: () => controller.abort() };
    },
  };
}
