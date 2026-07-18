// Live market data for a listed token (GeckoTerminal free API), used to enrich
// channel/X posts and drive the pump checker. Same source the website uses; we
// only ever query specific listed addresses (never crawl a chain). Robinhood has
// no GT coverage (geckoNetwork:null) → null (posts show TBA).
const { chainOf } = require("./config/chains");
const log = require("./helpers/logger");

const GT = "https://api.geckoterminal.com/api/v2";
const HEADERS = { accept: "application/json;version=20230302" };

const num = (x) => {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
};

/** @returns {Promise<{priceUsd:number|null,mcap:number|null,poolAddress:string|null}|null>} */
async function fetchMarket(chain, address) {
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
    const img = attr.image_url;
    return {
      priceUsd: price && price > 0 ? price : null,
      mcap,
      poolAddress,
      name: attr.name || null,
      symbol: attr.symbol || null,
      logoUrl: img && img !== "missing.png" ? img : null,
    };
  } catch (e) {
    log.debug(`[market] ${chain}/${address}: ${e.message}`);
    return null;
  }
}

module.exports = { fetchMarket };
