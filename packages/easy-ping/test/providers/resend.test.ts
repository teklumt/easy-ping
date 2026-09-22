import { describe, expect, it } from "vitest";
import { ResendError, resend } from "../../src/providers/resend";

type Captured = { url: string; init: RequestInit };

function stubFetch(response: Response) {
  const calls: Captured[] = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return response;
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

const ok = () => new Response(JSON.stringify({ id: "msg_123" }), { status: 200 });
const status = (code: number, body = "") => new Response(body, { status: code });

const message = {
  to: "dana@x.dev",
  subject: "Dana replied",
  html: "<p>hi</p>",
  idempotencyKey: "delivery_abc",
};

const provider = (fetch: typeof globalThis.fetch) =>
  resend({ apiKey: "re_test", from: "Acme <no-reply@acme.dev>", fetch });

describe("resend provider", () => {
  it("posts the message and returns the provider id", async () => {
    const { fetch, calls } = stubFetch(ok());
    const result = await provider(fetch).send(message);

    expect(result).toEqual({ providerMessageId: "msg_123" });
    expect(calls[0]?.url).toBe("https://api.resend.com/emails");

    const body = JSON.parse(String(calls[0]?.init.body));
    expect(body).toMatchObject({
      from: "Acme <no-reply@acme.dev>",
      to: "dana@x.dev",
      subject: "Dana replied",
      html: "<p>hi</p>",
    });
  });

  it("sends the delivery id as the Idempotency-Key", async () => {
    const { fetch, calls } = stubFetch(ok());
    await provider(fetch).send(message);

    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers["Idempotency-Key"]).toBe("delivery_abc");
    expect(headers.Authorization).toBe("Bearer re_test");
  });

  it("throws a ResendError carrying the status", async () => {
    const { fetch } = stubFetch(status(422, "invalid recipient"));
    await expect(provider(fetch).send(message)).rejects.toBeInstanceOf(ResendError);
  });

  describe("isRetryable", () => {
    const classify = async (code: number) => {
      const { fetch } = stubFetch(status(code));
      const instance = provider(fetch);
      try {
        await instance.send(message);
        return null;
      } catch (error) {
        return instance.isRetryable(error);
      }
    };

    it("retries rate limits and server errors", async () => {
      expect(await classify(429)).toBe(true);
      expect(await classify(408)).toBe(true);
      expect(await classify(500)).toBe(true);
      expect(await classify(503)).toBe(true);
    });

    it("does not retry auth or validation failures", async () => {
      // A revoked key fails identically on all five attempts. Burning 45
      // minutes of backoff on it hides the real problem.
      expect(await classify(401)).toBe(false);
      expect(await classify(403)).toBe(false);
      expect(await classify(422)).toBe(false);
      expect(await classify(400)).toBe(false);
    });

    it("retries a network failure that never reached the API", async () => {
      const fetch = (async () => {
        throw new TypeError("fetch failed");
      }) as unknown as typeof globalThis.fetch;

      const instance = provider(fetch);
      try {
        await instance.send(message);
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(ResendError);
        expect((error as ResendError).status).toBeUndefined();
        expect(instance.isRetryable(error)).toBe(true);
      }
    });

    it("retries the runner's own timeout", () => {
      const { fetch } = stubFetch(ok());
      expect(provider(fetch).isRetryable(new Error("resend send timed out after 30000ms"))).toBe(
        true,
      );
    });
  });
});
