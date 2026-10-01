export type RateLimitConfig = {
  /** Requests allowed per key per window. */
  max: number;
  windowMs: number;
  /** Bucket key. Defaults to the client address from proxy headers; null exempts the request. */
  key?: (request: Request) => string | null;
  maxKeys?: number;
  onUnkeyed?: () => void;
};

const UNKEYED = "\u0000unkeyed";

const clientAddress = (request: Request): string | null => {
  const headers = request.headers;
  return (
    headers.get("cf-connecting-ip") ??
    headers.get("x-real-ip") ??
    headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    null
  );
};

/** Fixed window in process memory: per isolate or replica, so a bound rather than a quota. */
export function createRateLimiter(config: RateLimitConfig): (request: Request) => Response | null {
  let warned = false;
  const keyOf =
    config.key ??
    ((request: Request) => {
      const address = clientAddress(request);
      if (address !== null) return address;
      if (!warned) {
        warned = true;
        config.onUnkeyed?.();
      }
      return UNKEYED;
    });
  const maxKeys = Math.max(1, config.maxKeys ?? 10_000);
  const buckets = new Map<string, { count: number; resetAt: number }>();
  let lastSweep = 0;

  return (request) => {
    const key = keyOf(request);
    if (key === null) return null;

    const now = Date.now();

    // Sweep expired buckets at most once per window.
    if (now - lastSweep > config.windowMs) {
      for (const [id, bucket] of buckets) if (bucket.resetAt <= now) buckets.delete(id);
      lastSweep = now;
    }

    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      if (!bucket && buckets.size >= maxKeys) {
        const oldest = buckets.keys().next().value;
        if (oldest !== undefined) buckets.delete(oldest);
      }
      bucket = { count: 0, resetAt: now + config.windowMs };
      buckets.delete(key);
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
