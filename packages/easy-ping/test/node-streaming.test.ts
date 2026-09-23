import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { toNodeHandler } from "../src/node";
import { waitUntil } from "./helpers/wait";

// The event stream only works if the Node adapter forwards chunks as they are
// produced. A buffered adapter passes every other test and breaks GET /events.

let aborted = 0;
let release: (() => void) | undefined;

const handler = async (request: Request): Promise<Response> => {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode("first\n"));
      release = () => {
        controller.enqueue(encoder.encode("second\n"));
        controller.close();
      };
      request.signal.addEventListener("abort", () => {
        aborted += 1;
        try {
          controller.close();
        } catch {
          // already closed
        }
      });
    },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream" } });
};

const server = createServer(toNodeHandler(handler));
let base = "";

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("toNodeHandler streaming", () => {
  it("forwards the first chunk before the response has ended", async () => {
    const response = await fetch(`${base}/stream`);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const reader = response.body?.getReader();
    if (!reader) throw new Error("no body");

    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe("first\n");

    release?.();
    const second = await reader.read();
    expect(new TextDecoder().decode(second.value)).toBe("second\n");
    expect((await reader.read()).done).toBe(true);
  });

  it("aborts the web request when the client disconnects", async () => {
    const before = aborted;
    const controller = new AbortController();
    const response = await fetch(`${base}/stream`, { signal: controller.signal });
    const reader = response.body?.getReader();
    await reader?.read();

    controller.abort();
    await waitUntil(() => aborted === before + 1);
  });
});
