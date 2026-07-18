// Server-only: uses node:crypto. Only imported from Node route handlers.
import { scryptSync, randomBytes, timingSafeEqual } from "node:crypto";

// scrypt password hashing — Node-only (used from the login route, which runs on
// the Node runtime). Format: "scrypt$<saltHex>$<hashHex>".

const KEYLEN = 32;

// Note: separator is ":" (not "$") because .env parsers (dotenv-expand, used by
// Next.js) treat "$" as variable interpolation and would corrupt the hash.
export function hashPassword(pw: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(pw, salt, KEYLEN);
  return `scrypt:${salt.toString("hex")}:${hash.toString("hex")}`;
}

/** Constant-time verify of `pw` against a stored "scrypt:salt:hash". */
export function verifyPassword(pw: string, stored: string | undefined): boolean {
  if (!stored) return false;
  const parts = stored.split(":");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const salt = Buffer.from(parts[1], "hex");
  const expected = Buffer.from(parts[2], "hex");
  if (salt.length === 0 || expected.length === 0) return false;
  let actual: Buffer;
  try {
    actual = scryptSync(pw, salt, expected.length);
  } catch {
    return false;
  }
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Constant-time string compare (for the username). */
export function safeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) {
    // Still spend the compare to avoid a length-based timing signal.
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}
