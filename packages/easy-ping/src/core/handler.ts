import type { DatabaseAdapter } from "./adapter";
import type { SessionConfig } from "./config";
import type { Logger } from "./errors";
import type { Promisable, RouteDefinition } from "./plugin";
import type { Runner } from "./runner";
import { verifyToken } from "./tokens";

export type HandlerDeps = {
  adapter: DatabaseAdapter;
  session: SessionConfig;
  runner: Runner;
  logger: Logger;
  basePath: string;
  secret: string;
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

// The inbox is per-user data: never let a shared cache keep it, never let a
// browser sniff it into something executable.
const PRIVATE_HEADERS: Record<string, string> = {
  "cache-control": "private, no-store",
  "x-content-type-options": "nosniff",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...PRIVATE_HEADERS },
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

/**
 * Constant-time comparison over SHA-256 digests. Node's timingSafeEqual is
 * unavailable on edge runtimes, `===` leaks through timing, and comparing the
 * raw strings would still reveal the secret's length.
 */
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

/**
 * Reads a JSON object body with a byte cap enforced while streaming, so an
 * oversized body is refused before it is buffered. Malformed JSON is 400; an
 * empty body is `{}`. Plugin routes should use this rather than
 * `request.json()`, which has no limit.
 */
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

/**
 * Two cheap CSRF defences for cookie-authenticated POSTs. A cross-site form
 * cannot send `application/json` without a preflight the browser will fail,
 * and it cannot forge `Origin`. Neither depends on the host app's SameSite
 * policy, which the library cannot see.
 */
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
      // A broken session lookup is a 500, never a 401. Collapsing them makes
      // an outage look like a mass logout. RFC 0002 §1.
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

    // Bounded: an overlapping scheduler must not hold a request open for as
    // long as the backlog lasts.
    const result = await deps.runner.drain(
      deps.cronMaxSweeps === undefined ? {} : { maxSweeps: deps.cronMaxSweeps },
    );
    return json(result);
  }

  /**
   * Plugin routes are dispatched before core ones and carry their scope with
   * them. Authentication happens here rather than in the plugin handler, so a
   * plugin physically cannot forget to check a signature or scope a query.
   */
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
      // One response for every failure mode. Distinguishing expired from
      // forged tells an attacker which part to fix. RFC 0002 §5.
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

    if (request.method === "GET" && path === "/") {
      const limitParam = Number(url.searchParams.get("limit") ?? 20);
      const limit = Number.isFinite(limitParam) ? Math.min(Math.max(limitParam, 1), 100) : 20;
      const cursor = url.searchParams.get("cursor");

      // The badge count rides along with the first page, so a polling client
      // needs one request per tick instead of two. Paginating past the first
      // page omits it: a cursor request is scrollback, not a poll.
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

      // Defaults to now, but a client should send the timestamp of the newest
      // notification it has actually rendered. Otherwise anything that arrived
      // between the last poll and the click is marked seen without ever having
      // produced a badge — the user silently misses it.
      //
      // +1ms because Postgres keeps microseconds while an ISO string carries
      // only milliseconds. Without it the truncated cutoff falls *before* the
      // very row it was taken from, and markSeen matches nothing at all.
      const cutoff =
        before && !Number.isNaN(before.getTime()) ? new Date(before.getTime() + 1) : new Date();

      await deps.adapter.markSeen(userId, cutoff);
      return json({ ok: true });
    }

    if (request.method === "POST" && path === "/read") {
      const parsed = await readJsonBody(request, maxBodyBytes);
      if ("error" in parsed) return parsed.error;
      const ids = Array.isArray(parsed.body.ids)
        ? parsed.body.ids.filter((id): id is string => typeof id === "string")
        : [];
      if (ids.length === 0) return json({ error: "ids must be a non-empty string array" }, 400);

      // Unbounded, this builds a query with as many bind parameters as the
      // caller cares to send. Postgres caps at 65535 and degrades long before.
      if (ids.length > MAX_READ_IDS) {
        return json({ error: `at most ${MAX_READ_IDS} ids per request` }, 400);
      }

      // Scoped by userId in the adapter. A miss is 404, not 403 — a 403 would
      // confirm the row exists and belongs to someone else. RFC 0002 §2.
      const updated = await deps.adapter.markRead(userId, ids);
      return updated === 0 ? empty(404) : json({ updated });
    }

    if (request.method === "POST" && path === "/read-all") {
      return json({ updated: await deps.adapter.markAllRead(userId) });
    }

    return empty(404);
  }

  async function handle(request: Request): Promise<Response> {
    try {
      return await route(request);
    } catch (error) {
      // Never let a driver error escape: on Node it becomes an unhandled
      // rejection, on other hosts a stack trace in the response body.
      deps.logger.error("request failed", { url: request.url, error });
      return empty(500);
    }
  }

  return {
    handle,
    GET: handle,
    POST: handle,
  };
}
