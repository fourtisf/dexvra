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
      // Health signals — the auto-lister needs them to tell a real $1M project
      // from a $1M "market cap" printed on $300 of liquidity.
      liq: Number(p.liquidity && p.liquidity.usd) || 0,
      vol24: Number(p.volume && p.volume.h24) || 0,
      change24h: Number(p.priceChange && p.priceChange.h24) || 0,
      pairCreatedAt: Number(p.pairCreatedAt) || 0,
      pairCount: pairs.length,
    };
  } catch (e) {
    log.debug(`[dexscreener] ${chain}/${address}: ${e.message}`);
    return null;
  }
}

// ── Discovery feeds ─────────────────────────────────────────────────────────
// DexScreener has no "every token above $X market cap" endpoint, so discovery
// rides its public feeds — the same streams the site's own "new pairs" pages
// are built from. Each returns tokens across EVERY chain; we keep the ones on
// chains Dexvra supports and let the caller price them.
//
//   token-profiles/latest  — projects that just published a profile (icon,
//                            socials): the closest thing to "a real project
//                            just showed up"
//   token-boosts/top       — currently boosted, i.e. actively promoted
//   token-boosts/latest    — newly boosted
//
// Best-effort by design: a feed that is down or reshaped yields nothing and the
// scan simply finds fewer candidates. It must never throw into the service loop.
const DISCOVERY_FEEDS = [
  "https://api.dexscreener.com/token-profiles/latest/v1",
  "https://api.dexscreener.com/token-boosts/top/v1",
  "https://api.dexscreener.com/token-boosts/latest/v1",
];

// DexScreener chainId → our chain id (the inverse of DS_CHAIN).
const OUR_CHAIN = Object.fromEntries(Object.entries(DS_CHAIN).map(([ours, ds]) => [ds, ours]));

async function fetchFeed(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) {
      log.debug(`[dexscreener] feed ${url}: HTTP ${res.status}`);
      return [];
    }
    const j = await res.json();
    return Array.isArray(j) ? j : [];
  } catch (e) {
    log.debug(`[dexscreener] feed ${url}: ${e.message}`);
    return [];
  }
}

/**
 * Candidate tokens from every discovery feed, de-duplicated, on supported
 * chains only. Order is preserved (profiles first, then boosts) because the
 * caller prices only the first N per scan.
 * @returns {Promise<Array<{chain: string, address: string}>>}
 */
async function fetchDiscovery(feeds = DISCOVERY_FEEDS) {
  const seen = new Set();
  const out = [];
  for (const items of await Promise.all(feeds.map(fetchFeed))) {
    for (const it of items) {
      const chain = OUR_CHAIN[String(it && it.chainId)];
      const address = String((it && it.tokenAddress) || "").trim();
      if (!chain || !address) continue;
      const key = `${chain}:${address.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ chain, address });
    }
  }
  return out;
}

module.exports = { fetchTokenInfo, fetchDiscovery, DISCOVERY_FEEDS };
