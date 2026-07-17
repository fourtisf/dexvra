import { CHAINS } from "@/config/chains";
import type { BoardToken, PeriodKey } from "@/lib/types";
import { syntheticTrend, visualFor } from "@/lib/visual";

// GeckoTerminal free API (no key). Rate limit ~30 req/min — callers must go
// through the cache layer, never hit this directly per request.
const BASE = "https://api.geckoterminal.com/api/v2";
const HEADERS = { accept: "application/json;version=20230302" };

interface GtPool {
  id: string;
  attributes: {
    name: string;
    base_token_price_usd: string | null;
    market_cap_usd: string | null;
    fdv_usd: string | null;
    reserve_in_usd: string | null;
    pool_created_at: string | null;
    price_change_percentage: Partial<Record<"m5" | "h1" | "h6" | "h24", string>>;
    volume_usd: Partial<Record<"m5" | "h1" | "h6" | "h24", string>>;
    transactions: Partial<
      Record<"m5" | "h1" | "h24", { buys: number; sells: number }>
    >;
  };
  relationships: {
    base_token: { data: { id: string } };
  };
}

interface GtToken {
  id: string;
  attributes: {
    address: string;
    name: string;
    symbol: string;
    image_url: string | null;
  };
}

interface GtResponse {
  data: GtPool[];
  included?: GtToken[];
}

const num = (s: string | null | undefined): number | null => {
  if (s == null) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

function poolToToken(chainId: string, pool: GtPool, tokensById: Map<string, GtToken>): BoardToken | null {
  const a = pool.attributes;
  const base = tokensById.get(pool.relationships.base_token.data.id);
  if (!base) return null;
  const address = base.attributes.address;
  const price = num(a.base_token_price_usd);
  if (price == null || price <= 0) return null;

  const symbolRaw = base.attributes.symbol || a.name.split("/")[0].trim();
  const symbol = symbolRaw.startsWith("$") ? symbolRaw : "$" + symbolRaw.toUpperCase();

  const chg = {
    "5m": num(a.price_change_percentage.m5) ?? 0,
    "1h": num(a.price_change_percentage.h1) ?? 0,
    "6h": num(a.price_change_percentage.h6) ?? 0,
    "24h": num(a.price_change_percentage.h24) ?? 0,
  } as Record<PeriodKey, number>;

  const vol = {
    "5m": num(a.volume_usd.m5) ?? 0,
    "1h": num(a.volume_usd.h1) ?? 0,
    "6h": num(a.volume_usd.h6) ?? 0,
    "24h": num(a.volume_usd.h24) ?? 0,
  } as Record<PeriodKey, number>;

  const tx = (p?: { buys: number; sells: number }) => ({
    buys: p?.buys ?? 0,
    sells: p?.sells ?? 0,
  });
  const t5 = tx(a.transactions.m5);
  const t1 = tx(a.transactions.h1);
  const t24 = tx(a.transactions.h24);
  // GeckoTerminal has no 6h txn bucket; estimate it from the 24h split
  // scaled by the 6h/24h volume ratio.
  const ratio = vol["24h"] > 0 ? Math.min(vol["6h"] / vol["24h"], 1) : 0.25;
  const t6 = {
    buys: Math.round(t24.buys * ratio),
    sells: Math.round(t24.sells * ratio),
  };

  const ageMinutes = a.pool_created_at
    ? Math.max(0, Math.round((Date.now() - Date.parse(a.pool_created_at)) / 60000))
    : null;

  const fallback = visualFor(symbol);
  return {
    key: `${chainId}:${address}`,
    chain: chainId,
    address,
    symbol,
    name: base.attributes.name || symbol.slice(1),
    logoUrl: base.attributes.image_url && base.attributes.image_url !== "missing.png" ? base.attributes.image_url : null,
    emoji: fallback.emoji,
    gradient: fallback.gradient,
    priceUsd: price,
    mcap: num(a.market_cap_usd) ?? num(a.fdv_usd),
    liq: num(a.reserve_in_usd),
    chg,
    vol,
    txns: { "5m": t5, "1h": t1, "6h": t6, "24h": t24 },
    holders: null,
    taxPct: null,
    ageMinutes,
    trend: syntheticTrend(symbol, chg["24h"]),
    verified: false,
    source: "live",
  };
}

async function fetchPools(path: string, chainId: string): Promise<BoardToken[]> {
  const res = await fetch(`${BASE}${path}`, {
    headers: HEADERS,
    signal: AbortSignal.timeout(8000),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`GeckoTerminal ${res.status} for ${path}`);
  const json = (await res.json()) as GtResponse;
  const tokensById = new Map((json.included ?? []).map((t) => [t.id, t]));
  return json.data
    .map((p) => poolToToken(chainId, p, tokensById))
    .filter((t): t is BoardToken => t !== null);
}

export async function fetchTrendingPools(chainId: string): Promise<BoardToken[]> {
  const network = CHAINS[chainId]?.geckoNetwork;
  if (!network) return [];
  return fetchPools(`/networks/${network}/trending_pools?include=base_token&page=1`, chainId);
}

export async function fetchNewPools(chainId: string): Promise<BoardToken[]> {
  const network = CHAINS[chainId]?.geckoNetwork;
  if (!network) return [];
  return fetchPools(`/networks/${network}/new_pools?include=base_token&page=1`, chainId);
}
