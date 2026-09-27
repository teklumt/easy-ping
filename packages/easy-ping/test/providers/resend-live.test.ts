import { describe, expect, it } from "vitest";
import { escapeHtml } from "../../src/core/html";
import { easyPing } from "../../src/core/instance";
import { ResendError, resend } from "../../src/providers/resend";
import { availableBackends } from "../helpers/backends";

// Resend's real API: rejection paths need no credentials; delivery needs RESEND_API_KEY and RESEND_FROM.

const message = (over: Record<string, unknown> = {}) => ({
  to: "delivered@resend.dev",
  subject: "easy-ping live check",
  html: "<p>live check</p>",
  idempotencyKey: `en_${crypto.randomUUID()}`,
  ...over,
});

const online = process.env.EASY_PING_OFFLINE !== "1";

describe.skipIf(!online)("resend provider against the real API", () => {
  it("a bad key is rejected as 401, and classified as never-retryable", async (ctx) => {
    const provider = resend({ apiKey: "re_invalid_key_for_testing", from: "Acme <hi@acme.dev>" });

    const error = await provider.send(message()).then(
      () => null,
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(ResendError);

    // No status means the request never landed, which says nothing about the
    // request shape this case exists to check. Skip rather than fail a release
    // on someone else's network.
    if ((error as ResendError).status === undefined) {
      ctx.skip();
      return;
    }

    // A structured 401 means the request was well-formed enough to authenticate
    // against. A 400 here would mean our body shape is wrong.
    expect((error as ResendError).status).toBe(401);

    // Burning five attempts on a revoked key helps nobody.
    expect(provider.isRetryable?.(error as Error)).toBe(false);
  }, 30_000);

  it("an unreachable host is retryable, since the request never landed", async () => {
    const provider = resend({
      apiKey: "re_x",
      from: "Acme <hi@acme.dev>",
      baseUrl: "https://resend.invalid",
    });

    const error = await provider.send(message()).then(
      () => null,
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(ResendError);
    expect((error as ResendError).status).toBeUndefined();
    expect(provider.isRetryable?.(error as Error)).toBe(true);
  }, 30_000);
});

const key = process.env.RESEND_API_KEY;
const from = process.env.RESEND_FROM;

describe.skipIf(!key || !from)("resend delivery with a real key", () => {
  it("accepts a send and returns a provider message id", async () => {
    if (!key || !from) throw new Error("missing credentials — this suite should have been skipped");
    const provider = resend({ apiKey: key, from });

    // delivered@resend.dev is Resend's own sink address unless RESEND_TO is set.
    const result = await provider.send(
      message({ to: process.env.RESEND_TO ?? "delivered@resend.dev" }),
    );

    expect(result.providerMessageId).toMatch(/.+/);
  }, 30_000);

  it("honours the idempotency key: the same delivery sent twice is one email", async () => {
    if (!key || !from) throw new Error("missing credentials — this suite should have been skipped");
    const provider = resend({ apiKey: key, from });
    const once = message({ to: process.env.RESEND_TO ?? "delivered@resend.dev" });

    const first = await provider.send(once);
    // A retry after a timeout re-sends with the same key; Resend must answer with the same email.
    const second = await provider.send(once);

    expect(second.providerMessageId).toBe(first.providerMessageId);
  }, 30_000);

  it("delivers end to end: send() -> cron sweep -> delivery marked sent", async () => {
    if (!key || !from) throw new Error("missing credentials — this suite should have been skipped");
    const sqlite = availableBackends.find((backend) => backend.name === "sqlite");
    if (!sqlite) throw new Error("sqlite backend missing");
    const db = await sqlite.create("resend-live");
    const to = process.env.RESEND_TO ?? "delivered@resend.dev";
    const cronSecret = "cron-secret-0123456789";

    try {
      const notify = easyPing({
        database: db.adapter,
        secret: "test-signing-secret-0123456789",
        cron: { secret: cronSecret },
        session: { getUserId: async () => "u1" },
        getRecipients: async (ids) =>
          ids.map((userId) => ({ userId, email: to, timezone: "UTC", locale: "en" })),
        notifications: {
          liveCheck: {
            channels: ["inApp", "email"],
            email: {
              subject: () => "easy-ping end-to-end live check",
              template: (p) =>
                `<p>Sent through the full pipeline for ${escapeHtml((p as { who: string }).who)}.</p>`,
            },
          },
        },
        channels: { inApp: { enabled: true }, email: { provider: resend({ apiKey: key, from }) } },
        delivery: { mode: "cron" },
        logger: { warn: () => {}, error: () => {} },
      });

      await notify.send("liveCheck", { to: "u1", payload: { who: "<the live suite>" } });
      const sweep = await notify.handler.POST(
        new Request("https://app.dev/api/notifications/cron", {
          method: "POST",
          headers: { authorization: `Bearer ${cronSecret}` },
        }),
      );
      expect(sweep.status).toBe(200);

      const deliveries = await db.rows("notification_delivery");
      const email = deliveries.find((row) => row.channel === "email");
      expect(email).toMatchObject({ status: "sent" });
      expect(email?.last_error ?? null).toBeNull();
    } finally {
      await db.end();
    }
  }, 60_000);
});
