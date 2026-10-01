import type { IncomingMessage, ServerResponse } from "node:http";
import { MAX_BODY_BYTES } from "../core/handler";

/** Adapts the web-standard handler to Node's http/Express signature. */
export type NodeHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

export type NodeHandlerOptions = {
  /** Defaults to 64 KiB. Enforced here because this reads the raw stream, bypassing body-parser. */
  maxBodyBytes?: number;
  /** Called when the handler itself throws. Defaults to console.error; the response is already a 500. */
  onError?: (error: unknown) => void;
};

class BodyTooLargeError extends Error {}

function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer | undefined> {
  if (req.method === "GET" || req.method === "HEAD") return Promise.resolve(undefined);

  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > maxBytes) {
    return Promise.reject(new BodyTooLargeError());
  }

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        req.destroy();
        reject(new BodyTooLargeError());
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(chunks.length ? Buffer.concat(chunks) : undefined));
    req.on("error", reject);
  });
}

export function toWebRequest(req: IncomingMessage, body?: Buffer, signal?: AbortSignal): Request {
  // Behind a load balancer this is the only signal that the site is https.
  const forwarded = String(req.headers["x-forwarded-proto"] ?? "")
    .split(",")[0]
    ?.trim()
    .toLowerCase();
  const protocol = forwarded === "https" || forwarded === "http" ? forwarded : "http";
  const host = req.headers.host ?? "localhost";

  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const item of value) headers.append(key, item);
    else headers.set(key, value);
  }

  return new Request(`${protocol}://${host}${req.url ?? "/"}`, {
    method: req.method ?? "GET",
    headers,
    ...(body ? { body: new Uint8Array(body) } : {}),
    ...(signal ? { signal } : {}),
  });
}

export function toNodeHandler(
  handler: (request: Request) => Promise<Response>,
  options: NodeHandlerOptions = {},
): NodeHandler {
  const maxBodyBytes = options.maxBodyBytes ?? MAX_BODY_BYTES;
  const onError = options.onError ?? ((error: unknown) => console.error("[easy-ping]", error));

  return async (req, res) => {
    // A client that goes away aborts the request, so an open event stream cleans up.
    const disconnect = new AbortController();
    res.on("close", () => disconnect.abort());

    try {
      const body = await readBody(req, maxBodyBytes);
      const response = await handler(toWebRequest(req, body, disconnect.signal));

      res.statusCode = response.status;
      // forEach: Headers is only iterable with "DOM.Iterable" in lib.
      response.headers.forEach((value, key) => {
        res.setHeader(key, value);
      });

      if (!response.body) {
        res.end();
        return;
      }

      // Streamed, never buffered: GET /events stays open and every chunk must reach the client now.
      res.flushHeaders();
      const reader = response.body.getReader();
      const cancel = () => reader.cancel().catch(() => {});
      disconnect.signal.addEventListener("abort", cancel, { once: true });
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!res.write(value)) {
            await new Promise<void>((resolve) => {
              const done = () => {
                res.off("drain", done);
                disconnect.signal.removeEventListener("abort", done);
                resolve();
              };
              res.once("drain", done);
              disconnect.signal.addEventListener("abort", done, { once: true });
            });
            if (disconnect.signal.aborted) break;
          }
        }
      } finally {
        disconnect.signal.removeEventListener("abort", cancel);
      }
      res.end();
    } catch (error) {
      // Respond and swallow: a rethrow is an unhandled rejection under Express.
      if (!res.headersSent) res.statusCode = error instanceof BodyTooLargeError ? 413 : 500;
      res.end();
      if (!(error instanceof BodyTooLargeError)) onError(error);
    }
  };
}
