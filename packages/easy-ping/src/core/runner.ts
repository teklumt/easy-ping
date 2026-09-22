import type { ClaimedDelivery, DatabaseAdapter, DeliveryOutcome, DeliveryRelease } from "./adapter";
import { type Backoff, nextAttemptAt } from "./backoff";
import type { ChannelsConfig, Worker } from "./config";
import type { NotificationDefinitions } from "./definition";
import type { Logger } from "./errors";
import type { AnyPlugin } from "./plugin";
import type { Channel, Recipient } from "./types";

export type RunnerDeps = {
  adapter: DatabaseAdapter;
  definitions: NotificationDefinitions;
  channels: ChannelsConfig;
  plugins: readonly AnyPlugin[];
  getRecipients: (userIds: readonly string[]) => Promise<readonly Recipient[]>;
  logger: Logger;
  leaseMs: number;
  batchSize: number;
  backoff: Backoff;
};

export type SweepResult = {
  claimed: number;
  sent: number;
  failed: number;
  /** Deliveries that had nothing to do. Not errors; see DeliveryOutcome. */
  skipped: number;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function withTimeout<T>(
  run: (signal: AbortSignal) => Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      // Abort first: racing a promise leaves the original request running.
      controller.abort();
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
  });

  try {
    return await Promise.race([run(controller.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * What gets persisted to `last_error`. Provider responses quote the offending
 * field, which for a bad recipient is the address itself; that column outlives
 * the notification and is read by admin tooling, so addresses do not go in.
 */
export const redactErrorMessage = (text: string) =>
  text.replace(/[^\s"'<>()[\]{},;]+@[^\s"'<>()[\]{},;]+/g, "[redacted-email]");

const message = (error: unknown) =>
  redactErrorMessage(error instanceof Error ? error.message : String(error));

export function createRunner(deps: RunnerDeps) {
  async function deliverOne(
    delivery: ClaimedDelivery,
    recipient: Recipient | undefined,
  ): Promise<DeliveryOutcome> {
    if (!recipient) {
      return { result: "failed", error: "recipient could not be resolved", retryable: false };
    }

    if (delivery.channel === "inApp") {
      // The notification row is the delivery. Nothing to transmit.
      return { result: "sent" };
    }

    if (delivery.channel === "email") {
      const provider = deps.channels.email?.provider;
      if (!provider) {
        return { result: "failed", error: "no email provider configured", retryable: false };
      }
      // Captured before the closure below: narrowing does not survive into it.
      const to = recipient.email;
      if (!to) {
        return { result: "failed", error: "recipient has no email address", retryable: false };
      }

      const email = deps.definitions[delivery.notification.type]?.email;
      if (!email) {
        return {
          result: "failed",
          error: `notification type "${delivery.notification.type}" has no email template`,
          retryable: false,
        };
      }

      try {
        const payload = delivery.notification.payload as never;
        const html = await email.template(payload);

        await withTimeout(
          (signal) =>
            provider.send({
              to,
              subject: email.subject(payload),
              html,
              // Delivery is at-least-once; the provider dedupes on this.
              idempotencyKey: delivery.id,
              signal,
            }),
          provider.timeoutMs ?? 30_000,
          `${provider.name} send`,
        );

        return { result: "sent" };
      } catch (error) {
        return {
          result: "failed",
          error: message(error),
          retryable: provider.isRetryable(error),
        };
      }
    }

    const owner = deps.plugins.find(
      (plugin) => plugin.channels?.includes(delivery.channel) && plugin.hooks?.deliver,
    );
    if (!owner?.hooks?.deliver) {
      return {
        result: "failed",
        error: `no plugin delivers channel "${delivery.channel}"`,
        retryable: false,
      };
    }

    try {
      return await withTimeout(
        (signal) =>
          Promise.resolve(
            // biome-ignore lint/style/noNonNullAssertion: guarded directly above
            owner.hooks!.deliver!({
              channel: delivery.channel,
              deliveryId: delivery.id,
              attempt: delivery.attempts + 1,
              recipient,
              notification: {
                id: delivery.notificationId,
                userId: delivery.notification.userId,
                type: delivery.notification.type,
                payload: delivery.notification.payload,
              },
              signal,
            }),
          ),
        30_000,
        `plugin "${owner.id}" deliver`,
      );
    } catch (error) {
      return { result: "failed", error: message(error), retryable: true };
    }
  }

  async function notifyAfterDeliver(delivery: ClaimedDelivery, outcome: DeliveryOutcome) {
    const isTerminal =
      outcome.result !== "failed" ||
      !outcome.retryable ||
      delivery.attempts + 1 >= delivery.maxAttempts;

    for (const plugin of deps.plugins) {
      const hook = plugin.hooks?.afterDeliver;
      if (!hook) continue;
      try {
        await hook({
          deliveryId: delivery.id,
          notificationId: delivery.notificationId,
          userId: delivery.notification.userId,
          channel: delivery.channel,
          outcome,
          attempt: delivery.attempts + 1,
          isTerminal,
        });
      } catch (error) {
        // Fail open. The message is already sent; a broken analytics hook must
        // not mark it failed and trigger a retry. RFC 0004 §5.
        deps.logger.error(`plugin "${plugin.id}" afterDeliver threw; ignoring`, {
          deliveryId: delivery.id,
          error,
        });
      }
    }
  }

  async function runOnce(
    options: { limit?: number; channels?: readonly Channel[]; ids?: readonly string[] } = {},
  ): Promise<SweepResult> {
    const claimToken = crypto.randomUUID();

    const claimed = await deps.adapter.claimPendingDeliveries({
      limit: options.limit ?? deps.batchSize,
      leaseMs: deps.leaseMs,
      claimToken,
      ...(options.channels ? { channels: options.channels } : {}),
      ...(options.ids ? { ids: options.ids } : {}),
    });

    if (claimed.length === 0) return { claimed: 0, sent: 0, failed: 0, skipped: 0 };

    const userIds = [...new Set(claimed.map((row) => row.notification.userId))];
    const recipients = await deps.getRecipients(userIds);
    const byUserId = new Map(recipients.map((recipient) => [recipient.userId, recipient]));

    const releases: DeliveryRelease[] = [];
    let sent = 0;
    let failed = 0;
    let skipped = 0;

    for (const delivery of claimed) {
      const outcome = await deliverOne(delivery, byUserId.get(delivery.notification.userId));

      if (outcome.result === "sent") sent += 1;
      else if (outcome.result === "skipped") skipped += 1;
      else failed += 1;

      releases.push({
        id: delivery.id,
        claimToken,
        outcome,
        ...(outcome.result === "failed" && outcome.retryable
          ? { nextAttemptAt: nextAttemptAt(delivery.attempts + 1, deps.backoff) }
          : {}),
      });

      await notifyAfterDeliver(delivery, outcome);
    }

    await deps.adapter.releaseDeliveries(releases);
    return { claimed: claimed.length, sent, failed, skipped };
  }

  /** Drains until empty. Pass `ids` to bound it to one send. */
  async function drain(
    options: { maxSweeps?: number; ids?: readonly string[] } = {},
  ): Promise<SweepResult> {
    const maxSweeps = options.maxSweeps ?? 50;
    const total: SweepResult = { claimed: 0, sent: 0, failed: 0, skipped: 0 };

    for (let sweep = 0; sweep < maxSweeps; sweep += 1) {
      const result = await runOnce(options.ids ? { ids: options.ids } : {});
      total.claimed += result.claimed;
      total.sent += result.sent;
      total.failed += result.failed;
      total.skipped += result.skipped;
      if (result.claimed === 0) break;
    }

    return total;
  }

  let warnedMissingWaitUntil = false;

  function scheduleDeferred(
    waitUntil?: (promise: Promise<unknown>) => void,
    ids?: readonly string[],
  ): void {
    if (waitUntil) {
      waitUntil(
        drain({ maxSweeps: 10, ...(ids ? { ids } : {}) }).catch((error) =>
          deps.logger.error("deferred sweep failed", { error }),
        ),
      );
      return;
    }

    if (!warnedMissingWaitUntil) {
      warnedMissingWaitUntil = true;
      deps.logger.warn(
        "delivery.mode is 'deferred' but no delivery.waitUntil was supplied — " +
          "falling back to the cron sweep. Notifications are not lost, but they " +
          "will not be delivered until POST /cron runs.",
      );
    }
  }

  function startWorker(options: { intervalMs?: number; batchSize?: number } = {}): Worker {
    const intervalMs = options.intervalMs ?? 1_000;
    let stopped = false;

    const loop = (async () => {
      while (!stopped) {
        try {
          const result = await runOnce({ limit: options.batchSize ?? deps.batchSize });
          // Only idle when there was nothing to do; otherwise keep draining.
          if (result.claimed === 0) await sleep(intervalMs);
        } catch (error) {
          deps.logger.error("worker sweep failed", { error });
          await sleep(intervalMs);
        }
      }
    })();

    return {
      stop: async () => {
        stopped = true;
        // Awaiting the loop lets the in-flight sweep finish and release its
        // leases, rather than leaving rows claimed until they expire.
        await loop;
      },
    };
  }

  return { runOnce, drain, scheduleDeferred, startWorker };
}

export type Runner = ReturnType<typeof createRunner>;
