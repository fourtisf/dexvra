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

/** Best-effort client IP from proxy headers (nginx sets X-Forwarded-For). */
export function clientIp(req: NextRequest): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  return req.headers.get("x-real-ip") || "local";
}
