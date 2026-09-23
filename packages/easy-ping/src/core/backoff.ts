/** Exponential backoff with ±20% jitter, floored by the sweep interval. RFC 0001 §4. */
const SCHEDULE_MS = [30_000, 120_000, 480_000, 1_920_000] as const;

export type Backoff = "exponential" | ((attempt: number) => number);

export function backoffMs(attempt: number, strategy: Backoff = "exponential"): number {
  if (typeof strategy === "function") return Math.max(0, strategy(attempt));

  const index = Math.min(Math.max(attempt, 1), SCHEDULE_MS.length) - 1;
  const base = SCHEDULE_MS[index] ?? SCHEDULE_MS[SCHEDULE_MS.length - 1] ?? 30_000;
  return Math.round(base * (0.8 + Math.random() * 0.4));
}

export const nextAttemptAt = (attempt: number, strategy?: Backoff, now = new Date()): Date =>
  new Date(now.getTime() + backoffMs(attempt, strategy));
