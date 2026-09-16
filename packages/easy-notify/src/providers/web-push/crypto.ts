import { decodeBase64UrlBytes, encodeBase64Url } from "../../core/base64url";

/**
 * VAPID (RFC 8292) and aes128gcm payload encryption (RFC 8291 over RFC 8188),
 * on Web Crypto.
 *
 * The `web-push` package is node:crypto only, so it cannot run on Cloudflare
 * Workers or Vercel Edge — the runtimes this library targets. Everything here
 * uses crypto.subtle and therefore runs anywhere the rest of the package does.
 */

const utf8 = (value: string) => new TextEncoder().encode(value);

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function requireBytes(value: string, label: string, length?: number): Uint8Array<ArrayBuffer> {
  const bytes = decodeBase64UrlBytes(value);
  if (!bytes) throw new Error(`${label} is not valid base64url`);
  if (length !== undefined && bytes.length !== length) {
    throw new Error(`${label} must be ${length} bytes, got ${bytes.length}`);
  }
  return bytes;
}

/** Web Crypto's HKDF does extract and expand in one call. */
async function hkdf(
  // Uint8Array<ArrayBuffer>, not bare Uint8Array: the latter widens to
  // ArrayBufferLike, which Web Crypto will not accept as a BufferSource.
  salt: Uint8Array<ArrayBuffer>,
  ikm: Uint8Array<ArrayBuffer>,
  info: Uint8Array<ArrayBuffer>,
  length: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt, info },
    key,
    length * 8,
  );
  return new Uint8Array(bits);
}

export const RECORD_SIZE = 4096;
/** One record: record size less the padding delimiter and the GCM tag. */
export const MAX_PAYLOAD_BYTES = RECORD_SIZE - 17;

export type EncryptedPush = {
  body: Uint8Array<ArrayBuffer>;
  salt: Uint8Array<ArrayBuffer>;
  serverPublicKey: Uint8Array<ArrayBuffer>;
};

/**
 * RFC 8291 §3.4 then RFC 8188 §2.
 *
 * `salt` and `serverKeys` are injectable so tests can pin them; production
 * always generates fresh ones, and reusing a salt with the same key would be
 * catastrophic for GCM.
 */
export async function encryptPayload(
  plaintext: Uint8Array<ArrayBuffer>,
  userAgentPublicKey: string,
  authSecret: string,
  overrides?: { salt?: Uint8Array<ArrayBuffer>; serverKeys?: CryptoKeyPair },
): Promise<EncryptedPush> {
  if (plaintext.length > MAX_PAYLOAD_BYTES) {
    throw new Error(`push payload is ${plaintext.length} bytes; the limit is ${MAX_PAYLOAD_BYTES}`);
  }

  const uaPublic = requireBytes(userAgentPublicKey, "p256dh", 65);
  const auth = requireBytes(authSecret, "auth", 16);

  const salt = overrides?.salt
    ? new Uint8Array(overrides.salt)
    : crypto.getRandomValues(new Uint8Array(16));

  const serverKeys =
    overrides?.serverKeys ??
    (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]));

  const serverPublic = new Uint8Array(
    await crypto.subtle.exportKey("raw", serverKeys.publicKey),
  ) as Uint8Array<ArrayBuffer>;

  const uaKey = await crypto.subtle.importKey(
    "raw",
    uaPublic,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );

  const shared = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, serverKeys.privateKey, 256),
  );

  // The receiver's key comes first; swapping the order yields a key the
  // browser cannot derive, and the push simply never decrypts.
  const keyInfo = concat(utf8("WebPush: info"), new Uint8Array([0]), uaPublic, serverPublic);
  const ikm = await hkdf(auth, shared, keyInfo, 32);

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

  const aesKey = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);

  // 0x02 marks the final record. 0x01 would mean "more records follow" and the
  // receiver would wait for one that never arrives.
  const padded = concat(plaintext, new Uint8Array([2]));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aesKey, padded),
  );

  // RFC 8188 header: salt(16) | rs(4, big endian) | idlen(1) | keyid
  const header = new Uint8Array(21 + serverPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE, false);
  header[20] = serverPublic.length;
  header.set(serverPublic, 21);

  return { body: concat(header, ciphertext), salt, serverPublicKey: serverPublic };
}

export type VapidKeys = { publicKey: string; privateKey: string };

/** A VAPID keypair in the base64url form every push library uses. */
export async function generateVapidKeys(): Promise<VapidKeys> {
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);

  const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey));
  const jwk = await crypto.subtle.exportKey("jwk", keys.privateKey);

  if (!jwk.d) throw new Error("generated key has no private component");
  return { publicKey: encodeBase64Url(publicKey), privateKey: jwk.d };
}

/**
 * VAPID keys are distributed as a raw public point plus a bare scalar, but Web
 * Crypto will only import a private EC key as JWK — which needs x and y. They
 * are recovered by slicing the uncompressed public point.
 */
async function importVapidKey(keys: VapidKeys): Promise<CryptoKey> {
  const publicKey = requireBytes(keys.publicKey, "vapid publicKey", 65);
  if (publicKey[0] !== 0x04) throw new Error("vapid publicKey must be an uncompressed EC point");

  return crypto.subtle.importKey(
    "jwk",
    {
      kty: "EC",
      crv: "P-256",
      x: encodeBase64Url(publicKey.slice(1, 33)),
      y: encodeBase64Url(publicKey.slice(33, 65)),
      d: keys.privateKey,
      ext: true,
    },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
}

export type VapidOptions = {
  subject: string;
  keys: VapidKeys;
  /** Injectable for tests; VAPID tokens are short-lived. */
  now?: Date;
  ttlSeconds?: number;
};

/** RFC 8292 §2: an ES256 JWT scoped to the push service origin. */
export async function vapidAuthorization(endpoint: string, options: VapidOptions): Promise<string> {
  if (!/^(mailto:|https:)/.test(options.subject)) {
    throw new Error('vapid subject must be a "mailto:" or "https:" URL');
  }

  const now = options.now ?? new Date();
  const header = { typ: "JWT", alg: "ES256" };
  const claims = {
    // Origin only: a token scoped to the full endpoint is rejected.
    aud: new URL(endpoint).origin,
    exp: Math.floor(now.getTime() / 1000) + (options.ttlSeconds ?? 12 * 3600),
    sub: options.subject,
  };

  const signingInput = `${encodeBase64Url(JSON.stringify(header))}.${encodeBase64Url(
    JSON.stringify(claims),
  )}`;

  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    await importVapidKey(options.keys),
    utf8(signingInput),
  );

  // Web Crypto emits raw r||s, which is what JWS ES256 wants — no DER unwrap.
  const jwt = `${signingInput}.${encodeBase64Url(new Uint8Array(signature))}`;
  return `vapid t=${jwt}, k=${options.keys.publicKey}`;
}
