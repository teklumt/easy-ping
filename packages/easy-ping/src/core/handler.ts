import type { DatabaseAdapter } from "./adapter";
import type { SessionConfig } from "./config";
import type { Logger } from "./errors";
import type { Promisable, RouteDefinition } from "./plugin";
import type { Runner } from "./runner";
import { inboxChannel, type Signals } from "./signals";
import { verifyToken } from "./tokens";

export type EventsSettings = {
  heartbeatMs: number;
  probeIntervalMs: number;
  maxDurationMs: number;
  maxStreamsPerUser: number;
  maxStreams: number;
};

/** Unread chunks a stream may hold before it is closed on a consumer that stopped reading. */
const STREAM_HIGH_WATER_MARK = 256;

export type HandlerDeps = {
  adapter: DatabaseAdapter;
  session: SessionConfig;
  runner: Runner;
  logger: Logger;
  basePath: string;
  secret: string;
  signals: Signals;
  /** `false` unmounts GET /events. */
  events: EventsSettings | false;
  /** Fire-and-forget delivery pass after a request. Rate-limited by the instance. */
  sweepOnRequest?: (() => void) | undefined;
  cronSecret?: string | undefined;
  /** Guards plugin machine routes. The instance defaults it to cronSecret. */
  machineSecret?: string | undefined;
  cronMaxSweeps?: number | undefined;
  pluginRoutes?: readonly RouteDefinition[] | undefined;
  /** Returns a 429 to send, or null to proceed. Runs after onRequest, before routing. */
  rateLimit?: ((request: Request) => Response | null) | undefined;
  /** Origins other than the request's own host that may POST. `*.example.com` allowed. */
  trustedOrigins?: readonly string[] | undefined;
  /** Runs before routing. Returning a Response short-circuits; use it for rate limiting. */
  // biome-ignore lint/suspicious/noConfusingVoidType: a hook that returns nothing is the common case
  onRequest?: ((request: Request) => Promisable<Response | undefined | void>) | undefined;
  maxBodyBytes?: number | undefined;
};

/** Every JSON body is capped here. Nothing legitimate the routes accept is bigger. */
export const MAX_BODY_BYTES = 64 * 1024;

const MAX_READ_IDS = 200;

// Per-user data: no shared caching, no sniffing.
const PRIVATE_HEADERS: Record<string, string> = {
  "cache-control": "private, no-store",
  "x-content-type-options": "nosniff",
};

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...PRIVATE_HEADERS, ...headers },
  });

const empty = (status: number) => new Response(null, { status, headers: PRIVATE_HEADERS });

/** Plugin responses get the same headers, without touching their body. */
function harden(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(PRIVATE_HEADERS)) {
    if (!headers.has(name)) headers.set(name, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

const encoder = new TextEncoder();

/** Constant time over SHA-256 digests, so neither content nor length leaks. Works on edge runtimes. */
async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const [left, right] = await Promise.all(
    [a, b].map(
      async (value) => new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))),
    ),
  );
  let diff = 0;
  for (let i = 0; i < 32; i += 1) diff |= (left?.[i] ?? 0) ^ (right?.[i] ?? 0);
  return diff === 0;
}

/** Anchored at a segment boundary: `/foo/api/notifications/cron` is not a cron request. */
function routePath(url: URL, basePath: string): string {
  const { pathname } = url;
  if (pathname === basePath) return "/";
  if (pathname.startsWith(`${basePath}/`)) return pathname.slice(basePath.length);
  return pathname;
}

export type JsonBody = { body: Record<string, unknown> } | { error: Response };

/** Reads a JSON object body with a streaming byte cap. Malformed JSON is 400; an empty body is `{}`. */
export async function readJsonBody(
  request: Request,
  maxBytes: number = MAX_BODY_BYTES,
): Promise<JsonBody> {
  const tooLarge = () => ({ error: json({ error: `body exceeds ${maxBytes} bytes` }, 413) });

  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) return tooLarge();
  if (!request.body) return { body: {} };

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return tooLarge();
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  const text = new TextDecoder().decode(bytes);
  if (text.trim() === "") return { body: {} };

  try {
    const parsed: unknown = JSON.parse(text);
    return {
      body:
        parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : {},
    };
  } catch {
    return { error: json({ error: "body must be a JSON object" }, 400) };
  }
}

const isJsonContentType = (request: Request) =>
  /^application\/json\s*(;|$)/i.test((request.headers.get("content-type") ?? "").trim());

function originAllowed(origin: string, url: URL, request: Request, trusted: readonly string[]) {
  let host: string;
  try {
    host = new URL(origin).host;
  } catch {
    return false;
  }

  if (host === url.host) return true;
  // Behind a proxy that rewrites Host, the public host arrives here instead.
  const forwarded = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  if (forwarded && host === forwarded) return true;

  return trusted.some((entry) =>
    entry.startsWith("*.") ? host.endsWith(entry.slice(1)) : entry === origin,
  );
}

/** CSRF: a cross-site form can neither send `application/json` without a preflight nor forge `Origin`. */
function csrfCheck(request: Request, url: URL, trusted: readonly string[]): Response | null {
  if (!isJsonContentType(request)) {
    return json({ error: "content-type must be application/json" }, 415);
  }

  const origin = request.headers.get("origin");
  if (origin === null) return null;
  if (origin === "null" || !originAllowed(origin, url, request, trusted)) return empty(403);

  return null;
}

export function createHandler(deps: HandlerDeps) {
  const trustedOrigins = deps.trustedOrigins ?? [];
  const maxBodyBytes = deps.maxBodyBytes ?? MAX_BODY_BYTES;

  async function resolveUserId(request: Request): Promise<string | null | "error"> {
    try {
      return await deps.session.getUserId(request);
    } catch (error) {
      // A broken session lookup is a 500, never a 401. RFC 0002 §1.
      deps.logger.error("session.getUserId threw", { error });
      return "error";
    }
  }

  async function bearerMatches(request: Request, secret: string | undefined): Promise<boolean> {
    if (!secret) return false;
    const header = request.headers.get("authorization") ?? "";
    const presented = header.startsWith("Bearer ") ? header.slice(7) : header;
    return timingSafeEqual(presented, secret);
  }

  async function handleCron(request: Request): Promise<Response> {
    if (!deps.cronSecret) return empty(404);
    if (!(await bearerMatches(request, deps.cronSecret))) return empty(401);

    // Bounded so an overlapping scheduler does not hold a request open for the whole backlog.
    const result = await deps.runner.drain(
      deps.cronMaxSweeps === undefined ? {} : { maxSweeps: deps.cronMaxSweeps },
    );
    return json(result);
  }

  /** Plugin routes first; auth is enforced here so a plugin cannot forget it. */
  async function handlePluginRoute(
    route: RouteDefinition,
    request: Request,
    url: URL,
  ): Promise<Response> {
    if (route.scope.type === "user") {
      if (request.method === "POST") {
        const rejected = csrfCheck(request, url, trustedOrigins);
        if (rejected) return rejected;
      }

      const userId = await resolveUserId(request);
      if (userId === "error") return empty(500);
      if (userId === null) return empty(401);
      return harden(await route.handler({ request, userId, claims: null, params: {} }));
    }

    if (route.scope.type === "machine") {
      if (!deps.machineSecret) return empty(404);
      if (!(await bearerMatches(request, deps.machineSecret))) return empty(401);
      return harden(await route.handler({ request, userId: null, claims: null, params: {} }));
    }

    if (route.scope.type === "signed") {
      const token =
        url.searchParams.get("token") ??
        (request.headers.get("authorization") ?? "").replace(/^Bearer /, "");

      const claims = await verifyToken(deps.secret, token, route.scope.purpose);
      // One response for every failure mode. RFC 0002 §5.
      if (!claims) return empty(400);

      return harden(await route.handler({ request, userId: claims.uid, claims, params: {} }));
    }

    return harden(await route.handler({ request, userId: null, claims: null, params: {} }));
  }

  async function route(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = routePath(url, deps.basePath);

    if (deps.onRequest) {
      const early = await deps.onRequest(request);
      if (early instanceof Response) return early;
    }

    if (deps.rateLimit) {
      const limited = deps.rateLimit(request);
      if (limited) return limited;
    }

    if (path === "/cron") {
      if (request.method !== "POST") return empty(405);
      return handleCron(request);
    }

    const pluginRoute = deps.pluginRoutes?.find(
      (candidate) => candidate.path === path && candidate.method === request.method,
    );
    if (pluginRoute) return handlePluginRoute(pluginRoute, request, url);

    if (request.method === "POST") {
      const rejected = csrfCheck(request, url, trustedOrigins);
      if (rejected) return rejected;
    }

    const userId = await resolveUserId(request);
    if (userId === "error") return empty(500);
    if (userId === null) return empty(401);

    if (request.method === "GET" && path === "/events") {
      if (!deps.events) return empty(404);
      // A session can open streams for free; without a cap one account can hold every socket.
      if ((openStreams.get(userId) ?? 0) >= deps.events.maxStreamsPerUser) {
        return json({ error: "too many open event streams" }, 429, { "retry-after": "30" });
      }
      if (totalStreams >= deps.events.maxStreams) {
        return json({ error: "event streams unavailable" }, 503, { "retry-after": "30" });
      }
      return events(request, userId, deps.events);
    }

    if (request.method === "GET" && path === "/") {
      const limitParam = Number(url.searchParams.get("limit") ?? 20);
      const limit = Number.isFinite(limitParam) ? Math.min(Math.max(limitParam, 1), 100) : 20;
      const cursor = url.searchParams.get("cursor");

      // unseenCount rides on the first page only: a cursor request is scrollback, not a poll.
      const [page, unseenCount] = await Promise.all([
        deps.adapter.listNotifications({
          userId,
          limit,
          ...(cursor ? { cursor } : {}),
          ...(url.searchParams.get("unreadOnly") === "true" ? { unreadOnly: true } : {}),
        }),
        cursor ? Promise.resolve(null) : deps.adapter.countUnseen(userId),
      ]);

      return json(unseenCount === null ? page : { ...page, unseenCount });
    }

    if (request.method === "GET" && path === "/count") {
      return json({ unseen: await deps.adapter.countUnseen(userId) });
    }

    if (request.method === "POST" && path === "/seen") {
      const parsed = await readJsonBody(request, maxBodyBytes);
      if ("error" in parsed) return parsed.error;
      const before = typeof parsed.body.before === "string" ? new Date(parsed.body.before) : null;

      // +1ms: Postgres keeps microseconds, an ISO string milliseconds; without it markSeen misses the newest row.
      const cutoff =
        before && !Number.isNaN(before.getTime()) ? new Date(before.getTime() + 1) : new Date();

      await deps.adapter.markSeen(userId, cutoff);
      deps.signals.publish(inboxChannel(userId));
      return json({ ok: true });
    }

    if (request.method === "POST" && path === "/read") {
      const parsed = await readJsonBody(request, maxBodyBytes);
      if ("error" in parsed) return parsed.error;
      const ids = Array.isArray(parsed.body.ids)
        ? parsed.body.ids.filter((id): id is string => typeof id === "string")
        : [];
      if (ids.length === 0) return json({ error: "ids must be a non-empty string array" }, 400);

      if (ids.length > MAX_READ_IDS) {
        return json({ error: `at most ${MAX_READ_IDS} ids per request` }, 400);
      }

      // 404, not 403: a 403 confirms the row exists. RFC 0002 §2.
      const updated = await deps.adapter.markRead(userId, ids);
      if (updated > 0) deps.signals.publish(inboxChannel(userId));
      return updated === 0 ? empty(404) : json({ updated });
    }

    if (request.method === "POST" && path === "/read-all") {
      const updated = await deps.adapter.markAllRead(userId);
      if (updated > 0) deps.signals.publish(inboxChannel(userId));
      return json({ updated });
    }

    return empty(404);
  }

  const openStreams = new Map<string, number>();
  let totalStreams = 0;

  const trackStream = (userId: string) => {
    openStreams.set(userId, (openStreams.get(userId) ?? 0) + 1);
    totalStreams += 1;
    return () => {
      const remaining = (openStreams.get(userId) ?? 1) - 1;
      if (remaining > 0) openStreams.set(userId, remaining);
      else openStreams.delete(userId);
      totalStreams -= 1;
    };
  };

  /** A change fingerprint cheap enough to take every probe interval. */
  async function fingerprint(userId: string): Promise<string> {
    const [page, unseen] = await Promise.all([
      deps.adapter.listNotifications({ userId, limit: 1 }),
      deps.adapter.countUnseen(userId),
    ]);
    const newest = page.notifications[0];
    return `${newest?.id ?? ""}|${newest?.readAt ? 1 : 0}|${unseen}`;
  }

  // One probe per user, however many streams that user holds: N tabs must not mean N queries.
  type Probe = { listeners: Set<() => void>; timer: ReturnType<typeof setInterval>; last?: string };
  const probes = new Map<string, Probe>();

  function subscribeProbe(userId: string, onChanged: () => void, intervalMs: number) {
    let probe = probes.get(userId);
    if (!probe) {
      const created: Probe = {
        listeners: new Set(),
        timer: setInterval(() => {
          fingerprint(userId)
            .then((value) => {
              if (created.last !== undefined && value !== created.last) {
                for (const listener of created.listeners) listener();
              }
              created.last = value;
            })
            .catch((error) => deps.logger.error("events probe failed", { error }));
        }, intervalMs),
      };
      probe = created;
      probes.set(userId, created);
      fingerprint(userId)
        .then((value) => {
          if (created.last === undefined) created.last = value;
        })
        .catch(() => {});
    }
    probe.listeners.add(onChanged);
    return () => {
      const current = probes.get(userId);
      if (!current) return;
      current.listeners.delete(onChanged);
      if (current.listeners.size === 0) {
        clearInterval(current.timer);
        probes.delete(userId);
      }
    };
  }

  /**
   * Server-Sent Events: `ready` once, `changed` whenever this user's inbox
   * moves, comments as keepalive. No payload ever travels on the stream; the
   * client fetches the feed on `changed`. RFC 0006 §4D.
   */
  function events(request: Request, userId: string, settings: EventsSettings): Response {
    const encoder = new TextEncoder();
    const timers: ReturnType<typeof setInterval>[] = [];
    const unsubscribes: (() => void)[] = [];
    let closed = false;
    let cleanup = () => {};

    const stream = new ReadableStream<Uint8Array>(
      {
        start(controller) {
          const write = (text: string) => {
            if (closed) return;
            // A consumer that stopped reading would make this queue grow without bound.
            if (controller.desiredSize !== null && controller.desiredSize <= 0) {
              cleanup();
              return;
            }
            try {
              controller.enqueue(encoder.encode(text));
            } catch {
              cleanup();
            }
          };
          cleanup = () => {
            if (closed) return;
            closed = true;
            for (const unsubscribe of unsubscribes) unsubscribe();
            for (const timer of timers) clearInterval(timer);
            try {
              controller.close();
            } catch {
              // already closed by the consumer
            }
          };
          const changed = () => write("event: changed\ndata: {}\n\n");

          unsubscribes.push(trackStream(userId));
          write("retry: 3000\n\nevent: ready\ndata: {}\n\n");
          unsubscribes.push(deps.signals.subscribe(inboxChannel(userId), changed));
          timers.push(setInterval(() => write(": keepalive\n\n"), settings.heartbeatMs));

          if (!deps.signals.crossProcess && settings.probeIntervalMs > 0) {
            unsubscribes.push(subscribeProbe(userId, changed, settings.probeIntervalMs));
          }

          if (settings.maxDurationMs > 0) {
            timers.push(
              setTimeout(cleanup, settings.maxDurationMs) as ReturnType<typeof setInterval>,
            );
          }
          request.signal?.addEventListener("abort", cleanup, { once: true });
        },
        cancel() {
          cleanup();
        },
      },
      { highWaterMark: STREAM_HIGH_WATER_MARK },
    );

    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-store",
        connection: "keep-alive",
        "x-accel-buffering": "no",
        "x-content-type-options": "nosniff",
      },
    });
  }

  async function handle(request: Request): Promise<Response> {
    let response: Response | undefined;
    try {
      response = await route(request);
      return response;
    } catch (error) {
      // A thrown driver error must not escape: unhandled rejection on Node, stack trace elsewhere.
      deps.logger.error("request failed", { url: request.url, error });
      return empty(500);
    } finally {
      // Only a served request earns a sweep; anonymous 401s must not drive database work.
      if (response && response.status < 400) deps.sweepOnRequest?.();
    }
  }

  return {
    handle,
    GET: handle,
    POST: handle,
  };
}
