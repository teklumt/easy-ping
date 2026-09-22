import { decodeBase64Url, decodeBase64UrlBytes, encodeBase64Url } from "./base64url";

export type TokenClaims = {
  /** Subject — the user the token acts for. */
  uid: string;
  /** What the token is allowed to do. Verification requires an exact match. */
  purpose: string;
  /** Expiry, epoch seconds. */
  exp: number;
  /** Free-form, purpose-specific. */
  data?: Record<string, string>;
};

const encoder = new TextEncoder();

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function signToken(secret: string, claims: TokenClaims): Promise<string> {
  const body = encodeBase64Url(JSON.stringify(claims));
  const signature = await crypto.subtle.sign("HMAC", await hmacKey(secret), encoder.encode(body));
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

  // crypto.subtle.verify is constant-time.
  const valid = await crypto.subtle.verify(
    "HMAC",
    await hmacKey(secret),
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
  // Scoped so an unsubscribe token can never be replayed against another route.
  if (claims.purpose !== purpose) return null;
  if (claims.exp * 1000 <= now.getTime()) return null;

  return claims;
}

export const DEFAULT_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

export const expiresIn = (seconds: number, now: Date = new Date()): number =>
  Math.floor(now.getTime() / 1000) + seconds;
