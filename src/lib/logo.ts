// Route external token-logo URLs through our own /api/logo proxy so the browser
// always loads them from dexvra's domain. External CDNs (dexscreener /
// GeckoTerminal / CoinGecko) hotlink-block, rate-limit, or CORS-block direct
// <img> loads from another origin — which silently dropped every logo to the
// gradient placeholder. Same-origin uploads (/api/media/…), data: URIs and
// already-proxied URLs pass through untouched.
export function logoSrc(url?: string | null): string | undefined {
  if (!url) return undefined;
  const u = String(url).trim();
  if (!u) return undefined;
  if (u.startsWith("/") || u.startsWith("data:")) return u; // same-origin / inline
  if (/^https?:\/\//i.test(u)) return `/api/logo?u=${encodeURIComponent(u)}`;
  return u;
}
