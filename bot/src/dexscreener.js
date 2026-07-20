// DexScreener token info — richer than GeckoTerminal for LISTING AUTOFILL: it
// returns the project's socials (X / Telegram) + website + logo, which GT does
// not. Always filtered by chain (never match a same-address token on another
// chain). Used to prefill the listing form when a CA is dropped.
const log = require("./helpers/logger");

const BASE = "https://api.dexscreener.com/latest/dex/tokens/";

// our chain id -> DexScreener chainId. DexScreener now indexes Robinhood chain
// (dexscreener.com/robinhood/…) and Plasma, so their socials/website autofill
// works too. A wrong slug just yields no chain-matching pair → null (safe).
const DS_CHAIN = {
  solana: "solana",
  bsc: "bsc",
  ethereum: "ethereum",
  base: "base",
  tron: "tron",
  ton: "ton",
  sui: "sui",
  robinhood: "robinhood",
  plasma: "plasma",
};

const first = (arr) => (Array.isArray(arr) && arr.length ? arr[0] : null);

/** @returns {Promise<{name,symbol,priceUsd,mcap,logoUrl,website,twitter,telegram}|null>} */
async function fetchTokenInfo(chain, address) {
  const dsChain = DS_CHAIN[chain];
  if (!dsChain) return null;
  try {
    const res = await fetch(BASE + encodeURIComponent(address), { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const j = await res.json();
    const pairs = (j.pairs || []).filter((p) => p.chainId === dsChain);
    if (!pairs.length) return null;
    // highest-liquidity pair wins
    pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
    const p = pairs[0];
    const base = p.baseToken || {};
    const info = p.info || {};
    const socials = info.socials || [];
    const tw = socials.find((s) => /twitter|^x$/i.test(s.type || ""));
    const tg = socials.find((s) => /telegram/i.test(s.type || ""));
    const web = first(info.websites);
    return {
      name: base.name || null,
      symbol: base.symbol || null,
      priceUsd: Number(p.priceUsd) || null,
      mcap: Number(p.marketCap) || Number(p.fdv) || null,
      logoUrl: info.imageUrl || null,
      website: (web && web.url) || null,
      twitter: (tw && tw.url) || null,
      telegram: (tg && tg.url) || null,
    };
  } catch (e) {
    log.debug(`[dexscreener] ${chain}/${address}: ${e.message}`);
    return null;
  }
}

module.exports = { fetchTokenInfo };
