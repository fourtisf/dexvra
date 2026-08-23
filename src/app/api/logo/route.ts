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
//
// ⚠️ THE ALLOWLIST IS PART OF "every token has a logo", NOT JUST SECURITY.
// A host that is missing here is a real, working logo url that renders as a
// monogram — refused by us, silently, with nothing in the UI to say so. That
// is how a token whose artwork lives on pump.fun's own IPFS gateway looked
// exactly like a token with no artwork at all. So the list carries the places
// token images actually live: the two indexes, the curated ones, the wallets'
// asset repos, and the IPFS gateways every launchpad mints through.
const ALLOW = [
  // indexes + curators
  "dexscreener.com",
  "geckoterminal.com",
  "coingecko.com",
  "coinmarketcap.com",
  "dextools.io",
  // wallets / token lists / DEX front-ends that host their own icon sets
  "githubusercontent.com",
  "trustwallet.com",
  "jup.ag",
  "raydium.io",
  "pancakeswap.finance",
  "1inch.io",
  // generic CDNs the above hand off to. ⚠️ Kept NARROW on purpose: a bare
  // `cloudfront.net` would make this an image proxy for every AWS customer
  // alive, which is somebody else's bandwidth and somebody else's content
  // served from our domain.
  "imagedelivery.net",
  // IPFS / Arweave — where a launchpad's metadata points. pump.fun's own
  // gateway (pump.mypinata.cloud) is under mypinata.cloud.
  "ipfs.io",
  "cloudflare-ipfs.com",
  "mypinata.cloud",
  "pinata.cloud",
  "nftstorage.link",
  "w3s.link",
  "dweb.link",
  "cf-ipfs.com",
  "arweave.net",
  "irys.xyz",
  // socials, for a project whose only artwork is its avatar
  "twimg.com",
  "cryptologos.cc",
];

/** A public IPFS gateway for `ipfs://` URIs, which is what a launchpad's
 *  on-chain metadata actually contains. Before this they were handed to the
 *  browser verbatim: no `<img>` anywhere loads an ipfs:// scheme, so the logo
 *  was lost between two systems that each had it. */
const IPFS_GATEWAY = "https://ipfs.io/ipfs/";

/** How many redirects to follow. IPFS gateways bounce to a per-CID subdomain,
 *  and CDNs bounce to their edge, so refusing redirects outright would lose
 *  real logos. */
const MAX_HOPS = 3;

function allowed(u: URL): boolean {
  if (u.protocol !== "https:") return false;
  const h = u.hostname.toLowerCase();
  return ALLOW.some((d) => h === d || h.endsWith(`.${d}`));
}

/** Anything a provider can hand us → an https URL, or null. */
function normalize(raw: string): URL | null {
  const s = raw.trim();
  if (!s) return null;
  try {
    if (/^ipfs:\/\//i.test(s)) {
      // ipfs://<cid>/<path…> and the older ipfs://ipfs/<cid> spelling.
      const path = s.replace(/^ipfs:\/\//i, "").replace(/^ipfs\//i, "");
      return path ? new URL(IPFS_GATEWAY + path) : null;
    }
    return new URL(s);
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest) {
  const raw = req.nextUrl.searchParams.get("u");
  if (!raw) return new NextResponse(null, { status: 400 });
  let url = normalize(raw);
  if (!url || !allowed(url)) return new NextResponse(null, { status: 400 });

  try {
    // ⚠️ REDIRECTS ARE FOLLOWED BY HAND, and every hop is re-checked against
    // the allowlist. `redirect: "follow"` hands the guard's whole job to the
    // upstream: an allowed host answering `302 http://169.254.169.254/…` would
    // have this server fetch its own cloud metadata and serve the bytes back.
    let res: Response | null = null;
    for (let hop = 0; hop <= MAX_HOPS; hop++) {
      res = await fetch(url.toString(), {
        headers: { "user-agent": "Mozilla/5.0 (compatible; DexvraLogo/1.0)", accept: "image/*,*/*" },
        signal: AbortSignal.timeout(8000),
        redirect: "manual",
        cache: "no-store",
      });
      if (res.status < 300 || res.status >= 400) break;
      const loc = res.headers.get("location");
      if (!loc) break;
      // A redirect's body is never read; release it or the socket stays busy
      // until the GC gets round to it, on a server doing this per token.
      void res.body?.cancel().catch(() => {});
      const next = normalize(new URL(loc, url).toString());
      if (!next || !allowed(next)) return new NextResponse(null, { status: 400 });
      url = next;
      res = null;
    }
    if (!res || !res.ok) return new NextResponse(null, { status: 404 });

    const ct = res.headers.get("content-type") || "image/png";
    if (!/^image\//i.test(ct)) {
      void res.body?.cancel().catch(() => {});
      return new NextResponse(null, { status: 404 });
    }
    // Refuse a body we would only throw away — the size check below happens
    // after the download, and a declared 50MB image is not worth fetching.
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > 3_000_000) {
      void res.body?.cancel().catch(() => {});
      return new NextResponse(null, { status: 404 });
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length || buf.length > 3_000_000) return new NextResponse(null, { status: 404 });
    return new NextResponse(buf, {
      status: 200,
      headers: {
        "content-type": ct,
        "cache-control": "public, max-age=86400, s-maxage=604800, stale-while-revalidate=86400",
        // An SVG logo is a DOCUMENT when opened directly, and a document served
        // from our own origin can carry script. Refusing SVGs would drop real
        // logos, so they are served inert instead: no sniffing, and a CSP that
        // allows the file to reference nothing at all.
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      },
    });
  } catch {
    return new NextResponse(null, { status: 502 });
  }
}
