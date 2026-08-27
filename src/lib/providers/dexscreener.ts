import { CHAINS } from "@/config/chains";
import { dexLogoUrl } from "@/lib/dexscreener";
import type { PeriodKey, TxSplit } from "@/lib/types";
import { EMPTY_LINKS, num, type LiveMarket } from "./market";

// DexScreener free API (no key, ~300 req/min on this endpoint). This is the
// PRIMARY market-data source: one call per chain returns price, per-period
// stats, the pair address the chart embed needs, the token logo and the
// project links — everything a listing card and the token page render.
// Dexvra is paid-listing only, so we only ever ask for our own addresses.
const BASE = "https://api.dexscreener.com/latest/dex/tokens";
const HEADERS = { accept: "application/json" };
const TIMEOUT_MS = 9_000;
// Documented cap for the multi-token endpoint.
const MAX_ADDRESSES_PER_CALL = 30;

interface DsPeriods<T> {
  m5?: T;
  h1?: T;
  h6?: T;
  h24?: T;
}
// Only the fields we actually read — the live payload carries more.
interface DsPair {
  chainId?: string;
  pairAddress?: string;
  baseToken?: { address?: string };
  priceUsd?: string | null;
  txns?: DsPeriods<{ buys?: number; sells?: number }>;
  volume?: DsPeriods<number | string>;
  priceChange?: DsPeriods<number | string>;
  liquidity?: { usd?: number | string | null };
  fdv?: number | string | null;
  marketCap?: number | string | null;
  pairCreatedAt?: number | null; // epoch ms
  info?: {
    imageUrl?: string | null;
    websites?: { label?: string; url?: string }[] | null;
    // Current API shape is {type,url}; older payloads used {platform,handle}.
    socials?: { type?: string; platform?: string; url?: string; handle?: string }[] | null;
  } | null;
}

const liqOf = (p: DsPair): number => num(p.liquidity?.usd) ?? 0;
const vol24Of = (p: DsPair): number => num(p.volume?.h24) ?? 0;

/** The pair we quote a token from: deepest liquidity wins, 24h volume breaks
 *  ties. Anything else (first-in-response order) makes the board flicker
 *  between a real pool and a dust pool from one refresh to the next. */
function bestPair(pairs: DsPair[]): DsPair | undefined {
  return pairs.reduce<DsPair | undefined>((best, p) => {
    if (!best) return p;
    const d = liqOf(p) - liqOf(best);
    return (d !== 0 ? d > 0 : vol24Of(p) > vol24Of(best)) ? p : best;
  }, undefined);
}

const socialUrl = (
  socials: NonNullable<NonNullable<DsPair["info"]>["socials"]>,
  kind: string,
): string | null => {
  const hit = socials.find((s) => (s?.type ?? s?.platform ?? "").toLowerCase() === kind);
  if (!hit) return null;
  if (hit.url) return hit.url;
  if (!hit.handle) return null;
  const handle = hit.handle.replace(/^@/, "");
  return kind === "twitter" ? `https://x.com/${handle}` : `https://t.me/${handle}`;
};

function linksOf(info: DsPair["info"]): LiveMarket["links"] {
  if (!info) return EMPTY_LINKS;
  const socials = info.socials ?? [];
  return {
    website: info.websites?.find((w) => w?.url)?.url ?? null,
    twitter: socialUrl(socials, "twitter"),
    telegram: socialUrl(socials, "telegram"),
  };
}

function mapPair(pair: DsPair, chainId: string, address: string): LiveMarket | null {
  const price = num(pair.priceUsd);
  if (price == null || price <= 0) return null;

  const period = <T,>(p: DsPeriods<T> | undefined): Record<PeriodKey, T | undefined> => ({
    "5m": p?.m5,
    "1h": p?.h1,
    "6h": p?.h6,
    "24h": p?.h24,
  });

  const rawChg = period(pair.priceChange);
  const rawVol = period(pair.volume);
  const rawTx = period(pair.txns);

  const chg = {} as Record<PeriodKey, number>;
  const vol = {} as Record<PeriodKey, number>;
  const txns = {} as Record<PeriodKey, TxSplit>;
  for (const k of ["5m", "1h", "6h", "24h"] as PeriodKey[]) {
    chg[k] = num(rawChg[k]) ?? 0;
    vol[k] = num(rawVol[k]) ?? 0;
    txns[k] = { buys: rawTx[k]?.buys ?? 0, sells: rawTx[k]?.sells ?? 0 };
  }

  const createdAt = num(pair.pairCreatedAt);
  return {
    priceUsd: price,
    mcap: num(pair.marketCap) ?? num(pair.fdv),
    liq: num(pair.liquidity?.usd),
    chg,
    vol,
    txns,
    ageMinutes: createdAt ? Math.max(0, Math.round((Date.now() - createdAt) / 60_000)) : null,
    // API logo first, CDN path second — the CDN resolves for indexed tokens
    // whose payload happens to omit `info`, so a listing is never logo-less.
    logoUrl: pair.info?.imageUrl || dexLogoUrl(chainId, address, "lg"),
    poolAddress: pair.pairAddress ?? null,
    links: linksOf(pair.info),
  };
}

const chunk = <T,>(xs: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
};

async function fetchChunk(addresses: string[]): Promise<DsPair[]> {
  const res = await fetch(`${BASE}/${addresses.join(",")}`, {
    headers: HEADERS,
    signal: AbortSignal.timeout(TIMEOUT_MS),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`DexScreener ${res.status}`);
  const json = (await res.json()) as { pairs?: DsPair[] | null };
  return json.pairs ?? [];
}

/** Live market data for specific listed addresses on one chain, keyed by
 *  lowercased address. Throws on network/HTTP failure (caller falls back to
 *  GeckoTerminal, then to the listing's own figures). */
export async function fetchListedMarket(
  chainId: string,
  addresses: string[],
): Promise<Map<string, LiveMarket>> {
  const out = new Map<string, LiveMarket>();
  const dexChain = CHAINS[chainId]?.dexscreenerChain;
  if (!dexChain || addresses.length === 0) return out;

  // The endpoint is token-address keyed and chain-agnostic, so a response can
  // legitimately carry pairs from other chains for the same address — group by
  // token and keep only pairs on the chain we asked about. Addresses are
  // matched case-insensitively (EVM responses echo the checksummed form) but
  // the listing's own casing is what reaches the CDN logo path.
  const wanted = new Map(addresses.map((a) => [a.toLowerCase(), a]));
  const byToken = new Map<string, DsPair[]>();

  const chunks = await Promise.all(
    chunk(addresses, MAX_ADDRESSES_PER_CALL).map((c) => fetchChunk(c)),
  );
  for (const pair of chunks.flat()) {
    if (pair.chainId !== dexChain) continue;
    const base = pair.baseToken?.address?.toLowerCase();
    if (!base || !wanted.has(base)) continue;
    const bucket = byToken.get(base);
    if (bucket) bucket.push(pair);
    else byToken.set(base, [pair]);
  }

  for (const [key, pairs] of byToken) {
    const pair = bestPair(pairs);
    const market = pair && mapPair(pair, chainId, wanted.get(key) ?? key);
    if (market) out.set(key, market);
  }
  return out;
}
