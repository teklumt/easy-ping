import type { DatabaseAdapter, InsertNotification } from "../core/adapter";
import type { Channel } from "../core/types";

export type ConformanceContext = {
  adapter: DatabaseAdapter;
  /**
   * Forces a delivery's attempt count. Not reachable through the public API —
   * the adapter would have marked the row failed on the way there — so each
   * backend writes it directly.
   */
  setAttempts: (deliveryId: string, attempts: number) => Promise<void>;
  /**
   * Empties the tables. Cases must run against a clean table: claims are
   * ordered by not_before ASC and bounded by limit, so leftover rows from an
   * earlier case can push the row under test out of the claim window.
   */
  reset: () => Promise<void>;
  /**
   * Holds a row lock on a separate connection for the duration of `fn`.
   *
   * Required to test SKIP LOCKED deterministically. Two Promise.all'd claims
   * do not reliably overlap — they complete in single-digit milliseconds and
   * simply queue — so a race-based test passes even with no locking at all.
   *
   * Only meaningful where a claim can block on someone else's lock. A document
   * store whose claim is a single atomic update has nothing to skip, so cases
   * tagged `rowLock` do not apply to it.
   */
  lockRow?: (deliveryId: string, fn: () => Promise<void>) => Promise<void>;
};

export type ConformanceCase = {
  name: string;
  /** Capability the case needs; a backend without it must filter the case out. */
  requires?: "rowLock";
  run: (ctx: ConformanceContext) => Promise<void>;
};

class ConformanceError extends Error {}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new ConformanceError(message);
}

const equal = (actual: unknown, expected: unknown, message: string) =>
  assert(actual === expected, `${message} (got ${String(actual)}, expected ${String(expected)})`);

let counter = 0;
function uid(label: string): string {
  counter += 1;
  return `${label}_${Date.now().toString(36)}_${counter}`;
}

type SeedOptions = {
  count?: number;
  notBefore?: Date;
  maxAttempts?: number;
  channel?: Channel;
  dedupeKey?: string;
  userId?: string;
};

async function seed(ctx: ConformanceContext, options: SeedOptions = {}) {
  const count = options.count ?? 1;
  const userId = options.userId ?? uid("user");

  const rows: InsertNotification[] = Array.from({ length: count }, () => {
    const id = uid("notif");
    return {
      id,
      userId,
      type: "commentReply",
      payload: { authorName: "Dana" },
      ...(options.dedupeKey ? { dedupeKey: options.dedupeKey } : {}),
      deliveries: [
        {
          id: uid("delivery"),
          channel: options.channel ?? "email",
          maxAttempts: options.maxAttempts ?? 5,
          notBefore: options.notBefore ?? new Date(Date.now() - 1000),
        },
      ],
    };
  });

  const result = await ctx.adapter.createNotifications(rows);
  return { userId, rows, result };
}

const CLAIM = { limit: 10, leaseMs: 60_000 };

export const adapterConformanceCases: readonly ConformanceCase[] = [
  {
    /**
     * The case that actually distinguishes a correct adapter.
     *
     * A row locked by another transaction must be *skipped*, not waited on.
     * Without SKIP LOCKED the claim blocks until the holder commits, which on
     * a busy table serialises every worker behind the slowest one.
     */
    name: "a row locked by another transaction is skipped, not waited on",
    requires: "rowLock",
    run: async (ctx) => {
      const { lockRow } = ctx;
      assert(lockRow, "case requires lockRow");

      const { rows } = await seed(ctx, { count: 2 });
      const locked = rows[0]?.deliveries[0]?.id;
      const free = rows[1]?.deliveries[0]?.id;
      assert(locked && free, "seed produced too few deliveries");

      await lockRow(locked, async () => {
        const claimed = await Promise.race([
          ctx.adapter.claimPendingDeliveries({ ...CLAIM, claimToken: uid("token") }),
          new Promise<never>((_, reject) =>
            setTimeout(
              () =>
                reject(
                  new ConformanceError(
                    "claim blocked on a row locked by another transaction — SKIP LOCKED is missing",
                  ),
                ),
              2_000,
            ),
          ),
        ]);

        const ids = new Set(claimed.map((row) => row.id));
        assert(!ids.has(locked), "claimed a row locked by another transaction");
        assert(ids.has(free), "skipped an unlocked row alongside the locked one");
      });
    },
  },

  {
    name: "concurrent claims return disjoint sets",
    run: async (ctx) => {
      await seed(ctx, { count: 40 });

      // Eight callers over 40 rows, repeated — a single Promise.all pair is
      // too fast to overlap and proves nothing on its own.
      const claimed = await Promise.all(
        Array.from({ length: 8 }, () =>
          ctx.adapter.claimPendingDeliveries({ limit: 5, leaseMs: 60_000, claimToken: uid("t") }),
        ),
      );

      const all = claimed.flatMap((batch) => batch.map((row) => row.id));
      equal(new Set(all).size, all.length, "the same delivery was claimed by two callers");
      assert(all.length <= 40, "claimed more rows than exist");
    },
  },

  {
    name: "a claimed row is invisible before its lease expires",
    run: async (ctx) => {
      const { rows } = await seed(ctx);
      const target = rows[0]?.deliveries[0]?.id;

      const first = await ctx.adapter.claimPendingDeliveries({ ...CLAIM, claimToken: uid("t") });
      assert(
        first.some((row) => row.id === target),
        "seeded delivery was not claimed",
      );

      const second = await ctx.adapter.claimPendingDeliveries({ ...CLAIM, claimToken: uid("t") });
      assert(!second.some((row) => row.id === target), "leased row was claimed twice");
    },
  },

  {
    name: "a claimed row is re-claimable after its lease expires",
    run: async (ctx) => {
      const { rows } = await seed(ctx);
      const target = rows[0]?.deliveries[0]?.id;

      await ctx.adapter.claimPendingDeliveries({ ...CLAIM, claimToken: uid("t") });

      const later = new Date(Date.now() + CLAIM.leaseMs + 5_000);
      const reclaimed = await ctx.adapter.claimPendingDeliveries({
        ...CLAIM,
        claimToken: uid("t"),
        now: later,
      });

      assert(
        reclaimed.some((row) => row.id === target),
        "expired lease was not reclaimed",
      );
    },
  },

  {
    name: "not_before in the future is never claimed",
    run: async (ctx) => {
      const { rows } = await seed(ctx, { notBefore: new Date(Date.now() + 3_600_000) });
      const target = rows[0]?.deliveries[0]?.id;

      const claimed = await ctx.adapter.claimPendingDeliveries({ ...CLAIM, claimToken: uid("t") });
      assert(!claimed.some((row) => row.id === target), "claimed a delivery before its not_before");
    },
  },

  {
    name: "attempts at or beyond max_attempts is never claimed",
    run: async (ctx) => {
      const { rows } = await seed(ctx, { maxAttempts: 3 });
      const target = rows[0]?.deliveries[0]?.id;
      assert(target, "seed produced no delivery");

      await ctx.setAttempts(target, 3);

      const claimed = await ctx.adapter.claimPendingDeliveries({ ...CLAIM, claimToken: uid("t") });
      assert(!claimed.some((row) => row.id === target), "claimed an exhausted delivery");
    },
  },

  {
    name: "claims are ordered by not_before ascending",
    run: async (ctx) => {
      const userId = uid("user");
      const older = uid("delivery");
      const newer = uid("delivery");

      await ctx.adapter.createNotifications([
        {
          id: uid("notif"),
          userId,
          type: "t",
          payload: {},
          deliveries: [
            {
              id: newer,
              channel: "email",
              maxAttempts: 5,
              notBefore: new Date(Date.now() - 1_000),
            },
          ],
        },
        {
          id: uid("notif"),
          userId,
          type: "t",
          payload: {},
          deliveries: [
            {
              id: older,
              channel: "email",
              maxAttempts: 5,
              notBefore: new Date(Date.now() - 600_000),
            },
          ],
        },
      ]);

      const claimed = await ctx.adapter.claimPendingDeliveries({
        limit: 1,
        leaseMs: 60_000,
        claimToken: uid("t"),
      });

      equal(claimed[0]?.id, older, "oldest eligible delivery was not claimed first");
    },
  },

  {
    name: "release with a stale token still writes the terminal state",
    run: async (ctx) => {
      const { rows } = await seed(ctx);
      const target = rows[0]?.deliveries[0]?.id;
      assert(target, "seed produced no delivery");

      await ctx.adapter.claimPendingDeliveries({ ...CLAIM, claimToken: uid("real") });

      await ctx.adapter.releaseDeliveries([
        {
          id: target,
          claimToken: "a-token-that-never-held-this-lease",
          outcome: { result: "sent" },
        },
      ]);

      const stillClaimable = await ctx.adapter.claimPendingDeliveries({
        ...CLAIM,
        claimToken: uid("t"),
        now: new Date(Date.now() + CLAIM.leaseMs + 5_000),
      });

      assert(
        !stillClaimable.some((row) => row.id === target),
        "row stayed claimable after being marked sent",
      );
    },
  },

  {
    name: "retryable failure re-arms; non-retryable fails immediately",
    run: async (ctx) => {
      const retry = await seed(ctx, { maxAttempts: 5 });
      const retryId = retry.rows[0]?.deliveries[0]?.id;
      assert(retryId, "seed produced no delivery");

      await ctx.adapter.claimPendingDeliveries({ ...CLAIM, claimToken: uid("t") });

      const soon = new Date(Date.now() + 30_000);
      await ctx.adapter.releaseDeliveries([
        {
          id: retryId,
          claimToken: "t",
          outcome: { result: "failed", error: "smtp timeout", retryable: true },
          nextAttemptAt: soon,
        },
      ]);

      const tooEarly = await ctx.adapter.claimPendingDeliveries({ ...CLAIM, claimToken: uid("t") });
      assert(
        !tooEarly.some((row) => row.id === retryId),
        "re-armed delivery was claimable before its backoff elapsed",
      );

      const afterBackoff = await ctx.adapter.claimPendingDeliveries({
        ...CLAIM,
        claimToken: uid("t"),
        now: new Date(soon.getTime() + 1_000),
      });
      assert(
        afterBackoff.some((row) => row.id === retryId),
        "re-armed delivery never became claimable",
      );

      const terminal = await seed(ctx, { maxAttempts: 5 });
      const terminalId = terminal.rows[0]?.deliveries[0]?.id;
      assert(terminalId, "seed produced no delivery");

      await ctx.adapter.claimPendingDeliveries({ ...CLAIM, claimToken: uid("t") });
      await ctx.adapter.releaseDeliveries([
        {
          id: terminalId,
          claimToken: "t",
          outcome: { result: "failed", error: "invalid api key", retryable: false },
        },
      ]);

      const failed = await ctx.adapter.getFailedDeliveries({
        since: new Date(Date.now() - 60_000),
        limit: 50,
      });
      assert(
        failed.some((row) => row.id === terminalId),
        "non-retryable failure did not land in failed",
      );
    },
  },

  {
    name: "duplicate dedupeKey is skipped, not thrown",
    run: async (ctx) => {
      const userId = uid("user");
      const key = uid("dedupe");

      const first = await seed(ctx, { userId, dedupeKey: key });
      equal(first.result.created.length, 1, "first insert was not created");

      const second = await seed(ctx, { userId, dedupeKey: key });
      equal(second.result.created.length, 0, "duplicate was created");
      equal(second.result.deduped.length, 1, "duplicate was not reported as deduped");
    },
  },

  {
    name: "notifications with no dedupeKey never collide",
    run: async (ctx) => {
      const userId = uid("user");
      const result = await seed(ctx, { userId, count: 3 });
      equal(result.result.created.length, 3, "undeduped notifications collided");
    },
  },

  {
    name: "markRead is scoped to the owning user",
    run: async (ctx) => {
      const owner = uid("user");
      const { rows } = await seed(ctx, { userId: owner });
      const notificationId = rows[0]?.id;
      assert(notificationId, "seed produced no notification");

      const stolen = await ctx.adapter.markRead(uid("attacker"), [notificationId]);
      equal(stolen, 0, "another user marked a notification read");

      const own = await ctx.adapter.markRead(owner, [notificationId]);
      equal(own, 1, "owner could not mark their own notification read");
    },
  },

  {
    name: "unseen count and markSeen agree",
    run: async (ctx) => {
      const userId = uid("user");
      await seed(ctx, { userId, count: 3 });

      equal(await ctx.adapter.countUnseen(userId), 3, "unseen count wrong before markSeen");

      await ctx.adapter.markSeen(userId, new Date());
      equal(await ctx.adapter.countUnseen(userId), 0, "unseen count wrong after markSeen");
    },
  },

  {
    /**
     * createdAt must come from the same clock as the cutoff it is compared to.
     *
     * An adapter that leaves createdAt to a database DEFAULT now() is comparing
     * the database clock against the application clock. On one machine they
     * agree and this never fails; in production they are different hosts, and a
     * database a second ahead means markSeen(now) silently misses the newest
     * notifications and the unseen badge never clears. Found when a laptop
     * resumed from sleep with its Docker VM 6s ahead.
     */
    name: "createdAt comes from the caller clock, not the database clock",
    run: async (ctx) => {
      const userId = uid("user");
      const before = new Date();
      await seed(ctx, { userId, count: 1 });
      const after = new Date();

      const { notifications } = await ctx.adapter.listNotifications({ userId, limit: 10 });
      const createdAt = notifications[0]?.createdAt;
      assert(createdAt, "seed produced no notification");

      // A second of slack for a slow round trip, far under the skew that breaks
      // markSeen but tight enough to catch a foreign clock.
      const skewMs = Math.max(
        before.getTime() - createdAt.getTime(),
        createdAt.getTime() - after.getTime(),
      );
      assert(
        skewMs <= 1_000,
        `createdAt is ${skewMs}ms outside the window the caller observed — it is coming from another clock`,
      );
    },
  },
];
