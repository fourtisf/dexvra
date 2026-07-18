import { CHAINS } from "@/config/chains";
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
    reserve_in_usd: string | null;
    pool_created_at: string | null;
    price_change_percentage: Partial<Record<"m5" | "h1" | "h6" | "h24", string>>;
    volume_usd: Partial<Record<"m5" | "h1" | "h6" | "h24", string>>;
    transactions: Partial<Record<"m5" | "h1" | "h24", { buys: number; sells: number }>>;
  };
}

function mapMarket(token: GtToken, pool: GtPool | undefined): LiveMarket | null {
  const price = num(token.attributes.price_usd);
  if (price == null || price <= 0) return null;
  const pa = pool?.attributes;
  const chg = {
    "5m": num(pa?.price_change_percentage?.m5) ?? 0,
    "1h": num(pa?.price_change_percentage?.h1) ?? 0,
    "6h": num(pa?.price_change_percentage?.h6) ?? 0,
    "24h": num(pa?.price_change_percentage?.h24) ?? 0,
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
  };
}

/** Live market data for specific listed addresses on one chain, keyed by
 *  lowercased address. Throws on network/HTTP failure (caller falls back). */
export async function fetchListedMarket(
  chainId: string,
  addresses: string[],
): Promise<Map<string, LiveMarket>> {
  const network = CHAINS[chainId]?.geckoNetwork;
  const out = new Map<string, LiveMarket>();
  if (!network || addresses.length === 0) return out;

  const res = await fetch(
    `${BASE}/networks/${network}/tokens/multi/${addresses.slice(0, 30).join(",")}?include=top_pools`,
    { headers: HEADERS, signal: AbortSignal.timeout(9000), cache: "no-store" },
  );
  if (!res.ok) throw new Error(`GeckoTerminal ${res.status} (${chainId})`);
  const json = (await res.json()) as { data?: GtToken[]; included?: GtPool[] };
  const poolsById = new Map((json.included ?? []).map((p) => [p.id, p]));
  for (const token of json.data ?? []) {
    const topId = token.relationships?.top_pools?.data?.[0]?.id;
    const market = mapMarket(token, topId ? poolsById.get(topId) : undefined);
    if (market) out.set(token.attributes.address.toLowerCase(), market);
  }
  return out;
}
