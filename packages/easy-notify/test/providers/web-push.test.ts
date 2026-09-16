import { describe, expect, it } from "vitest";
import { decodeBase64Url, decodeBase64UrlBytes, encodeBase64Url } from "../../src/core/base64url";
import type { PushMessage } from "../../src/plugins/push";
import { webPush } from "../../src/providers/web-push";
import {
  encryptPayload,
  generateVapidKeys,
  MAX_PAYLOAD_BYTES,
  vapidAuthorization,
} from "../../src/providers/web-push/crypto";
import { createSubscriber, decryptAsBrowser, utf8 } from "../helpers/web-push";

describe("web push encryption", () => {
  it("produces a body a browser can decrypt", async () => {
    const subscriber = await createSubscriber();
    const message = "When I grow up, I want to be a watermelon";

    const { body } = await encryptPayload(
      utf8(message),
      subscriber.subscription.keys.p256dh,
      subscriber.subscription.keys.auth,
    );

    expect(await decryptAsBrowser(body, subscriber)).toBe(message);
  });

  it("round-trips a realistic notification payload", async () => {
    const subscriber = await createSubscriber();
    const payload = JSON.stringify({
      title: "Dana replied",
      body: "…to your comment on the roadmap",
      data: { notificationId: crypto.randomUUID(), type: "commentReply" },
    });

    const { body } = await encryptPayload(
      utf8(payload),
      subscriber.subscription.keys.p256dh,
      subscriber.subscription.keys.auth,
    );

    expect(JSON.parse(await decryptAsBrowser(body, subscriber))).toMatchObject({
      title: "Dana replied",
    });
  });

  it("uses a fresh salt and ephemeral key for every message", async () => {
    const subscriber = await createSubscriber();
    const encrypt = () =>
      encryptPayload(
        utf8("same"),
        subscriber.subscription.keys.p256dh,
        subscriber.subscription.keys.auth,
      );

    const [first, second] = await Promise.all([encrypt(), encrypt()]);

    // Reusing a salt and key with AES-GCM leaks plaintext.
    expect(encodeBase64Url(first.salt)).not.toBe(encodeBase64Url(second.salt));
    expect(encodeBase64Url(first.serverPublicKey)).not.toBe(
      encodeBase64Url(second.serverPublicKey),
    );
  });

  it("cannot be decrypted with a different subscription's key", async () => {
    const intended = await createSubscriber();
    const other = await createSubscriber();

    const { body } = await encryptPayload(
      utf8("secret"),
      intended.subscription.keys.p256dh,
      intended.subscription.keys.auth,
    );

    await expect(decryptAsBrowser(body, other)).rejects.toThrow();
  });

  it("rejects a payload larger than one record", async () => {
    const subscriber = await createSubscriber();
    const oversized = new Uint8Array(MAX_PAYLOAD_BYTES + 1);

    await expect(
      encryptPayload(
        oversized,
        subscriber.subscription.keys.p256dh,
        subscriber.subscription.keys.auth,
      ),
    ).rejects.toThrow(/limit is/);
  });

  it("rejects malformed subscription keys rather than sending garbage", async () => {
    await expect(encryptPayload(utf8("x"), "not-a-key", "also-not")).rejects.toThrow();
  });
});

describe("VAPID", () => {
  const endpoint = "https://push.example.com/sub/abc?token=xyz";

  it("generates an importable keypair", async () => {
    const keys = await generateVapidKeys();
    const publicKey = decodeBase64UrlBytes(keys.publicKey);

    expect(publicKey).toHaveLength(65);
    expect(publicKey?.[0]).toBe(0x04); // uncompressed point
    expect(decodeBase64UrlBytes(keys.privateKey)).toHaveLength(32);
  });

  it("signs a JWT the push service can verify with the advertised key", async () => {
    const keys = await generateVapidKeys();
    const header = await vapidAuthorization(endpoint, { subject: "mailto:ops@acme.dev", keys });

    const [, token] = header.match(/^vapid t=([^,]+), k=(.+)$/) ?? [];
    expect(token).toBeTruthy();

    const [encodedHeader, encodedClaims, encodedSignature] = (token as string).split(".");
    const signingInput = `${encodedHeader}.${encodedClaims}`;

    const publicKey = decodeBase64UrlBytes(keys.publicKey);
    if (!publicKey) throw new Error("bad public key");

    const verifier = await crypto.subtle.importKey(
      "raw",
      publicKey,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );

    const signature = decodeBase64UrlBytes(encodedSignature as string);
    if (!signature) throw new Error("bad signature");

    // Raw r||s, which is what JWS ES256 requires — a DER-wrapped signature
    // would verify nowhere.
    expect(signature).toHaveLength(64);
    expect(
      await crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        verifier,
        signature,
        utf8(signingInput),
      ),
    ).toBe(true);
  });

  it("scopes the audience to the origin, not the full endpoint", async () => {
    const keys = await generateVapidKeys();
    const header = await vapidAuthorization(endpoint, { subject: "mailto:ops@acme.dev", keys });

    const claims = JSON.parse(
      decodeBase64Url((header.match(/t=([^,]+)/)?.[1] ?? "").split(".")[1] ?? "") ?? "{}",
    );

    // A token scoped to the path is rejected by every push service.
    expect(claims.aud).toBe("https://push.example.com");
    expect(claims.sub).toBe("mailto:ops@acme.dev");
    expect(claims.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it("refuses a subject that is not mailto: or https:", async () => {
    const keys = await generateVapidKeys();
    await expect(vapidAuthorization(endpoint, { subject: "ops@acme.dev", keys })).rejects.toThrow(
      /mailto:/,
    );
  });

  it("expires the token", async () => {
    const keys = await generateVapidKeys();
    const header = await vapidAuthorization(endpoint, {
      subject: "mailto:ops@acme.dev",
      keys,
      now: new Date("2026-01-01T00:00:00Z"),
      ttlSeconds: 60,
    });

    const claims = JSON.parse(
      decodeBase64Url((header.match(/t=([^,]+)/)?.[1] ?? "").split(".")[1] ?? "") ?? "{}",
    );
    expect(claims.exp).toBe(Math.floor(Date.parse("2026-01-01T00:00:00Z") / 1000) + 60);
  });
});

describe("webPush provider", () => {
  const stub = (respond: (request: Request) => Response) => {
    const seen: { url: string; init: RequestInit }[] = [];
    const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), init: init ?? {} });
      return respond(new Request(String(url), { method: "POST" }));
    }) as unknown as typeof globalThis.fetch;
    return { fetch, seen };
  };

  const message = async (): Promise<PushMessage> => {
    const subscriber = await createSubscriber();
    return {
      subscription: subscriber.subscription,
      title: "Hi",
      body: "there",
      data: { k: "v" },
    };
  };

  const provider = async (respond: (request: Request) => Response) => {
    const { fetch, seen } = stub(respond);
    return {
      seen,
      instance: webPush({
        subject: "mailto:ops@acme.dev",
        vapid: await generateVapidKeys(),
        fetch,
      }),
    };
  };

  it("posts an aes128gcm body with a VAPID header", async () => {
    const { instance, seen } = await provider(() => new Response(null, { status: 201 }));
    expect(await instance.send(await message())).toEqual({});

    const headers = seen[0]?.init.headers as Record<string, string>;
    expect(headers["Content-Encoding"]).toBe("aes128gcm");
    expect(headers["Content-Type"]).toBe("application/octet-stream");
    expect(headers.Authorization).toMatch(/^vapid t=.+, k=.+$/);
    expect(headers.TTL).toBe(String(12 * 3600));
    expect(seen[0]?.init.body).toBeInstanceOf(Uint8Array);
  });

  it("reports a gone endpoint as expired so the plugin prunes it", async () => {
    for (const status of [404, 410]) {
      const { instance } = await provider(() => new Response(null, { status }));
      expect(await instance.send(await message())).toEqual({ expired: true });
    }
  });

  it("marks throttling and server errors retryable", async () => {
    for (const status of [408, 429, 500, 503]) {
      const { instance } = await provider(() => new Response(null, { status }));
      expect(await instance.send(await message())).toEqual({ retryable: true });
    }
  });

  it("throws on a request the service will always reject", async () => {
    const { instance } = await provider(() => new Response("bad vapid", { status: 401 }));
    await expect(instance.send(await message())).rejects.toThrow(/401/);
  });

  it("throws when the payload cannot fit one record", async () => {
    const { instance } = await provider(() => new Response(null, { status: 201 }));
    const base = await message();

    await expect(
      instance.send({ ...base, body: "x".repeat(MAX_PAYLOAD_BYTES + 100) }),
    ).rejects.toThrow(/limit/);
  });
});
