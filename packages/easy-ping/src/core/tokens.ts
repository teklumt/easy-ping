import { decodeBase64Url, decodeBase64UrlBytes, encodeBase64Url } from "./base64url";

export type TokenClaims = {
  /** Subject — the user the token acts for. */
  uid: string;
  /** What the token is allowed to do. Verification requires an exact match. */
  purpose: string;
  /** Expiry, epoch seconds. */
  exp: number;
  /** Issued at, epoch seconds. Set by signToken; lets a route refuse a token older than a later change. */
  iat?: number;
  /** Free-form, purpose-specific. */
  data?: Record<string, string>;
};

const encoder = new TextEncoder();

// Changing this invalidates every outstanding token. Bump it on purpose only.
const KEY_SALT = encoder.encode("easy-ping/tokens/v1");

/**
 * One HMAC key per purpose, derived from the master secret with HKDF. A key
 * that can sign unsubscribe links cannot sign anything else, so a plugin
 * handed the unsubscribe key gets exactly that and no more.
 */
async function hmacKey(secret: string, purpose: string): Promise<CryptoKey> {
  const master = await crypto.subtle.importKey("raw", encoder.encode(secret), "HKDF", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: KEY_SALT, info: encoder.encode(purpose) },
    master,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign", "verify"],
  );
}

export async function signToken(
  secret: string,
  claims: TokenClaims,
  now: Date = new Date(),
): Promise<string> {
  const stamped: TokenClaims = { ...claims, iat: claims.iat ?? Math.floor(now.getTime() / 1000) };
  const body = encodeBase64Url(JSON.stringify(stamped));
  const signature = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(secret, claims.purpose),
    encoder.encode(body),
  );
  return `${body}.${encodeBase64Url(new Uint8Array(signature))}`;
}

/** null for every failure mode. Distinguishing them tells an attacker which part to fix. */
export async function verifyToken(
  secret: string,
  token: string,
  purpose: string,
  now: Date = new Date(),
): Promise<TokenClaims | null> {
  const separator = token.lastIndexOf(".");
  if (separator <= 0) return null;

  const body = token.slice(0, separator);
  const signature = decodeBase64UrlBytes(token.slice(separator + 1));
  if (!signature) return null;

  // Verified under the key for the purpose this route expects, before the
  // body is even parsed. A token minted for another purpose fails here.
  // crypto.subtle.verify is constant-time.
  const valid = await crypto.subtle.verify(
    "HMAC",
    await hmacKey(secret, purpose),
    signature,
    encoder.encode(body),
  );
  if (!valid) return null;

  const decoded = decodeBase64Url(body);
  if (!decoded) return null;

  let claims: TokenClaims;
  try {
    claims = JSON.parse(decoded) as TokenClaims;
  } catch {
    return null;
  }

  if (typeof claims?.uid !== "string" || typeof claims.exp !== "number") return null;
  if (claims.purpose !== purpose) return null;
  if (claims.exp * 1000 <= now.getTime()) return null;
  if (claims.iat !== undefined && typeof claims.iat !== "number") return null;

  if (claims.data !== undefined) {
    if (typeof claims.data !== "object" || claims.data === null || Array.isArray(claims.data)) {
      return null;
    }
    for (const value of Object.values(claims.data)) {
      if (typeof value !== "string") return null;
    }
  }

  return claims;
}

export const DEFAULT_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
/** Ninety days. A link that must outlive this should be re-issued, not made immortal. */
export const MAX_TOKEN_TTL_SECONDS = 90 * 24 * 60 * 60;

export const expiresIn = (seconds: number, now: Date = new Date()): number =>
  Math.floor(now.getTime() / 1000) + Math.min(Math.max(seconds, 0), MAX_TOKEN_TTL_SECONDS);

export type SignRequest = {
  uid: string;
  purpose: string;
  data?: Record<string, string>;
  /** Defaults to 30 days, capped at 90. */
  ttlSeconds?: number;
};

/**
 * What a plugin gets instead of the secret: a signer that only mints tokens
 * for the purposes its own `signed` routes declared.
 */
export function createScopedSigner(
  secret: string,
  pluginId: string,
  purposes: ReadonlySet<string>,
  onViolation: (message: string) => Error,
): (request: SignRequest) => Promise<string> {
  return (request) => {
    if (!purposes.has(request.purpose)) {
      throw onViolation(
        `plugin "${pluginId}" tried to sign a token for purpose "${request.purpose}", ` +
          "which none of its signed routes declare.",
      );
    }
    return signToken(secret, {
      uid: request.uid,
      purpose: request.purpose,
      exp: expiresIn(request.ttlSeconds ?? DEFAULT_TOKEN_TTL_SECONDS),
      ...(request.data ? { data: request.data } : {}),
    });
  };
}
