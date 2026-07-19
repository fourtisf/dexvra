// GeckoTerminal pool resolver for the group buy-bot. Resolves a token's top
// pool and returns a normalized snapshot (price, mcap, 24h volume, liquidity,
// buy/sell tx split) used to estimate buys between polls. GT is queried for
// every chain here (it exposes per-pool 24h volume + tx split, which the buy
// estimate needs); DexScreener is the fallback for chains GT hasn't indexed.
//
// NEVER match a pool by address across chains — we always query the token on
// its OWN geckoNetwork, so a same-address deploy elsewhere can't leak in.
const { chainOf } = require("../config/chains");
const log = require("../helpers/logger");

const GT = "https://api.geckoterminal.com/api/v2";
const HEADERS = { accept: "application/json;version=20230302" };

// Chains DexScreener does NOT index — must go through GT (mirror marketdata's
// DS_CHAIN gaps). Kept as a set so the buy-bot never falls back to a source
// that returns nothing for these.
const GT_PRIMARY = new Set(["robinhood", "plasma"]);
const isGtPrimary = (chain) => GT_PRIMARY.has(chain);

const num = (x) => {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
};

/**
 * Resolve the token's deepest pool on its chain into a snapshot:
 *   { poolAddress, priceUsd, mcap, volume24h, liquidity, buys24h, sells24h }
 * Returns null when neither GT nor DexScreener has the token.
 */
async function fetchPool(chain, address) {
  const net = chainOf(chain) && chainOf(chain).geckoNetwork;
  if (net) {
    const gt = await fetchGtPool(net, address).catch(() => null);
    if (gt) return gt;
  }
  if (!isGtPrimary(chain)) {
    const ds = await fetchDsPool(chain, address).catch(() => null);
    if (ds) return ds;
  }
  return null;
}

async function fetchGtPool(net, address) {
  const res = await fetch(`${GT}/networks/${net}/tokens/${address}/pools?page=1`, {
    headers: HEADERS,
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) return null;
  const j = await res.json();
  const pools = j.data || [];
  if (!pools.length) return null;
  // deepest-liquidity pool wins
  pools.sort((a, b) => (num(b.attributes?.reserve_in_usd) || 0) - (num(a.attributes?.reserve_in_usd) || 0));
  const a = pools[0].attributes || {};
  const tx = (a.transactions && a.transactions.h24) || {};
  return {
    poolAddress: a.address || null,
    priceUsd: num(a.base_token_price_usd) ?? num(a.token_price_usd),
    mcap: num(a.market_cap_usd) ?? num(a.fdv_usd),
    volume24h: (a.volume_usd && num(a.volume_usd.h24)) || 0,
    liquidity: num(a.reserve_in_usd) || 0,
    buys24h: num(tx.buys) || 0,
    sells24h: num(tx.sells) || 0,
    source: "gt",
  };
}

const DS_CHAIN = { solana: "solana", bsc: "bsc", ethereum: "ethereum", base: "base", tron: "tron", ton: "ton", sui: "sui" };

async function fetchDsPool(chain, address) {
  const dsChain = DS_CHAIN[chain];
  if (!dsChain) return null;
  const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${address}`, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) return null;
  const j = await res.json();
  const pairs = (j.pairs || []).filter((p) => p && p.chainId === dsChain);
  if (!pairs.length) return null;
  pairs.sort((a, b) => (num(b.liquidity?.usd) || 0) - (num(a.liquidity?.usd) || 0));
  const p = pairs[0];
  const tx = (p.txns && p.txns.h24) || {};
  return {
    poolAddress: p.pairAddress || null,
    priceUsd: num(p.priceUsd),
    mcap: num(p.marketCap) ?? num(p.fdv),
    volume24h: (p.volume && num(p.volume.h24)) || 0,
    liquidity: num(p.liquidity?.usd) || 0,
    buys24h: num(tx.buys) || 0,
    sells24h: num(tx.sells) || 0,
    source: "ds",
  };
}

module.exports = { fetchPool, isGtPrimary };
