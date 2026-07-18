import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, verifySession } from "@/lib/auth";

// ── Admin isolation ───────────────────────────────────────────────────────
// The admin panel is served ONLY on the admin host (dexvra.fun) under a secret,
// unguessable path (ADMIN_PATH, e.g. "admin-<hash>") that middleware rewrites to
// the internal /panel routes. It is invisible on the public site (dexvra.io),
// and every admin page + API is gated by a signed session cookie.

const INTERNAL = "/panel";

const adminHosts = (): string[] =>
  (process.env.ADMIN_HOSTS ?? "dexvra.fun,www.dexvra.fun")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

function isAdminHost(host: string): boolean {
  const h = host.split(":")[0].toLowerCase();
  if (adminHosts().includes(h)) return true;
  // Local dev / explicit opt-in so the panel is testable off dexvra.fun.
  if (process.env.ADMIN_ALLOW_ANY_HOST === "1") return true;
  if (process.env.NODE_ENV !== "production" && (h === "localhost" || h === "127.0.0.1")) return true;
  return false;
}

const secretPath = (): string => {
  const p = (process.env.ADMIN_PATH ?? "").trim().replace(/^\/+|\/+$/g, "");
  return p ? `/${p}` : "";
};

const notFound = () => new NextResponse("Not Found", { status: 404 });

async function authed(req: NextRequest): Promise<boolean> {
  return (await verifySession(req.cookies.get(SESSION_COOKIE)?.value)) != null;
}

export async function middleware(req: NextRequest) {
  const host = req.headers.get("host") ?? "";
  const { pathname } = req.nextUrl;
  const onAdminHost = isAdminHost(host);
  const secret = secretPath();

  // ── Public host: admin surface must not exist here at all ──────────────
  if (!onAdminHost) {
    if (
      pathname === INTERNAL ||
      pathname.startsWith(`${INTERNAL}/`) ||
      pathname.startsWith("/api/admin")
    ) {
      return notFound();
    }
    return NextResponse.next();
  }

  // ── Admin host ─────────────────────────────────────────────────────────
  // Admin API: login is open (rate-limited in the route); everything else needs
  // a valid session.
  if (pathname.startsWith("/api/admin")) {
    if (pathname === "/api/admin/login" || pathname === "/api/admin/logout") {
      return NextResponse.next();
    }
    if (!(await authed(req))) return new NextResponse("Unauthorized", { status: 401 });
    return NextResponse.next();
  }

  // Secret path → rewrite to the internal panel; require a session for anything
  // but the login screen.
  if (secret && (pathname === secret || pathname.startsWith(`${secret}/`))) {
    const rest = pathname.slice(secret.length);
    const url = req.nextUrl.clone();
    url.pathname = `${INTERNAL}${rest === "" || rest === "/" ? "" : rest}`;
    if (url.pathname !== `${INTERNAL}/login` && !(await authed(req))) {
      url.pathname = `${INTERNAL}/login`;
    }
    return NextResponse.rewrite(url);
  }

  // Direct hits on the internal path (bypassing the secret) don't exist.
  if (pathname === INTERNAL || pathname.startsWith(`${INTERNAL}/`)) {
    return notFound();
  }

  // Allow framework internals, icons, and public APIs to load on the admin host;
  // hide everything else (the public site is not served here).
  if (
    pathname.startsWith("/_next") ||
    pathname.startsWith("/api/") ||
    pathname.startsWith("/icons/") ||
    pathname === "/favicon.ico" ||
    pathname === "/manifest.webmanifest"
  ) {
    return NextResponse.next();
  }
  return notFound();
}

export const config = {
  // Run on everything except static asset outputs.
  matcher: ["/((?!_next/static|_next/image).*)"],
};
