// Live market data for a listed token (GeckoTerminal free API, DexScreener
// fallback), used to enrich channel/X posts and drive the pump checker. Same
// sources the website uses; we only ever query specific listed addresses
// (never crawl a chain). Robinhood has no GT coverage (geckoNetwork:null) →
// DexScreener only; chains neither indexes → null (posts show TBA).
const { chainOf } = require("./config/chains");
const log = require("./helpers/logger");

const GT = "https://api.geckoterminal.com/api/v2";
const HEADERS = { accept: "application/json;version=20230302" };

// num(null) must be null, NOT 0 — Number(null) === 0, which silently defeated
// the `market_cap_usd ?? fdv_usd` fallback (GT returns market_cap_usd:null for
// most unverified/new tokens → mcap became 0 → posts showed "TBA" forever).
const num = (x) => {
  if (x === null || x === undefined || x === "") return null;
  const n = Number(x);
  return Number.isFinite(n) && n > 0 ? n : null;
};
// Signed finite number — for values that can legitimately be ≤ 0 (24h change).
const snum = (x) => {
  if (x === null || x === undefined || x === "") return null;
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
};

// DexScreener chainId per dexvra chain — used ONLY to filter candidate pairs.
// NEVER match a DexScreener pair by address alone: the token endpoint returns
// same-address deploys on every chain, and a wrong-chain pair means a wrong
// price. No chain-matching pair → null, never a wrong-chain fallback.
const DS_CHAIN = {
  solana: "solana",
  bsc: "bsc",
  ethereum: "ethereum",
  base: "base",
  tron: "tron",
  ton: "ton",
  sui: "sui",
  // DexScreener now indexes these — used to FILL liquidity/mcap that GT leaves
  // blank for GT-primary chains. Chain-filtered, so price stays correct-chain.
  robinhood: "robinhood",
  plasma: "plasma",
};

async function fetchGT(chain, address) {
  const net = chainOf(chain) && chainOf(chain).geckoNetwork;
  if (!net) return null;
  try {
    const res = await fetch(`${GT}/networks/${net}/tokens/${address}?include=top_pools`, {
      headers: HEADERS,
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const j = await res.json();
    const attr = j.data && j.data.attributes;
    if (!attr) return null;
    const price = num(attr.price_usd);
    const mcap = num(attr.market_cap_usd) ?? num(attr.fdv_usd);
    const poolId = j.data.relationships?.top_pools?.data?.[0]?.id;
    const pool = (j.included || []).find((p) => p.id === poolId);
    const poolAddress =
      (pool && pool.attributes && pool.attributes.address) ||
      (poolId ? poolId.split("_").slice(1).join("_") || null : null);
    const change24h =
      pool && pool.attributes && pool.attributes.price_change_percentage
        ? snum(pool.attributes.price_change_percentage.h24)
        : null;
    const img = attr.image_url;
    const liq = pool && pool.attributes ? num(pool.attributes.reserve_in_usd) : null;
    return {
      priceUsd: price,
      mcap,
      liq,
      poolAddress,
      change24h,
      name: attr.name || null,
      symbol: attr.symbol || null,
      logoUrl: img && img !== "missing.png" ? img : null,
    };
  } catch (e) {
    log.debug(`[market] GT ${chain}/${address}: ${e.message}`);
    return null;
  }
}

/** DexScreener fallback — fills price/mcap when GT hasn't indexed the token
 *  yet (fresh pump.fun launches etc.). Pairs are filtered by chain, then the
 *  deepest-liquidity pair wins. */
async function fetchDS(chain, address) {
  const dsChain = DS_CHAIN[chain];
  if (!dsChain) return null;
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${address}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const j = await res.json();
    const pairs = (j.pairs || []).filter((p) => p && p.chainId === dsChain);
    if (!pairs.length) return null;
    pairs.sort((a, b) => (num(b.liquidity?.usd) || 0) - (num(a.liquidity?.usd) || 0));
    const p = pairs[0];
    const base = p.baseToken || {};
    return {
      priceUsd: num(p.priceUsd),
      mcap: num(p.marketCap) ?? num(p.fdv),
      liq: num(p.liquidity?.usd),
      poolAddress: p.pairAddress || null,
      change24h: p.priceChange ? snum(p.priceChange.h24) : null,
      name: base.name || null,
      symbol: base.symbol || null,
      logoUrl: (p.info && p.info.imageUrl) || null,
    };
  } catch (e) {
    log.debug(`[market] DS ${chain}/${address}: ${e.message}`);
    return null;
  }
}

const tidyDesc = (d) => {
  if (!d || typeof d !== "string") return null;
  const clean = d.replace(/\s+/g, " ").trim();
  // code-point slice — never split an emoji's surrogate pair at the cap
  return clean.length >= 20 ? Array.from(clean).slice(0, 500).join("") : null;
};

/** pump.fun carries the project's OWN description (set at mint) for Solana
 *  launches that GeckoTerminal hasn't enriched yet — the text DexScreener shows.
 *  Best-effort: any failure → null, the caller falls back to an auto-intro. */
async function fetchPumpFunDescription(address) {
  try {
    const res = await fetch(`https://frontend-api-v3.pump.fun/coins/${address}`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const j = await res.json();
    return tidyDesc(j && j.description);
  } catch (e) {
    log.debug(`[market] pumpfun ${address}: ${e.message}`);
    return null;
  }
}

/** Project description for the "overview" paragraph — GeckoTerminal's token-info
 *  endpoint first, then pump.fun for Solana (GT often lacks it for fresh pump
 *  launches). One collapsed paragraph, or null. */
async function fetchTokenDescription(chain, address) {
  const net = chainOf(chain) && chainOf(chain).geckoNetwork;
  if (net) {
    try {
      const res = await fetch(`${GT}/networks/${net}/tokens/${address}/info`, {
        headers: HEADERS,
        signal: AbortSignal.timeout(8000),
      });
      if (res.ok) {
        const j = await res.json();
        const gt = tidyDesc(j.data && j.data.attributes && j.data.attributes.description);
        if (gt) return gt;
      }
    } catch (e) {
      log.debug(`[market] GT info ${chain}/${address}: ${e.message}`);
    }
  }
  if (chain === "solana") return fetchPumpFunDescription(address);
  return null;
}

/** @returns {Promise<{priceUsd:number|null,mcap:number|null,poolAddress:string|null}|null>} */
async function fetchMarket(chain, address) {
  const gt = await fetchGT(chain, address);
  // Only skip DexScreener when GT already has EVERYTHING. GT often returns a
  // price+mcap but no liquidity (reserve_in_usd null) for GT-primary chains
  // (Robinhood/Plasma) — without this, "Liquidity: —" stuck forever.
  if (gt && gt.priceUsd && gt.mcap && gt.liq) return gt;
  // GT missing entirely, or missing price/mcap/liq → let DexScreener fill gaps.
  const ds = await fetchDS(chain, address);
  if (!gt) return ds;
  if (!ds) return gt;
  return {
    ...gt,
    priceUsd: gt.priceUsd ?? ds.priceUsd,
    mcap: gt.mcap ?? ds.mcap,
    liq: gt.liq ?? ds.liq,
    poolAddress: gt.poolAddress || ds.poolAddress,
    change24h: gt.change24h ?? ds.change24h,
    name: gt.name || ds.name,
    symbol: gt.symbol || ds.symbol,
    logoUrl: gt.logoUrl || ds.logoUrl,
  };
}

module.exports = { fetchMarket, fetchTokenDescription };
