// relative + extension, not the "@/" alias: the node:test runner resolves
// this file too (geckoterminal.test.ts), and the alias is a Next-only thing —
// the same rule every other node-tested module here already follows.
import { CHAINS } from "../../config/chains.ts";
import type { PeriodKey, TxSplit } from "@/lib/types";

// GeckoTerminal free API (no key). We fetch live market data for a SPECIFIC
// set of listed token addresses — Dexvra is paid-listing only, so we never
// crawl the whole chain. Rate-limited: always go through the cache layer.
const BASE = "https://api.geckoterminal.com/api/v2";
const HEADERS = { accept: "application/json;version=20230302" };

export interface LiveMarket {
  priceUsd: number;
  mcap: number | null;
  liq: number | null;
  chg: Record<PeriodKey, number>;
  vol: Record<PeriodKey, number>;
  txns: Record<PeriodKey, TxSplit>;
  ageMinutes: number | null;
  logoUrl: string | null;
  poolAddress: string | null; // top pool contract — for the chart embed
}

const num = (s: unknown): number | null => {
  if (s == null) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

interface GtToken {
  id: string;
  attributes: {
    address: string;
    name: string;
    symbol: string;
    image_url: string | null;
    price_usd: string | null;
    market_cap_usd: string | null;
    fdv_usd: string | null;
    total_reserve_in_usd: string | null;
  };
  relationships?: { top_pools?: { data?: { id: string }[] } };
}
interface GtPool {
  id: string;
  attributes: {
    address?: string;
    reserve_in_usd: string | null;
    pool_created_at: string | null;
    price_change_percentage: Partial<Record<"m5" | "h1" | "h6" | "h24", string>>;
    volume_usd: Partial<Record<"m5" | "h1" | "h6" | "h24", string>>;
    transactions: Partial<Record<"m5" | "h1" | "h24", { buys: number; sells: number }>>;
  };
}

// pool id looks like "<network>_<poolAddress>"
const poolAddrOf = (pool: GtPool | undefined, id: string | undefined): string | null =>
  pool?.attributes?.address ?? (id ? id.split("_").slice(1).join("_") || null : null);

/** A sibling pool may only supply a CHANGE reading if it holds at least this
 *  share of the top pool's liquidity — a four-figure percentage off a dust
 *  pool is the thing judging by the DEEPEST pool exists to refuse. */
const CHANGE_POOL_MIN_SHARE = 0.1;

/** Borrow one change window from the deepest sibling pool that HAS it.
 *
 *  GT sends `price_change_percentage.h24: null` for a pool that has not traded
 *  in the window — a different fact from the pool not existing — so a token
 *  whose main pool was quiet lost its percentage even when a sibling pool of
 *  the same token had a good one, and the row rendered a fabricated flat. The
 *  bot repo's `changeFromPools()` rule, on the web surface: only the CHANGE
 *  falls back; price, cap and liquidity still come from the top pool alone. */
function borrowChg(top: GtPool | undefined, siblings: GtPool[], k: "m5" | "h1" | "h6" | "h24"): number | null {
  const topLiq = num(top?.attributes?.reserve_in_usd);
  if (topLiq == null || topLiq <= 0) return null; // no depth to measure the floor against
  const deep = [...siblings].sort(
    (a, b) => (num(b.attributes?.reserve_in_usd) ?? 0) - (num(a.attributes?.reserve_in_usd) ?? 0),
  );
  for (const p of deep) {
    if ((num(p.attributes?.reserve_in_usd) ?? 0) < topLiq * CHANGE_POOL_MIN_SHARE) break; // sorted — the rest are thinner
    const v = num(p.attributes?.price_change_percentage?.[k]);
    if (v != null) return v;
  }
  return null;
}

function mapMarket(
  token: GtToken,
  pool: GtPool | undefined,
  poolId: string | undefined,
  siblings: GtPool[] = [],
): LiveMarket | null {
  const price = num(token.attributes.price_usd);
  if (price == null || price <= 0) return null;
  const pa = pool?.attributes;
  const win = (k: "m5" | "h1" | "h6" | "h24") =>
    num(pa?.price_change_percentage?.[k]) ?? borrowChg(pool, siblings, k) ?? 0;
  const chg = {
    "5m": win("m5"),
    "1h": win("h1"),
    "6h": win("h6"),
    "24h": win("h24"),
  } as Record<PeriodKey, number>;
  const vol = {
    "5m": num(pa?.volume_usd?.m5) ?? 0,
    "1h": num(pa?.volume_usd?.h1) ?? 0,
    "6h": num(pa?.volume_usd?.h6) ?? 0,
    "24h": num(pa?.volume_usd?.h24) ?? 0,
  } as Record<PeriodKey, number>;
  const tx = (p?: { buys: number; sells: number }): TxSplit => ({ buys: p?.buys ?? 0, sells: p?.sells ?? 0 });
  const t24 = tx(pa?.transactions?.h24);
  const ratio = vol["24h"] > 0 ? Math.min(vol["6h"] / vol["24h"], 1) : 0.25;
  const t6 = { buys: Math.round(t24.buys * ratio), sells: Math.round(t24.sells * ratio) };
  const ageMinutes = pa?.pool_created_at
    ? Math.max(0, Math.round((Date.now() - Date.parse(pa.pool_created_at)) / 60000))
    : null;
  const img = token.attributes.image_url;
  return {
    priceUsd: price,
    mcap: num(token.attributes.market_cap_usd) ?? num(token.attributes.fdv_usd),
    liq: num(token.attributes.total_reserve_in_usd) ?? num(pa?.reserve_in_usd),
    chg,
    vol,
    txns: { "5m": tx(pa?.transactions?.m5), "1h": tx(pa?.transactions?.h1), "6h": t6, "24h": t24 },
    ageMinutes,
    logoUrl: img && img !== "missing.png" ? img : null,
    poolAddress: poolAddrOf(pool, poolId),
  };
}

/** GT's tokens/multi endpoint answers at most 30 addresses per request. */
export const GT_MULTI_MAX = 30;

/** Politeness gap between chunk requests for one chain. The bot suite on the
 *  SAME server IP is a heavy GT consumer with its own shared 429 cooldown, so
 *  the web app must not burst. */
const CHUNK_GAP_MS = 300;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchChunk(
  chainId: string,
  network: string,
  chunk: string[],
  out: Map<string, LiveMarket>,
): Promise<void> {
  // ⚠️ Addresses go to GT VERBATIM — base58 (Solana) is case-significant, and
  // lowercasing one asks GT about an address that does not exist. Only OUR map
  // keys are lowercased; those are ours and merely have to be consistent.
  const res = await fetch(
    `${BASE}/networks/${network}/tokens/multi/${chunk.join(",")}?include=top_pools`,
    { headers: HEADERS, signal: AbortSignal.timeout(9000), cache: "no-store" },
  );
  if (!res.ok) throw new Error(`GeckoTerminal ${res.status} (${chainId})`);
  const json = (await res.json()) as { data?: GtToken[]; included?: GtPool[] };
  const poolsById = new Map((json.included ?? []).map((p) => [p.id, p]));
  for (const token of json.data ?? []) {
    const ids = (token.relationships?.top_pools?.data ?? []).map((d) => d.id);
    const topId = ids[0];
    const siblings = ids
      .slice(1)
      .map((id) => poolsById.get(id))
      .filter((p): p is GtPool => p != null);
    const market = mapMarket(token, topId ? poolsById.get(topId) : undefined, topId, siblings);
    if (market) out.set(token.attributes.address.toLowerCase(), market);
  }
}

/** Live market data for specific listed addresses on one chain, keyed by
 *  lowercased address.
 *
 *  ⚠️ EVERY address is asked for, in chunks of GT_MULTI_MAX. This used to be
 *  `addresses.slice(0, 30)` — written against a 14-token seed and shipped to a
 *  store of 173 listings, where it silently dropped tokens 31+ on every chain:
 *  83 Solana listings meant 53 of them could never price, rendering +0.0%
 *  forever with nothing anywhere saying why. A cap that is not reported is a
 *  bug that looks like a market.
 *
 *  A chunk that fails is SKIPPED — its tokens keep their fallback figures this
 *  cycle — but if NO chunk answered the whole chain throws, because "GT is
 *  down" and "these tokens have no market" are different facts and the caller
 *  treats them differently. */
export async function fetchListedMarket(
  chainId: string,
  addresses: string[],
): Promise<Map<string, LiveMarket>> {
  const network = CHAINS[chainId]?.geckoNetwork;
  const out = new Map<string, LiveMarket>();
  if (!network || addresses.length === 0) return out;

  const chunks: string[][] = [];
  for (let i = 0; i < addresses.length; i += GT_MULTI_MAX) chunks.push(addresses.slice(i, i + GT_MULTI_MAX));

  let failed = 0;
  let lastErr: unknown;
  for (let i = 0; i < chunks.length; i++) {
    if (i > 0) await sleep(CHUNK_GAP_MS);
    try {
      await fetchChunk(chainId, network, chunks[i], out);
    } catch (err) {
      failed++;
      lastErr = err;
    }
  }
  if (failed === chunks.length) throw lastErr instanceof Error ? lastErr : new Error(`GeckoTerminal failed (${chainId})`);
  return out;
}
