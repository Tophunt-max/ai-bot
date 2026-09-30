// Usage: pnpm --filter @atb/api run hash-password -- 'your-long-password'
// Prints a PBKDF2 hash for the OWNER_PASSWORD_HASH secret (same format as src/lib/crypto.ts).
import { webcrypto as crypto } from "node:crypto";

const password = process.argv[2];
if (!password || password.length < 12) {
  console.error("password (>= 12 chars) required");
  process.exit(1);
}
const iterations = 100_000;
const salt = crypto.getRandomValues(new Uint8Array(16));
const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, [
  "deriveBits",
]);
const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
const b64 = (u) => Buffer.from(u).toString("base64");
console.info(`pbkdf2$${iterations}$${b64(salt)}$${b64(new Uint8Array(bits))}`);
