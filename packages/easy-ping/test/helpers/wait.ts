/** Polls until `check` passes; a fixed sleep is a guess that breaks on a slow machine. */
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
