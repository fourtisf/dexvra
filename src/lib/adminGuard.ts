import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { SESSION_COOKIE, verifySession } from "./auth";

/** True when the request carries a valid admin session cookie. Middleware
 *  already gates admin routes; this is defense-in-depth inside each handler. */
export async function isAdmin(req: NextRequest): Promise<boolean> {
  return (await verifySession(req.cookies.get(SESSION_COOKIE)?.value)) != null;
}

export const unauthorized = () =>
  NextResponse.json({ error: "Unauthorized" }, { status: 401 });

/** Client IP for rate-limit keys. Must NOT trust the client-controlled leftmost
 *  X-Forwarded-For hop: with nginx's standard `$proxy_add_x_forwarded_for` the
 *  proxy APPENDS the real peer, so the first XFF entry is attacker-supplied.
 *  Prefer X-Real-IP (nginx sets it from $remote_addr = true TCP peer); if only
 *  XFF is present, use the RIGHTMOST entry (the hop nginx appended). */
export function clientIp(req: NextRequest): string {
  const real = req.headers.get("x-real-ip");
  if (real && real.trim()) return real.trim();
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const parts = xff.split(",").map((s) => s.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1];
  }
  return "local";
}
