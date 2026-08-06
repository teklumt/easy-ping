// Web APIs, not Buffer: this runs on Workers and Vercel Edge.

export function encodeBase64Url(input: string | Uint8Array): string {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Uint8Array<ArrayBuffer>: bare Uint8Array widens and is not a BufferSource.
export function decodeBase64UrlBytes(value: string): Uint8Array<ArrayBuffer> | null {
  try {
    const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

export function decodeBase64Url(value: string): string | null {
  const bytes = decodeBase64UrlBytes(value);
  return bytes ? new TextDecoder().decode(bytes) : null;
}
