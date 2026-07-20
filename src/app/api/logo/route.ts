import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Server-side image proxy for external token logos. The browser can't reliably
// hotlink dexscreener / GeckoTerminal / CoinGecko CDNs (Referer + CORS +
// rate-limit), so those <img> loads intermittently failed and every token fell
// back to the gradient placeholder. We fetch server-side (no cross-origin
// Referer) and serve the bytes from our own domain, cached hard. A failure
// returns 404 so the <Coin> component's onError → emoji fallback still fires.
// SSRF-guarded by an image-host allowlist + https-only.
const ALLOW = [
  "dexscreener.com",
  "geckoterminal.com",
  "coingecko.com",
  "dextools.io",
  "githubusercontent.com",
  "imagedelivery.net",
  "ipfs.io",
  "cloudflare-ipfs.com",
  "arweave.net",
  "twimg.com",
  "cryptologos.cc",
];

function allowed(u: URL): boolean {
  if (u.protocol !== "https:") return false;
  const h = u.hostname.toLowerCase();
  return ALLOW.some((d) => h === d || h.endsWith(`.${d}`));
}

export async function GET(req: NextRequest) {
  const raw = req.nextUrl.searchParams.get("u");
  if (!raw) return new NextResponse(null, { status: 400 });
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return new NextResponse(null, { status: 400 });
  }
  if (!allowed(url)) return new NextResponse(null, { status: 400 });
  try {
    const up = await fetch(url.toString(), {
      headers: { "user-agent": "Mozilla/5.0 (compatible; DexvraLogo/1.0)", accept: "image/*,*/*" },
      signal: AbortSignal.timeout(8000),
      redirect: "follow",
    });
    if (!up.ok) return new NextResponse(null, { status: 404 });
    const ct = up.headers.get("content-type") || "image/png";
    if (!/^image\//i.test(ct)) return new NextResponse(null, { status: 404 });
    const buf = Buffer.from(await up.arrayBuffer());
    if (!buf.length || buf.length > 3_000_000) return new NextResponse(null, { status: 404 });
    return new NextResponse(buf, {
      status: 200,
      headers: {
        "content-type": ct,
        "cache-control": "public, max-age=86400, s-maxage=604800, stale-while-revalidate=86400",
      },
    });
  } catch {
    return new NextResponse(null, { status: 502 });
  }
}
