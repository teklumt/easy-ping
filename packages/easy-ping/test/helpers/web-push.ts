import { expect } from "vitest";
import { decodeBase64Url, decodeBase64UrlBytes, encodeBase64Url } from "../../src/core/base64url";

export const utf8 = (value: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(value);

export function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

export type Subscriber = Awaited<ReturnType<typeof createSubscriber>>;

/** Stands in for a browser: an ECDH keypair plus a 16-byte auth secret. */
export async function createSubscriber(endpoint = "https://push.example.com/sub/abc") {
  const keys = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ]);
  const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));

  return {
    endpoint,
    privateKey: keys.privateKey,
    publicKey,
    authSecret: auth,
    subscription: {
      endpoint,
      keys: { p256dh: encodeBase64Url(publicKey), auth: encodeBase64Url(auth) },
    },
  };
}

async function hkdf(
  salt: Uint8Array<ArrayBuffer>,
  ikm: Uint8Array<ArrayBuffer>,
  info: Uint8Array<ArrayBuffer>,
  length: number,
) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(
    await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, length * 8),
  );
}

/**
 * The receiving half of RFC 8291, written from the spec rather than by reusing
 * the sender's helpers. Round-tripping through the same code would pass even
 * with a symmetric bug — a wrong info string used on both sides, say.
 */
export async function decryptAsBrowser(
  body: Uint8Array<ArrayBuffer>,
  subscriber: Subscriber,
): Promise<string> {
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);

  const salt = body.slice(0, 16);
  const recordSize = view.getUint32(16, false);
  const keyIdLength = body[20] ?? 0;
  const serverPublic = body.slice(21, 21 + keyIdLength);
  const ciphertext = body.slice(21 + keyIdLength);

  expect(recordSize).toBe(4096);
  expect(keyIdLength).toBe(65);

  const serverKey = await crypto.subtle.importKey(
    "raw",
    serverPublic,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );

  const shared = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: serverKey }, subscriber.privateKey, 256),
  );

  const keyInfo = concat(
    utf8("WebPush: info"),
    new Uint8Array([0]),
    subscriber.publicKey,
    serverPublic,
  );

  const ikm = await hkdf(subscriber.authSecret, shared, keyInfo, 32);
  const cek = await hkdf(
    salt,
    ikm,
    concat(utf8("Content-Encoding: aes128gcm"), new Uint8Array([0])),
    16,
  );
  const nonce = await hkdf(
    salt,
    ikm,
    concat(utf8("Content-Encoding: nonce"), new Uint8Array([0])),
    12,
  );

  const aesKey = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
  const padded = new Uint8Array(
    await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, aesKey, ciphertext),
  );

  expect(padded.at(-1)).toBe(2);
  return new TextDecoder().decode(padded.slice(0, -1));
}

/** What a push service does with the Authorization header before accepting. */
export async function verifyVapidHeader(
  header: string,
  expectedAudience: string,
): Promise<{ aud: string; sub: string; exp: number }> {
  const match = header.match(/^vapid t=([^,]+), k=(.+)$/);
  if (!match) throw new Error(`malformed vapid header: ${header}`);

  const [, token, advertisedKey] = match;
  const [encodedHeader, encodedClaims, encodedSignature] = (token as string).split(".");

  const publicKey = decodeBase64UrlBytes(advertisedKey as string);
  const signature = decodeBase64UrlBytes(encodedSignature as string);
  if (!publicKey || !signature) throw new Error("vapid key or signature is not base64url");

  const verifier = await crypto.subtle.importKey(
    "raw",
    publicKey,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );

  const valid = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    verifier,
    signature,
    utf8(`${encodedHeader}.${encodedClaims}`),
  );
  if (!valid) throw new Error("vapid signature does not verify");

  const claims = JSON.parse(decodeBase64Url(encodedClaims as string) ?? "{}");
  if (claims.aud !== expectedAudience) {
    throw new Error(`vapid aud is ${claims.aud}, expected ${expectedAudience}`);
  }
  return claims;
}
