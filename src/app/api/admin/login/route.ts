import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, sessionCookieOptions, signSession } from "@/lib/auth";
import { safeEqualStr, verifyPassword } from "@/lib/password";
import { clientIp } from "@/lib/adminGuard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Simple per-IP brute-force throttle (best-effort; resets on process restart).
const MAX_ATTEMPTS = 6;
const WINDOW_MS = 15 * 60 * 1000;
const attempts = new Map<string, { n: number; until: number }>();

export async function POST(req: NextRequest) {
  const ip = clientIp(req);
  const now = Date.now();
  const rec = attempts.get(ip);
  if (rec && rec.until > now && rec.n >= MAX_ATTEMPTS) {
    return NextResponse.json({ error: "Too many attempts — try again later." }, { status: 429 });
  }

  let body: { username?: unknown; password?: unknown } = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const username = String(body.username ?? "");
  const password = String(body.password ?? "");

  const envUser = process.env.ADMIN_USER ?? "";
  const okUser = envUser.length > 0 && safeEqualStr(username, envUser);
  const okPass = verifyPassword(password, process.env.ADMIN_PASS_HASH);

  if (!okUser || !okPass) {
    const base = rec && rec.until > now ? rec : { n: 0, until: now + WINDOW_MS };
    attempts.set(ip, { n: base.n + 1, until: base.until });
    return NextResponse.json({ error: "Invalid username or password." }, { status: 401 });
  }

  attempts.delete(ip);

  let token: string;
  try {
    token = await signSession(envUser);
  } catch {
    return NextResponse.json(
      { error: "Admin auth is not configured on the server (ADMIN_SESSION_SECRET)." },
      { status: 500 },
    );
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, token, sessionCookieOptions());
  return res;
}
