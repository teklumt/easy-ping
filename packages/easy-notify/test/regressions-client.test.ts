import { describe, expect, it } from "vitest";
import { createNotifyClient } from "../src/client";
import type { NotificationDefinitions } from "../src/core/definition";
import { easyNotify } from "../src/core/instance";
import type { EmailProvider } from "../src/core/provider";
import { createRunner } from "../src/core/runner";
import type { Recipient } from "../src/core/types";
import { createTestDatabase, postgresReachable, type TestDatabase } from "./helpers/pg";

const silent = { warn: () => {}, error: () => {} };

const recipient = (userId: string): Recipient => ({
  userId,
  email: `${userId}@x.dev`,
  timezone: "UTC",
  locale: "en",
});

describe("BUG E: concurrent loadMore must not duplicate rows", () => {
  it("guards against a double click", async () => {
    // Keyed off the cursor, not a counter: two concurrent loadMore calls read
    // the same cursor and must not both append the same page.
    const fetch = (async (url: string | URL) => {
      const path = String(url);
      if (path.includes("/count")) return Response.json({ unseen: 0 });

      const cursor = new URL(path).searchParams.get("cursor");
      const start = cursor ? Number(cursor) : 0;
      return Response.json({
        notifications: [start, start + 1].map((n) => ({
          id: `n${n}`,
          userId: "u1",
          type: "t",
          payload: {},
          actorId: null,
          groupKey: null,
          seenAt: null,
          readAt: null,
          createdAt: "2026-01-01T00:00:00.000Z",
        })),
        nextCursor: String(start + 2),
      });
    }) as unknown as typeof globalThis.fetch;

    const client = createNotifyClient({
      fetch,
      baseUrl: "https://app.dev/api/notifications",
      isDocumentHidden: () => false,
    });

    const unsubscribe = client.subscribe(() => {});
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Two clicks before the first response lands.
    await Promise.all([client.loadMore(), client.loadMore()]);

    const ids = client.getState().notifications.map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
    unsubscribe();
  });
});

describe("BUG F: a provider timeout must abort the in-flight request", () => {
  it("signals abort rather than leaking the request", async () => {
    let sawAbort = false;

    const provider: EmailProvider = {
      name: "slow",
      timeoutMs: 50,
      send: async (message) => {
        message.signal?.addEventListener("abort", () => {
          sawAbort = true;
        });
        await new Promise((resolve) => setTimeout(resolve, 500));
        return {};
      },
      isRetryable: () => true,
    };

    const runner = createRunner({
      adapter: {
        name: "stub",
        claimPendingDeliveries: async () => [
          {
            id: "d1",
            notificationId: "n1",
            channel: "email" as const,
            attempts: 0,
            maxAttempts: 5,
            notification: { userId: "u1", type: "t", payload: {}, actorId: null },
          },
        ],
        releaseDeliveries: async () => {},
        createNotifications: async () => ({ created: [], deduped: [] }),
        listNotifications: async () => ({ notifications: [], nextCursor: null }),
        countUnseen: async () => 0,
        markSeen: async () => {},
        markRead: async () => 0,
        markAllRead: async () => 0,
        getFailedDeliveries: async () => [],
        queryTable: async () => [],
        insertRows: async () => 0,
        updateRows: async () => 0,
        deleteRows: async () => 0,
      },
      definitions: {
        t: { channels: ["email"], email: { subject: () => "s", template: () => "h" } },
      } satisfies NotificationDefinitions,
      channels: { email: { provider } },
      plugins: [],
      getRecipients: async (ids) => ids.map(recipient),
      logger: silent,
      leaseMs: 60_000,
      batchSize: 1,
      backoff: "exponential",
    });

    await runner.runOnce();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(sawAbort).toBe(true);
  });
});

const available = await postgresReachable();
let db: TestDatabase;

describe.skipIf(!available)("BUG G / BUG I: request hardening and seen semantics", () => {
  const definitions = { ping: { channels: ["inApp"] } } satisfies NotificationDefinitions;

  const build = () =>
    easyNotify({
      database: db.adapter,
      secret: "s",
      cron: { secret: "c" },
      session: { getUserId: async () => "u1" },
      getRecipients: async (ids) => ids.map(recipient),
      notifications: definitions,
      channels: { inApp: { enabled: true } },
      delivery: { mode: "cron" },
      logger: silent,
    });

  it("BUG G: caps an oversized ids array instead of building an unbounded query", async () => {
    db ??= await createTestDatabase("bugprobe2");
    const notify = build();

    const response = await notify.handler.POST(
      new Request("https://app.dev/api/notifications/read", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids: Array.from({ length: 5_000 }, (_, i) => `id${i}`) }),
      }),
    );

    expect(response.status).toBe(400);
    await db.end();
  });
});
