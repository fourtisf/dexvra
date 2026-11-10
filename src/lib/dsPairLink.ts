/**
 * "Is this a DexScreener PAIR — and whose?" for the web app's search box.
 *
 * ⚠️ A PORT, and a port is a second owner. The rule lives in
 * `shared/dexscreener/pair.js` and both bots require it; this app is TypeScript
 * on a Next build that has never imported a CommonJS module from outside
 * `src/`, so it carries a copy — and `dsPairLink.test.ts` loads the original
 * and fails if the two ever answer differently. Same arrangement as
 * `notAProject.ts` and `market:check`'s ported chain map.
 *
 * Why the search box needs it: the address in a DexScreener URL is the POOL,
 * not the token (the original's header has the whole report). Pasting
 * `dexscreener.com/bsc/0x…` into dexvra.io answered "No token matches", and
 * pasting the pair address on its own answered "That contract isn't on any
 * network we index" — about a token trading perfectly well. Alias-free and
 * pure so the tests can CALL it.
 */

const ADDR_SEG = "[A-Za-z0-9_:\\-]{32,120}";
export const LINK_RE = new RegExp(`^(?:https?:\\/\\/)?(?:www\\.)?dexscreener\\.com\\/([a-z0-9-]+)\\/(${ADDR_SEG})(?:[/?#].*)?$`, "i");
export const SEARCH_RE = new RegExp(`^(?:https?:\\/\\/)?(?:www\\.)?dexscreener\\.com\\/search\\?(?:.*&)?q=(${ADDR_SEG})(?:[&#].*)?$`, "i");

/** A dexscreener.com link → `{ slug, address }` (slug null for a search link),
 *  or null. The WHOLE input must be the link: one inside a sentence is talk. */
export function parseDsLink(text: string): { slug: string | null; address: string } | null {
  const s = String(text || "").trim();
  if (!s || /\s/.test(s)) return null;
  const q = SEARCH_RE.exec(s);
  if (q) return { slug: null, address: q[1] };
  const m = LINK_RE.exec(s);
  if (!m) return null;
  return { slug: m[1].toLowerCase(), address: m[2] };
}

/** Same account? EVM hex is case-insensitive; base58 and the rest are exact. */
export function sameAddress(a: unknown, b: unknown): boolean {
  const x = String(a || "");
  const y = String(b || "");
  if (!x || !y) return false;
  if (/^0x[0-9a-f]+$/i.test(x) && /^0x[0-9a-f]+$/i.test(y)) return x.toLowerCase() === y.toLowerCase();
  return x === y;
}

export interface DsPairRecord {
  chainId?: string;
  pairAddress?: string;
  baseToken?: { address?: string; name?: string; symbol?: string };
  quoteToken?: { address?: string; name?: string; symbol?: string };
  priceUsd?: string;
  fdv?: number;
  marketCap?: number;
  liquidity?: { usd?: number };
  info?: { imageUrl?: string };
}

const liq = (p: DsPairRecord): number => {
  const n = Number(p.liquidity?.usd);
  return Number.isFinite(n) ? n : 0;
};

/** The pair in a DexScreener answer whose address IS `address` (exact — never
 *  "the first pair"), deepest first, or null. Reads `pairs: [...]` and the
 *  older `pair: {...}` spelling alike. */
export function pickPair(body: unknown, address: string): DsPairRecord | null {
  const b = (body ?? {}) as { pairs?: unknown; pair?: unknown };
  const list: DsPairRecord[] = [];
  if (Array.isArray(b.pairs)) list.push(...(b.pairs as DsPairRecord[]));
  if (b.pair && typeof b.pair === "object") list.push(b.pair as DsPairRecord);
  const hits = list.filter((p) => p && sameAddress(p.pairAddress, address) && p.baseToken?.address);
  if (!hits.length) return null;
  hits.sort((x, y) => liq(y) - liq(x));
  return hits[0];
}

/** The address as DexScreener keys it: EVM hex LOWERCASED (an explorer paste is
 *  the EIP-55 checksum spelling), everything else untouched — a lowercased
 *  base58 pool is a different account. */
export const dsQuery = (address: string): string => (/^0x[0-9a-f]+$/i.test(address) ? address.toLowerCase() : address);
