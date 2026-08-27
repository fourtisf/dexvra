import { dexLogoUrl } from "@/lib/dexscreener";
import type { BoardToken } from "@/lib/types";

// Every listing on Dexvra shows a logo — no exceptions. Server-side the
// provider resolves one (admin upload → DexScreener API → DexScreener CDN →
// GeckoTerminal); client-side `<TokenLogo>` walks the candidates below and,
// if every image 404s or the visitor is offline, draws a monogram mark. So a
// token card can degrade in quality but never to a blank or a random emoji.

export type LogoSource = Pick<BoardToken, "logoUrl" | "chain" | "address">;

/** Ordered, de-duplicated image URLs to try for a token, best first. */
export function logoCandidates(t: LogoSource): string[] {
  const out: string[] = [];
  for (const url of [t.logoUrl, dexLogoUrl(t.chain, t.address, "lg"), dexLogoUrl(t.chain, t.address)]) {
    if (url && !out.includes(url)) out.push(url);
  }
  return out;
}

/** Short mark drawn when no image resolves — the ticker is the most
 *  recognizable thing we always have. Falls back to the token name, then to a
 *  neutral glyph, so this never returns an empty string. `max` trims it for
 *  small coins (the ticker, search chips) where 3 characters won't fit. */
export function monogramOf(symbol: string, name?: string, max = 3): string {
  const clean = (s: string) => s.replace(/^\$+/, "").replace(/[^A-Za-z0-9]/g, "");
  const src = clean(symbol) || clean(name ?? "");
  if (!src) return "?";
  return src.slice(0, Math.max(1, max)).toUpperCase();
}
