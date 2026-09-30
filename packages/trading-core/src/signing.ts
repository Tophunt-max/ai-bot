/**
 * HMAC request signing shared by the Worker (control plane) and the Execution Gateway.
 * signature = hex(HMAC-SHA256(secret, `${timestamp}.${METHOD}.${path}.${body}`)), 30s replay window.
 * Uses WebCrypto only (works in Workers, Node 22+, and tests).
 */
const enc = new TextEncoder();

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function signRequest(
  secret: string,
  method: string,
  path: string,
  body: string,
  ts = Date.now(),
): Promise<{ "X-ATB-Timestamp": string; "X-ATB-Signature": string }> {
  const sig = await hmacSha256Hex(secret, `${ts}.${method.toUpperCase()}.${path}.${body}`);
  return { "X-ATB-Timestamp": String(ts), "X-ATB-Signature": sig };
}

export async function verifySignedRequest(
  secret: string,
  method: string,
  path: string,
  body: string,
  timestamp: string | undefined,
  signature: string | undefined,
  now = Date.now(),
  windowMs = 30_000,
): Promise<boolean> {
  if (!secret || !timestamp || !signature) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > windowMs) return false;
  const expected = await hmacSha256Hex(secret, `${ts}.${method.toUpperCase()}.${path}.${body}`);
  return timingSafeEqual(expected, signature);
}
