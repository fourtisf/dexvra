// Edge-safe admin session tokens — HMAC-SHA256 via Web Crypto so the SAME code
// runs in the Edge middleware AND Node route handlers. Do NOT import node:crypto
// here (it would break the middleware bundle). Password hashing (scrypt) lives
// in lib/password.ts and is only used from Node routes.

export const SESSION_COOKIE = "dxv_session";
const TTL_MS = 8 * 60 * 60 * 1000; // 8 hours

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fromB64url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function secret(): string {
  const s = process.env.ADMIN_SESSION_SECRET;
  if (!s || s.length < 16) {
    // Fail closed: without a strong secret we cannot issue/verify sessions.
    throw new Error("ADMIN_SESSION_SECRET is missing or shorter than 16 chars");
  }
  return s;
}

async function hmacKey(usages: KeyUsage[]): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    enc.encode(secret()),
    { name: "HMAC", hash: "SHA-256" },
    false,
    usages,
  );
}

interface Payload {
  sub: string; // username
  exp: number; // epoch ms
}

/** Issue a signed session token for `sub`. */
export async function signSession(sub: string): Promise<string> {
  const payload: Payload = { sub, exp: Date.now() + TTL_MS };
  const body = b64url(enc.encode(JSON.stringify(payload)));
  const key = await hmacKey(["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(body));
  return `${body}.${b64url(new Uint8Array(sig))}`;
}

/** Verify a session token; returns the payload or null. Never throws. */
export async function verifySession(token?: string | null): Promise<{ sub: string } | null> {
  if (!token || token.indexOf(".") < 0) return null;
  const dot = token.indexOf(".");
  const body = token.slice(0, dot);
  const sigPart = token.slice(dot + 1);
  try {
    const key = await hmacKey(["verify"]);
    const ok = await crypto.subtle.verify("HMAC", key, fromB64url(sigPart), enc.encode(body));
    if (!ok) return null;
    const payload = JSON.parse(dec.decode(fromB64url(body))) as Payload;
    if (typeof payload.exp !== "number" || Date.now() > payload.exp) return null;
    if (typeof payload.sub !== "string" || !payload.sub) return null;
    return { sub: payload.sub };
  } catch {
    return null;
  }
}

/** Cookie attributes — Secure only in production so local http dev still works. */
export function sessionCookieOptions(maxAgeSec = TTL_MS / 1000) {
  return {
    httpOnly: true,
    sameSite: "strict" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: maxAgeSec,
  };
}

export const SESSION_TTL_MS = TTL_MS;
