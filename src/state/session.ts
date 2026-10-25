import { randomUUID } from "node:crypto";

const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/**
 * Generate a compact session id: a random 16-byte UUID, base62-encoded to a
 * ~22-character token (128 bits → 22 base62 digits). The token is suitable
 * for display, targeting, and naming session-scoped artifacts.
 */
export function newSessionId(): string {
  const hex = randomUUID().replace(/-/g, "");
  let n = BigInt(`0x${hex}`);
  if (n === 0n) return "0".repeat(22);
  let out = "";
  while (n > 0n) {
    out = ALPHABET[Number(n % 62n)]! + out;
    n /= 62n;
  }
  return out.padStart(22, "0");
}
