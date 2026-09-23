export type TelegramButton = { text: string; url: string };

export type TelegramMessage = {
  chatId: string;
  /** Telegram HTML: <b>, <i>, <a href>, <code>, <pre>. Escape user text with escapeHtml(). */
  text: string;
  buttons?: readonly TelegramButton[] | undefined;
  signal?: AbortSignal | undefined;
};

export type TelegramSendResult =
  | { ok: true; messageId: number }
  | {
      ok: false;
      error: string;
      /** Worth another attempt: rate limit, 5xx, network. */
      retryable: boolean;
      /** The chat can never receive again (user blocked the bot, chat deleted). Prune it. */
      gone: boolean;
      retryAfterSeconds?: number | undefined;
    };

/** The slice of a Bot API update the plugin reads. Everything else passes through untouched. */
export type TelegramUpdate = {
  update_id: number;
  message?: {
    text?: string;
    chat: { id: number | string; type: string; username?: string; title?: string };
    from?: { id: number; username?: string; first_name?: string };
  };
  my_chat_member?: {
    chat: { id: number | string; type: string; username?: string; title?: string };
    new_chat_member: { status: string };
  };
};

export type TelegramProvider = {
  name: string;
  send(message: TelegramMessage): Promise<TelegramSendResult>;
  /** Long-polls for updates. For development or hosts without a public URL. */
  getUpdates(options: {
    offset?: number | undefined;
    timeoutSeconds?: number | undefined;
    signal?: AbortSignal | undefined;
  }): Promise<TelegramUpdate[]>;
  /** Points Telegram at your webhook route. Run once per deployment URL. */
  setWebhook(url: string, secretToken: string): Promise<void>;
  deleteWebhook(): Promise<void>;
  getMe(): Promise<{ id: number; username: string }>;
};

export type TelegramBotOptions = {
  /** From @BotFather. Never appears in errors or logs. */
  token: string;
  fetch?: typeof globalThis.fetch | undefined;
  /** Default https://api.telegram.org. A local fake for tests. */
  apiBase?: string | undefined;
  timeoutMs?: number | undefined;
};

type ApiResponse<T> =
  | { ok: true; result: T }
  | { ok: false; description?: string; error_code?: number; parameters?: { retry_after?: number } };

/** Deep link that opens the bot with a start parameter. Codes are [A-Za-z0-9_-], at most 64 chars. */
export const telegramStartLink = (botUsername: string, code: string) =>
  `https://t.me/${botUsername.replace(/^@/, "")}?start=${encodeURIComponent(code)}`;

/** Bot API over fetch, so it runs on edge runtimes. Failures are classified, never thrown, on send. */
export function telegramBot(options: TelegramBotOptions): TelegramProvider {
  const doFetch = options.fetch ?? globalThis.fetch;
  const base = `${(options.apiBase ?? "https://api.telegram.org").replace(/\/$/, "")}/bot${options.token}`;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const redact = (text: string) => text.split(options.token).join("<token>");

  async function call<T>(
    method: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
    budgetMs = timeoutMs,
  ): Promise<{ status: number; data: ApiResponse<T> }> {
    const timeout = AbortSignal.timeout(budgetMs);
    const merged = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const response = await doFetch(`${base}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: merged,
    });
    const data = (await response.json().catch(() => ({ ok: false }))) as ApiResponse<T>;
    return { status: response.status, data };
  }

  async function must<T>(method: string, body: Record<string, unknown>): Promise<T> {
    const { data } = await call<T>(method, body);
    if (!data.ok)
      throw new Error(redact(`telegram ${method} failed: ${data.description ?? "unknown"}`));
    return data.result;
  }

  return {
    name: "telegram",

    async send(message) {
      const body: Record<string, unknown> = {
        chat_id: message.chatId,
        text: message.text,
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      };
      if (message.buttons?.length) {
        body.reply_markup = {
          inline_keyboard: [
            message.buttons.map((button) => ({ text: button.text, url: button.url })),
          ],
        };
      }

      let status: number;
      let data: ApiResponse<{ message_id: number }>;
      try {
        ({ status, data } = await call<{ message_id: number }>(
          "sendMessage",
          body,
          message.signal,
        ));
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        return { ok: false, error: redact(text), retryable: true, gone: false };
      }

      if (data.ok) return { ok: true, messageId: data.result.message_id };

      const description = redact(data.description ?? `HTTP ${status}`);
      const code = data.error_code ?? status;
      if (code === 429) {
        return {
          ok: false,
          error: description,
          retryable: true,
          gone: false,
          retryAfterSeconds: data.parameters?.retry_after,
        };
      }
      // 403: the user blocked the bot or was deactivated. 400 "chat not found": deleted or never existed.
      const gone =
        code === 403 ||
        (code === 400 && /chat not found|user is deactivated|bot was kicked/i.test(description));
      return { ok: false, error: description, retryable: code >= 500, gone };
    },

    async getUpdates({ offset, timeoutSeconds = 25, signal }) {
      // Telegram holds the request open for `timeout` seconds; the budget must outlive it.
      const { data } = await call<TelegramUpdate[]>(
        "getUpdates",
        {
          ...(offset === undefined ? {} : { offset }),
          timeout: timeoutSeconds,
          allowed_updates: ["message", "my_chat_member"],
        },
        signal,
        (timeoutSeconds + 10) * 1000,
      );
      if (!data.ok)
        throw new Error(redact(`telegram getUpdates failed: ${data.description ?? "unknown"}`));
      return data.result;
    },

    setWebhook: async (url, secretToken) => {
      await must("setWebhook", {
        url,
        secret_token: secretToken,
        allowed_updates: ["message", "my_chat_member"],
      });
    },
    deleteWebhook: async () => {
      await must("deleteWebhook", {});
    },
    getMe: () => must("getMe", {}),
  };
}
