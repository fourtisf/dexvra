// DexScreener — the SECOND market source, for the tokens GeckoTerminal cannot
// see. chains.ts has documented the reason since the registry was written:
// "GeckoTerminal indexes DEX pools and misses brand-new launches… DexScreener
// carries pump.fun and day-one pairs that GT has never seen." A bot-listed
// launch an hour old is exactly that token, and until this file existed the
// comment described a provider nobody had built — every fresh listing rendered
// a fabricated ▲0.0% for its first days.
//
// Deliberately a GAP-FILLER, never a second opinion: the caller asks it only
// about addresses GT did not price, so the two sources cannot disagree about
// one token (the bot repo's two-ideas-of-whale lesson).
//
// Relative imports, not the "@/" alias — node:test resolves this file.
import { CHAINS } from "../../config/chains.ts";
import type { PeriodKey, TxSplit } from "../types.ts";
import type { LiveMarket } from "./geckoterminal.ts";

/** DS's tokens endpoint answers at most 30 addresses per request. */
export const DS_MULTI_MAX = 30;

/** Does DexScreener cover this chain at all? The chains it does not are the
 *  ones with no second source: when the shared GT budget runs dry mid-cycle,
 *  every other chain falls back here and still prices — a GT-only chain just
 *  goes dark. The scheduler orders on this, so it lives beside the map it
 *  reads rather than as a second list that drifts. */
export const dsCovers = (chainId: string): boolean => !!CHAINS[chainId]?.dexscreener;

/** Chains split into [GT-only, has-a-fallback] — the order the market cycle
 *  must spend the GT budget in. Robinhood sat at 0/66 priced while Solana sat
 *  at 162/192 for exactly this: ~19 chunks of site demand against a 15/min
 *  budget, all chains firing concurrently, and the one chain that CANNOT
 *  recover through DexScreener queueing behind seven Solana chunks that can. */
export function partitionByFallback<T extends [string, unknown]>(entries: T[]): [T[], T[]] {
  const gtOnly: T[] = [], covered: T[] = [];
  for (const e of entries) (dsCovers(e[0]) ? covered : gtOnly).push(e);
  return [gtOnly, covered];
}
const BASE = "https://api.dexscreener.com/tokens/v1";
const CHUNK_GAP_MS = 250;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface DsPair {
  chainId: string;
  pairAddress: string;
  baseToken: { address: string; name: string; symbol: string };
  quoteToken?: { address: string; name?: string; symbol?: string };
  priceUsd?: string;
  /** The BASE token's price in QUOTE-token units. */
  priceNative?: string;
  txns?: Partial<Record<"m5" | "h1" | "h6" | "h24", { buys: number; sells: number }>>;
  volume?: Partial<Record<"m5" | "h1" | "h6" | "h24", number>>;
  priceChange?: Partial<Record<"m5" | "h1" | "h6" | "h24", number>>;
  liquidity?: { usd?: number };
  fdv?: number;
  marketCap?: number;
  pairCreatedAt?: number;
  info?: { imageUrl?: string };
}

const num = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

function mapPair(p: DsPair): LiveMarket | null {
  const price = num(p.priceUsd);
  if (price == null || price <= 0) return null;
  const per = <K extends string>(o: Partial<Record<K, unknown>> | undefined, k: K) => num(o?.[k]);
  const tx = (t?: { buys: number; sells: number }): TxSplit => ({ buys: t?.buys ?? 0, sells: t?.sells ?? 0 });
  return {
    priceUsd: price,
    mcap: num(p.marketCap) ?? num(p.fdv),
    liq: num(p.liquidity?.usd),
    chg: {
      "5m": per(p.priceChange, "m5") ?? 0,
      "1h": per(p.priceChange, "h1") ?? 0,
      "6h": per(p.priceChange, "h6") ?? 0,
      "24h": per(p.priceChange, "h24") ?? 0,
    } as Record<PeriodKey, number>,
    vol: {
      "5m": per(p.volume, "m5") ?? 0,
      "1h": per(p.volume, "h1") ?? 0,
      "6h": per(p.volume, "h6") ?? 0,
      "24h": per(p.volume, "h24") ?? 0,
    } as Record<PeriodKey, number>,
    txns: { "5m": tx(p.txns?.m5), "1h": tx(p.txns?.h1), "6h": tx(p.txns?.h6), "24h": tx(p.txns?.h24) },
    ageMinutes: p.pairCreatedAt ? Math.max(0, Math.round((Date.now() - p.pairCreatedAt) / 60000)) : null,
    logoUrl: p.info?.imageUrl ?? null,
    // ⚠️ Never the DS pair address: poolAddress feeds the GeckoTerminal chart
    // embed, and a pool GT has never indexed renders as a 404 inside the token
    // page. poolstrade makes the same call for the same reason.
    poolAddress: null,
  };
}

/** Market data for listed addresses on one chain, keyed by lowercased address.
 *
 *  The endpoint is chain-scoped by PATH, so the wrong-chain pair problem the
 *  bot repo documents (a same-address deploy on another chain supplying the
 *  price) cannot arise here — but a token can still appear as the QUOTE side
 *  of someone else's pair, so only pairs whose baseToken IS the asked-for
 *  address count, and a token with several pairs is judged by its DEEPEST
 *  (a real token seen through a thin pool reads as illiquid; a thin pool seen
 *  as the token fabricates a four-figure percentage). */
export async function fetchDsMarket(
  chainId: string,
  addresses: string[],
): Promise<Map<string, LiveMarket>> {
  const ds = CHAINS[chainId]?.dexscreener;
  const out = new Map<string, LiveMarket>();
  if (!ds || addresses.length === 0) return out;

  const chunks: string[][] = [];
  for (let i = 0; i < addresses.length; i += DS_MULTI_MAX) chunks.push(addresses.slice(i, i + DS_MULTI_MAX));

  const best = new Map<string, { liq: number; m: LiveMarket }>();
  let failed = 0;
  let lastErr: unknown;
  for (let i = 0; i < chunks.length; i++) {
    if (i > 0) await sleep(CHUNK_GAP_MS);
    try {
      // Addresses go out VERBATIM — base58 is case-significant.
      const res = await fetch(`${BASE}/${ds}/${chunks[i].join(",")}`, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(9000),
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`DexScreener ${res.status} (${chainId})`);
      const pairs = ((await res.json()) ?? []) as DsPair[];
      const asked = new Set(chunks[i].map((a) => a.toLowerCase()));
      for (const p of Array.isArray(pairs) ? pairs : []) {
        const key = p.baseToken?.address?.toLowerCase();
        if (!key || !asked.has(key)) continue; // quote-side or stray pair
        const m = mapPair(p);
        if (!m) continue;
        const liq = m.liq ?? 0;
        const cur = best.get(key);
        if (!cur || liq > cur.liq) best.set(key, { liq, m });
      }
    } catch (err) {
      failed++;
      lastErr = err;
    }
  }
  if (chunks.length > 0 && failed === chunks.length)
    throw lastErr instanceof Error ? lastErr : new Error(`DexScreener failed (${chainId})`);
  for (const [k, v] of best) out.set(k, v.m);
  return out;
}

/** Below this depth a pair may not set a quote asset's price: one thin pool
 *  seen as the asset is how a wrong number reaches every launch paired with it. */
export const DS_QUOTE_MIN_LIQ_USD = 1_000;

/**
 * USD per unit of ONE token, read from EITHER side of its pairs — for a Pons
 * launch's quote asset (a tokenised stock like NVDA on Robinhood Chain).
 *
 * `fetchDsMarket` counts base-side pairs only, which is right for pricing a
 * listing and wrong here: a tokenised stock on a launchpad chain is overwhelmingly
 * the QUOTE of other people's pairs (every "Paired NVDA" launch is X/NVDA), so
 * the base-side rule answered "no price" about an asset DexScreener prices in
 * every one of those rows. On a quote-side pair DS publishes the base's USD price
 * and the base's price IN the quote, so the quote's USD price is their ratio —
 * DS's own figure, taken the other way round, not a new guess.
 *
 * ⚠️ Judged by the DEEPEST pair, and a pair under `DS_QUOTE_MIN_LIQ_USD` never
 * answers: this number multiplies every price, cap and liquidity figure of
 * every launch paired with the asset, so a dust pool is refused rather than
 * believed. Null means "no pair deep enough", never a zero.
 */
export async function fetchDsTokenUsd(chainId: string, address: string): Promise<number | null> {
  const ds = CHAINS[chainId]?.dexscreener;
  if (!ds || !address) return null;
  const res = await fetch(`${BASE}/${ds}/${address}`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(9000),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`DexScreener ${res.status} (${chainId})`);
  const pairs = ((await res.json()) ?? []) as DsPair[];
  const want = address.toLowerCase();
  let best: { liq: number; usd: number } | null = null;
  for (const p of Array.isArray(pairs) ? pairs : []) {
    const liq = num(p.liquidity?.usd) ?? 0;
    if (liq < DS_QUOTE_MIN_LIQ_USD) continue;
    const baseUsd = num(p.priceUsd);
    if (baseUsd == null || baseUsd <= 0) continue;
    let usd: number | null = null;
    if (p.baseToken?.address?.toLowerCase() === want) usd = baseUsd;
    else if (p.quoteToken?.address?.toLowerCase() === want) {
      const native = num(p.priceNative);
      if (native != null && native > 0) usd = baseUsd / native;
    }
    if (usd == null || !Number.isFinite(usd) || usd <= 0) continue;
    if (!best || liq > best.liq) best = { liq, usd };
  }
  return best ? best.usd : null;
}
