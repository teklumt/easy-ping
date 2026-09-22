import type { StandardSchemaV1 } from "@standard-schema/spec";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseAdapter } from "../src/core/adapter";
import type { ChannelsConfig } from "../src/core/config";
import type { NotificationDefinitions } from "../src/core/definition";
import type { Logger } from "../src/core/errors";
import { ValidationError } from "../src/core/errors";
import type { AnyPlugin } from "../src/core/plugin";
import type { EmailMessage, EmailProvider } from "../src/core/provider";
import { createRunner } from "../src/core/runner";
import { runSend } from "../src/core/send";
import type { Recipient } from "../src/core/types";
import { createTestDatabase, postgresReachable, type TestDatabase } from "./helpers/pg";

type CommentReply = { authorName: string; commentId: string };

const commentReplySchema: StandardSchemaV1<CommentReply, CommentReply> = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate: (value) => {
      const candidate = value as Partial<CommentReply>;
      if (typeof candidate?.authorName !== "string") {
        return { issues: [{ message: "authorName must be a string" }] };
      }
      return { value: candidate as CommentReply };
    },
    types: { input: {} as CommentReply, output: {} as CommentReply },
  },
};

const definitions: NotificationDefinitions = {
  commentReply: {
    schema: commentReplySchema,
    channels: ["inApp", "email"],
    email: {
      subject: (p) => `${(p as CommentReply).authorName} replied`,
      template: (p) => `<p>${(p as CommentReply).commentId}</p>`,
    },
  },
  inAppOnly: { channels: ["inApp"] },
  emailOnly: {
    schema: commentReplySchema,
    channels: ["email"],
    email: {
      subject: (p) => `${(p as CommentReply).authorName} replied`,
      template: (p) => `<p>${(p as CommentReply).commentId}</p>`,
    },
  },
};

class RetryableError extends Error {
  readonly retryable = true;
}

function fakeProvider(onSend?: (message: EmailMessage) => void) {
  const sent: EmailMessage[] = [];
  const provider: EmailProvider = {
    name: "fake",
    send: async (message) => {
      sent.push(message);
      onSend?.(message);
      return {};
    },
    isRetryable: (error) => error instanceof RetryableError,
  };
  return { provider, sent };
}

function collectingLogger() {
  const errors: string[] = [];
  const warnings: string[] = [];
  const logger: Logger = {
    error: (message) => void errors.push(message),
    warn: (message) => void warnings.push(message),
  };
  return { logger, errors, warnings };
}

const recipient = (userId: string, email?: string): Recipient => ({
  userId,
  ...(email ? { email } : {}),
  timezone: "UTC",
  locale: "en",
});

let db: TestDatabase;
let adapter: DatabaseAdapter;

const available = await postgresReachable();

describe.skipIf(!available)("send pipeline and delivery runner", () => {
  beforeAll(async () => {
    db = await createTestDatabase("pipeline");
    adapter = db.adapter;
  });

  afterAll(async () => {
    await db.end();
  });

  beforeEach(async () => {
    await db.truncate();
  });

  const deps = (overrides: Partial<Parameters<typeof runSend>[2]> = {}) => ({
    adapter,
    definitions,
    channels: { inApp: { enabled: true } } satisfies ChannelsConfig as ChannelsConfig,
    plugins: [] as readonly AnyPlugin[],
    getRecipients: async (ids: readonly string[]) => ids.map((id) => recipient(id, `${id}@x.dev`)),
    maxAttempts: 5,
    logger: collectingLogger().logger,
    ...overrides,
  });

  it("writes a notification and its deliveries, and returns them", async () => {
    const { provider } = fakeProvider();
    const result = await runSend(
      "commentReply",
      { to: "u1", payload: { authorName: "Dana", commentId: "c1" } },
      deps({ channels: { inApp: { enabled: true }, email: { provider } } }),
    );

    expect(result.notifications).toHaveLength(1);
    expect(result.notifications[0]?.deliveries.map((d) => d.channel).sort()).toEqual([
      "email",
      "inApp",
    ]);
    expect(result.skipped).toEqual([]);
  });

  it("throws ValidationError on a bad payload — developer error, not a delivery failure", async () => {
    await expect(
      runSend("commentReply", { to: "u1", payload: { authorName: 42 } }, deps()),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("throws on an unknown notification type", async () => {
    await expect(runSend("nope", { to: "u1", payload: {} }, deps())).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it("drops a channel that has no provider configured", async () => {
    const result = await runSend(
      "commentReply",
      { to: "u1", payload: { authorName: "Dana", commentId: "c1" } },
      deps(),
    );
    expect(result.notifications[0]?.deliveries.map((d) => d.channel)).toEqual(["inApp"]);
  });

  it("skips a recipient that cannot be resolved", async () => {
    const result = await runSend(
      "inAppOnly",
      { to: ["u1", "ghost"], payload: {} },
      deps({ getRecipients: async () => [recipient("u1", "u1@x.dev")] }),
    );

    expect(result.notifications).toHaveLength(1);
    expect(result.skipped).toEqual([{ userId: "ghost", reason: "no-recipient" }]);
  });

  it("reports a duplicate dedupeKey as skipped rather than throwing", async () => {
    const args = { to: "u1", payload: {}, dedupeKey: "once" } as const;
    await runSend("inAppOnly", args, deps());
    const second = await runSend("inAppOnly", args, deps());

    expect(second.notifications).toHaveLength(0);
    expect(second.skipped).toEqual([{ userId: "u1", reason: "deduped" }]);
  });

  it("cancels the send when a beforeSend hook throws (fail closed)", async () => {
    const { logger, errors } = collectingLogger();
    const exploding: AnyPlugin = {
      id: "broken",
      hooks: {
        beforeSend: () => {
          throw new Error("boom");
        },
      },
    };

    const result = await runSend(
      "inAppOnly",
      { to: "u1", payload: {} },
      deps({ plugins: [exploding], logger }),
    );

    expect(result.notifications).toHaveLength(0);
    expect(result.skipped).toEqual([{ userId: "u1", reason: "no-channels" }]);
    expect(errors[0]).toContain("beforeSend threw");
  });

  it("honours a resolveChannels skip", async () => {
    const { provider } = fakeProvider();
    const noEmail: AnyPlugin = {
      id: "no-email",
      hooks: {
        resolveChannels: (ctx) =>
          ctx.decisions.map((d) => (d.channel === "email" ? { ...d, action: "skip" as const } : d)),
      },
    };

    const result = await runSend(
      "commentReply",
      { to: "u1", payload: { authorName: "Dana", commentId: "c1" } },
      deps({ channels: { inApp: { enabled: true }, email: { provider } }, plugins: [noEmail] }),
    );

    expect(result.notifications[0]?.deliveries.map((d) => d.channel)).toEqual(["inApp"]);
  });

  it("defers a channel by pushing not_before into the future", async () => {
    const quietHours: AnyPlugin = {
      id: "quiet",
      hooks: {
        resolveChannels: (ctx) =>
          ctx.decisions.map((d) => ({
            ...d,
            action: "defer" as const,
            notBefore: new Date(Date.now() + 3_600_000),
          })),
      },
    };

    await runSend("inAppOnly", { to: "u1", payload: {} }, deps({ plugins: [quietHours] }));

    const claimed = await adapter.claimPendingDeliveries({
      limit: 10,
      leaseMs: 60_000,
      claimToken: "t",
    });
    expect(claimed).toHaveLength(0);
  });

  describe("runner", () => {
    const runnerDeps = (channels: ChannelsConfig, plugins: readonly AnyPlugin[] = []) => ({
      adapter,
      definitions,
      channels,
      plugins,
      getRecipients: async (ids: readonly string[]) =>
        ids.map((id) => recipient(id, `${id}@x.dev`)),
      logger: collectingLogger().logger,
      leaseMs: 60_000,
      batchSize: 20,
      backoff: "exponential" as const,
    });

    it("marks inApp deliveries sent without touching a provider", async () => {
      await runSend("inAppOnly", { to: "u1", payload: {} }, deps());
      const result = await createRunner(runnerDeps({ inApp: { enabled: true } })).runOnce();

      expect(result).toEqual({ claimed: 1, sent: 1, failed: 0, skipped: 0 });
    });

    it("sends email with the delivery id as the idempotency key", async () => {
      const { provider, sent } = fakeProvider();
      const channels: ChannelsConfig = { inApp: { enabled: true }, email: { provider } };

      const result = await runSend(
        "commentReply",
        { to: "u1", payload: { authorName: "Dana", commentId: "c1" } },
        deps({ channels }),
      );
      const emailDelivery = result.notifications[0]?.deliveries.find((d) => d.channel === "email");

      await createRunner(runnerDeps(channels)).runOnce();

      expect(sent).toHaveLength(1);
      expect(sent[0]?.subject).toBe("Dana replied");
      expect(sent[0]?.html).toBe("<p>c1</p>");
      expect(sent[0]?.idempotencyKey).toBe(emailDelivery?.id);
    });

    it("re-arms a retryable failure behind a backoff, then delivers it", async () => {
      let attempts = 0;
      const provider: EmailProvider = {
        name: "flaky",
        send: async () => {
          attempts += 1;
          if (attempts === 1) throw new RetryableError("smtp hiccup");
          return {};
        },
        isRetryable: (error) => error instanceof RetryableError,
      };
      const channels: ChannelsConfig = { email: { provider } };

      await runSend(
        "emailOnly",
        { to: "u1", payload: { authorName: "Dana", commentId: "c1" } },
        deps({ channels }),
      );

      const runner = createRunner(runnerDeps(channels));
      expect(await runner.runOnce()).toMatchObject({ failed: 1, sent: 0 });

      // Immediately retrying must find nothing — the backoff has not elapsed.
      expect(await runner.runOnce()).toMatchObject({ claimed: 0 });

      const claimed = await adapter.claimPendingDeliveries({
        limit: 10,
        leaseMs: 60_000,
        claimToken: "t",
        now: new Date(Date.now() + 3_600_000),
      });
      expect(claimed).toHaveLength(1);
      expect(claimed[0]?.attempts).toBe(1);
    });

    it("fails a non-retryable error terminally on the first attempt", async () => {
      const provider: EmailProvider = {
        name: "broken",
        send: async () => {
          throw new Error("invalid api key");
        },
        isRetryable: () => false,
      };
      const channels: ChannelsConfig = { email: { provider } };

      await runSend(
        "emailOnly",
        { to: "u1", payload: { authorName: "Dana", commentId: "c1" } },
        deps({ channels }),
      );
      await createRunner(runnerDeps(channels)).runOnce();

      const failed = await adapter.getFailedDeliveries({
        since: new Date(Date.now() - 60_000),
        limit: 10,
      });
      expect(failed).toHaveLength(1);
      expect(failed[0]?.attempts).toBe(1);
      expect(failed[0]?.lastError).toContain("invalid api key");
    });

    it("keeps a delivery sent when an afterDeliver hook throws (fail open)", async () => {
      const { logger, errors } = collectingLogger();
      const exploding: AnyPlugin = {
        id: "analytics",
        hooks: {
          afterDeliver: () => {
            throw new Error("tracking down");
          },
        },
      };

      await runSend("inAppOnly", { to: "u1", payload: {} }, deps());
      const result = await createRunner({
        ...runnerDeps({ inApp: { enabled: true } }, [exploding]),
        logger,
      }).runOnce();

      expect(result).toMatchObject({ sent: 1, failed: 0 });
      expect(errors[0]).toContain("afterDeliver threw");
    });

    it("drain empties the queue across sweeps", async () => {
      for (let i = 0; i < 5; i += 1) {
        await runSend("inAppOnly", { to: `u${i}`, payload: {} }, deps());
      }

      const runner = createRunner({ ...runnerDeps({ inApp: { enabled: true } }), batchSize: 2 });
      expect(await runner.drain()).toMatchObject({ claimed: 5, sent: 5 });
    });

    it("worker delivers and stop() waits for the in-flight sweep", async () => {
      await runSend("inAppOnly", { to: "u1", payload: {} }, deps());

      const runner = createRunner(runnerDeps({ inApp: { enabled: true } }));
      const worker = runner.startWorker({ intervalMs: 10 });

      await new Promise((resolve) => setTimeout(resolve, 150));
      await worker.stop();

      expect(await adapter.countUnseen("u1")).toBe(1);
      expect(await runner.runOnce()).toMatchObject({ claimed: 0 });
    });

    it("deferred without waitUntil warns once and leaves work for the cron", async () => {
      const { logger, warnings } = collectingLogger();
      const runner = createRunner({ ...runnerDeps({ inApp: { enabled: true } }), logger });

      runner.scheduleDeferred(undefined);
      runner.scheduleDeferred(undefined);

      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("falling back to the cron sweep");
    });

    it("deferred with waitUntil hands the sweep to the platform", async () => {
      await runSend("inAppOnly", { to: "u1", payload: {} }, deps());

      const pending: Promise<unknown>[] = [];
      const runner = createRunner(runnerDeps({ inApp: { enabled: true } }));
      runner.scheduleDeferred((promise) => void pending.push(promise));

      await Promise.all(pending);
      expect(await runner.runOnce()).toMatchObject({ claimed: 0 });
    });
  });
});
