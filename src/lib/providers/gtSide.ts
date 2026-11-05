// A PORT of shared/geckoterminal/poolSide.js (the bot and the trade bot are
// CommonJS packages this Next build has never imported). gtSide.test.ts LOADS
// the shared module and fails if the two ever answer a fixture differently.
//
// GeckoTerminal returns a token's pools on EITHER side. A pool where this token
// is the QUOTE is a stranger's market — its change, volume, counts and the
// first half of its name are the BASE token's — which is how $BTC was published
// as $LTC (2026-11-05, on DexScreener; these are the GT readers of the same
// question). A pool whose relationships are ABSENT keeps its old treatment.

export interface GtRel {
  data?: { id?: string } | null;
}
export interface GtSided {
  id?: string;
  relationships?: { base_token?: GtRel; quote_token?: GtRel } & Record<string, unknown>;
}

/** The address out of a relationship id "<network>_<address>". */
export function relAddr(rel: GtRel | undefined): string {
  const id = rel?.data?.id;
  if (typeof id !== "string") return "";
  const i = id.indexOf("_");
  return i >= 0 ? id.slice(i + 1) : "";
}

/** EVM hex compares case-insensitively; base58 is case-SENSITIVE. */
export function sameAddr(a: unknown, b: unknown): boolean {
  const x = String(a ?? "").trim();
  const y = String(b ?? "").trim();
  if (!x || !y) return false;
  return /^0x/i.test(x) ? x.toLowerCase() === y.toLowerCase() : x === y;
}

export function gtSideOf(pool: GtSided | undefined | null, address: string): "base" | "quote" | null {
  const rel = pool?.relationships;
  if (!rel) return null;
  if (sameAddr(relAddr(rel.base_token), address)) return "base";
  if (sameAddr(relAddr(rel.quote_token), address)) return "quote";
  return null;
}

/** The pools that may describe `address` — never one positively quote-side —
 *  base-side first, otherwise in the order given. */
export function ownOrdered<T extends GtSided>(pools: T[], address: string): T[] {
  const rank = (p: T) => (gtSideOf(p, address) === "base" ? 0 : 1);
  return pools
    .map((p, i) => ({ p, i }))
    .filter(({ p }) => p != null && gtSideOf(p, address) !== "quote")
    .sort((a, b) => rank(a.p) - rank(b.p) || a.i - b.i)
    .map(({ p }) => p);
}
