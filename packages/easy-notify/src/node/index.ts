import type { IncomingMessage, ServerResponse } from "node:http";

/** Adapts the web-standard handler to Node's http/Express signature. */
export type NodeHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

function readBody(req: IncomingMessage): Promise<Buffer | undefined> {
  if (req.method === "GET" || req.method === "HEAD") return Promise.resolve(undefined);

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
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

export function toNodeHandler(handler: (request: Request) => Promise<Response>): NodeHandler {
  return async (req, res) => {
    try {
      const response = await handler(toWebRequest(req, await readBody(req)));

      res.statusCode = response.status;
      // forEach: Headers is only iterable with "DOM.Iterable" in lib.
      response.headers.forEach((value, key) => {
        res.setHeader(key, value);
      });

      const buffer = response.body ? Buffer.from(await response.arrayBuffer()) : null;
      res.end(buffer ?? undefined);
    } catch (error) {
      // A throw here would leave the socket hanging until the client times out.
      res.statusCode = 500;
      res.end();
      throw error;
    }
  };
}
