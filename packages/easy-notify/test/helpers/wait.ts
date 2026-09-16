/**
 * Polls until `check` passes.
 *
 * A fixed sleep encodes a guess about how long a poll plus two round trips
 * takes, and that guess is wrong the moment the suite runs 16 files in
 * parallel on a loaded machine. Waiting on the condition is both faster in the
 * common case and immune to load.
 */
export async function waitFor<T>(
  check: () => T | undefined | null | false,
  { timeout = 2_000, interval = 5 }: { timeout?: number; interval?: number } = {},
): Promise<T> {
  const deadline = Date.now() + timeout;
  let last: unknown;

  while (Date.now() < deadline) {
    try {
      const value = check();
      if (value) return value as T;
      last = value;
    } catch (error) {
      last = error;
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }

  throw new Error(`waitFor timed out after ${timeout}ms (last: ${String(last)})`);
}

/** Waits until the predicate holds, discarding the value. */
export const waitUntil = (check: () => boolean, options?: { timeout?: number }) =>
  waitFor(() => check() || undefined, options);
