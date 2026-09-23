import { describe, expect, it } from "vitest";
import { telegramBot, telegramStartLink } from "../../src/providers/telegram";

const TOKEN = "123456:ABC-secret-token";

/** A Bot API in miniature: records calls, answers with whatever the test scripted. */
function fakeApi(script: (method: string, body: Record<string, unknown>) => Response) {
  const calls: { method: string; body: Record<string, unknown> }[] = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url);
    expect(path.startsWith(`https://api.telegram.org/bot${TOKEN}/`)).toBe(true);
    const method = path.split("/").pop() ?? "";
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    calls.push({ method, body });
    return script(method, body);
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

const apiOk = (result: unknown) => Response.json({ ok: true, result });
const apiError = (status: number, description: string, extra: Record<string, unknown> = {}) =>
  Response.json({ ok: false, error_code: status, description, ...extra }, { status });

describe("telegramBot", () => {
  it("sends HTML with an inline button and link previews off", async () => {
    const api = fakeApi(() => apiOk({ message_id: 77 }));
    const bot = telegramBot({ token: TOKEN, fetch: api.fetch });

    const result = await bot.send({
      chatId: "42",
      text: "<b>Dana</b> replied",
      buttons: [{ text: "Open", url: "https://app.dev/c/1" }],
    });

    expect(result).toEqual({ ok: true, messageId: 77 });
    expect(api.calls[0]?.method).toBe("sendMessage");
    expect(api.calls[0]?.body).toMatchObject({
      chat_id: "42",
      text: "<b>Dana</b> replied",
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      reply_markup: { inline_keyboard: [[{ text: "Open", url: "https://app.dev/c/1" }]] },
    });
  });

  it("classifies a rate limit as retryable and carries retry_after", async () => {
    const api = fakeApi(() =>
      apiError(429, "Too Many Requests: retry after 7", { parameters: { retry_after: 7 } }),
    );
    const result = await telegramBot({ token: TOKEN, fetch: api.fetch }).send({
      chatId: "1",
      text: "x",
    });
    expect(result).toMatchObject({ ok: false, retryable: true, gone: false, retryAfterSeconds: 7 });
  });

  it("marks a blocked bot and a missing chat as gone, never retried", async () => {
    for (const [status, description] of [
      [403, "Forbidden: bot was blocked by the user"],
      [400, "Bad Request: chat not found"],
      [403, "Forbidden: user is deactivated"],
    ] as const) {
      const api = fakeApi(() => apiError(status, description));
      const result = await telegramBot({ token: TOKEN, fetch: api.fetch }).send({
        chatId: "1",
        text: "x",
      });
      expect(result).toMatchObject({ ok: false, gone: true, retryable: false });
    }
  });

  it("treats a malformed message as a permanent failure that keeps the chat", async () => {
    const api = fakeApi(() => apiError(400, "Bad Request: can't parse entities"));
    const result = await telegramBot({ token: TOKEN, fetch: api.fetch }).send({
      chatId: "1",
      text: "<b>",
    });
    expect(result).toMatchObject({ ok: false, gone: false, retryable: false });
  });

  it("retries on 5xx and on transport failure, and never leaks the token", async () => {
    const api = fakeApi(() => apiError(502, "Bad Gateway"));
    expect(
      await telegramBot({ token: TOKEN, fetch: api.fetch }).send({ chatId: "1", text: "x" }),
    ).toMatchObject({ ok: false, retryable: true });

    const failing = (async (url: string | URL | Request) => {
      throw new Error(`connect failed for ${String(url)}`);
    }) as unknown as typeof globalThis.fetch;
    const result = await telegramBot({ token: TOKEN, fetch: failing }).send({
      chatId: "1",
      text: "x",
    });
    expect(result).toMatchObject({ ok: false, retryable: true });
    if (!result.ok) {
      expect(result.error).not.toContain(TOKEN);
      expect(result.error).toContain("<token>");
    }
  });

  it("long-polls with the offset it is given and registers the webhook with its secret", async () => {
    const api = fakeApi((method) =>
      method === "getUpdates" ? apiOk([{ update_id: 9 }, { update_id: 10 }]) : apiOk(true),
    );
    const bot = telegramBot({ token: TOKEN, fetch: api.fetch });

    const updates = await bot.getUpdates({ offset: 9, timeoutSeconds: 1 });
    expect(updates.map((u) => u.update_id)).toEqual([9, 10]);
    expect(api.calls[0]?.body).toMatchObject({
      offset: 9,
      timeout: 1,
      allowed_updates: ["message", "my_chat_member"],
    });

    await bot.setWebhook("https://app.dev/api/notifications/telegram/webhook", "hook-secret");
    expect(api.calls[1]).toMatchObject({
      method: "setWebhook",
      body: {
        url: "https://app.dev/api/notifications/telegram/webhook",
        secret_token: "hook-secret",
      },
    });
  });

  it("gives a long poll a request budget longer than the poll itself", async () => {
    let seen: AbortSignal | undefined;
    const fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      seen = init?.signal ?? undefined;
      return Response.json({ ok: true, result: [] });
    }) as unknown as typeof globalThis.fetch;
    // A 1 s request timeout must not cut a 25 s poll short.
    await telegramBot({ token: TOKEN, fetch, timeoutMs: 1_000 }).getUpdates({ timeoutSeconds: 25 });
    expect(seen?.aborted).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    expect(seen?.aborted).toBe(false);
  });

  it("throws a redacted error when a management call fails", async () => {
    const api = fakeApi(() => apiError(401, `Unauthorized ${TOKEN}`));
    await expect(telegramBot({ token: TOKEN, fetch: api.fetch }).getMe()).rejects.toThrow(
      /getMe failed: Unauthorized <token>/,
    );
  });

  it("builds the deep link without the @ and with the code encoded", () => {
    expect(telegramStartLink("@my_bot", "a b")).toBe("https://t.me/my_bot?start=a%20b");
  });
});
