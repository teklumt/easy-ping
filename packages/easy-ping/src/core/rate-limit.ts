export type RateLimitConfig = {
  /** Requests allowed per key per window. */
  max: number;
  windowMs: number;
  /**
   * Which bucket a request lands in. Defaults to the client address as the
   * usual proxy headers report it; returning null exempts the request. Behind
   * no proxy those headers are absent, so supply your own key there.
   */
  key?: (request: Request) => string | null;
};

const clientAddress = (request: Request): string | null => {
  const headers = request.headers;
  return (
    headers.get("cf-connecting-ip") ??
    headers.get("x-real-ip") ??
    headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    null
  );
};

/**
 * Fixed-window counter held in process memory. Per isolate on edge runtimes
 * and per replica anywhere else, so it bounds one client's cost to one
 * process rather than enforcing a global quota. That is enough to blunt
 * secret guessing and poll storms, which is what it is for.
 */
export function createRateLimiter(config: RateLimitConfig): (request: Request) => Response | null {
  const keyOf = config.key ?? clientAddress;
  const buckets = new Map<string, { count: number; resetAt: number }>();
  let lastSweep = 0;

  return (request) => {
    const key = keyOf(request);
    if (key === null) return null;

    const now = Date.now();

    // Drop expired buckets no more than once per window, so memory tracks
    // active clients rather than everyone ever seen.
    if (now - lastSweep > config.windowMs) {
      for (const [id, bucket] of buckets) if (bucket.resetAt <= now) buckets.delete(id);
      lastSweep = now;
    }

    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + config.windowMs };
      buckets.set(key, bucket);
    }

    bucket.count += 1;
    if (bucket.count <= config.max) return null;

    return new Response(null, {
      status: 429,
      headers: {
        "retry-after": String(Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))),
        "cache-control": "private, no-store",
      },
    });
  };
}
