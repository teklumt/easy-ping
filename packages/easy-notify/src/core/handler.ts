import type { DatabaseAdapter } from "./adapter";
import type { SessionConfig } from "./config";
import type { Logger } from "./errors";
import type { RouteDefinition } from "./plugin";
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
  pluginRoutes?: readonly RouteDefinition[] | undefined;
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const empty = (status: number) => new Response(null, { status });

const MAX_READ_IDS = 200;

/**
 * Constant-time comparison. Node's timingSafeEqual is unavailable on edge
 * runtimes, and `===` on a secret leaks its length and prefix through timing.
 */
function timingSafeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const left = encoder.encode(a);
  const right = encoder.encode(b);

  let diff = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i += 1) {
    diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  }
  return diff === 0;
}

function routePath(url: URL, basePath: string): string {
  const index = url.pathname.indexOf(basePath);
  if (index < 0) return url.pathname;
  return url.pathname.slice(index + basePath.length) || "/";
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = await request.json();
    return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function createHandler(deps: HandlerDeps) {
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

  async function handleCron(request: Request): Promise<Response> {
    if (!deps.cronSecret) return empty(404);

    const header = request.headers.get("authorization") ?? "";
    const presented = header.startsWith("Bearer ") ? header.slice(7) : header;

    if (!timingSafeEqual(presented, deps.cronSecret)) return empty(401);

    const result = await deps.runner.drain();
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
      const userId = await resolveUserId(request);
      if (userId === "error") return empty(500);
      if (userId === null) return empty(401);
      return route.handler({ request, userId, claims: null, params: {} });
    }

    if (route.scope.type === "machine") {
      if (!deps.cronSecret) return empty(404);
      const header = request.headers.get("authorization") ?? "";
      const presented = header.startsWith("Bearer ") ? header.slice(7) : header;
      if (!timingSafeEqual(presented, deps.cronSecret)) return empty(401);
      return route.handler({ request, userId: null, claims: null, params: {} });
    }

    if (route.scope.type === "signed") {
      const token =
        url.searchParams.get("token") ??
        (request.headers.get("authorization") ?? "").replace(/^Bearer /, "");

      const claims = await verifyToken(deps.secret, token, route.scope.purpose);
      // One response for every failure mode. Distinguishing expired from
      // forged tells an attacker which part to fix. RFC 0002 §5.
      if (!claims) return empty(400);

      return route.handler({ request, userId: claims.uid, claims, params: {} });
    }

    return route.handler({ request, userId: null, claims: null, params: {} });
  }

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = routePath(url, deps.basePath);

    if (path === "/cron") {
      if (request.method !== "POST") return empty(405);
      return handleCron(request);
    }

    const pluginRoute = deps.pluginRoutes?.find(
      (route) => route.path === path && route.method === request.method,
    );
    if (pluginRoute) return handlePluginRoute(pluginRoute, request, url);

    const userId = await resolveUserId(request);
    if (userId === "error") return empty(500);
    if (userId === null) return empty(401);

    if (request.method === "GET" && path === "/") {
      const limitParam = Number(url.searchParams.get("limit") ?? 20);
      const limit = Number.isFinite(limitParam) ? Math.min(Math.max(limitParam, 1), 100) : 20;
      const cursor = url.searchParams.get("cursor");

      const page = await deps.adapter.listNotifications({
        userId,
        limit,
        ...(cursor ? { cursor } : {}),
        ...(url.searchParams.get("unreadOnly") === "true" ? { unreadOnly: true } : {}),
      });
      return json(page);
    }

    if (request.method === "GET" && path === "/count") {
      return json({ unseen: await deps.adapter.countUnseen(userId) });
    }

    if (request.method === "POST" && path === "/seen") {
      const body = await readJson(request);
      const before = typeof body.before === "string" ? new Date(body.before) : null;

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
      const body = await readJson(request);
      const ids = Array.isArray(body.ids) ? body.ids.filter((id) => typeof id === "string") : [];
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

  return {
    handle,
    GET: handle,
    POST: handle,
  };
}
