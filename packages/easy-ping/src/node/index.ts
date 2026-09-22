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

export function toWebRequest(req: IncomingMessage, body?: Buffer): Request {
  // Behind a load balancer this is the only signal that the site is https.
  const protocol = (req.headers["x-forwarded-proto"] as string | undefined) ?? "http";
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
  });
}

export function toNodeHandler(
  handler: (request: Request) => Promise<Response>,
  options: NodeHandlerOptions = {},
): NodeHandler {
  const maxBodyBytes = options.maxBodyBytes ?? MAX_BODY_BYTES;
  const onError = options.onError ?? ((error: unknown) => console.error("[easy-ping]", error));

  return async (req, res) => {
    try {
      const response = await handler(toWebRequest(req, await readBody(req, maxBodyBytes)));

      res.statusCode = response.status;
      // forEach: Headers is only iterable with "DOM.Iterable" in lib.
      response.headers.forEach((value, key) => {
        res.setHeader(key, value);
      });

      const buffer = response.body ? Buffer.from(await response.arrayBuffer()) : null;
      res.end(buffer ?? undefined);
    } catch (error) {
      // Respond and swallow. Rethrowing here is an unhandled rejection under
      // Express, and Node terminates the process on those.
      if (!res.headersSent) res.statusCode = error instanceof BodyTooLargeError ? 413 : 500;
      res.end();
      if (!(error instanceof BodyTooLargeError)) onError(error);
    }
  };
}
