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
  // ⚠️ EVERY other scheme goes to the proxy, not just http(s). A launchpad's
  // on-chain metadata gives `ipfs://<cid>`, and no <img> on earth loads that:
  // returning it verbatim handed the browser a URL it could only fail on, so a
  // token whose artwork we HAD still drew a monogram. The proxy turns it into a
  // gateway URL and validates the result; anything it dislikes 400s, and <Coin>
  // falls back to the monogram exactly as before.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) return `/api/logo?u=${encodeURIComponent(u)}`;
  return u;
}
