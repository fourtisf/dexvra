'use strict';
/*
 * "Which of these GeckoTerminal pools is ABOUT this token?" — the twin of
 * shared/dexscreener/tokenPairs.js, for the other indexer.
 *
 * The $BTC/$LTC report (2026-11-05) was found on DexScreener: a stranger's
 * LTC/BTC pool — OUR token as its QUOTE — was deeper than BTC's own pool, and
 * every reader took the deepest pool and read the BASE token's fields off it.
 * GeckoTerminal's `tokens/{address}/pools` and `?include=top_pools` return
 * pools on EITHER side too, and five readers here took the deepest one the same
 * way:
 *
 *   • a pool's `base_token_price_usd`, `price_change_percentage`,
 *     `market_cap_usd`/`fdv_usd` and the first half of its `name` ("LTC / BTC")
 *     are the BASE token's;
 *   • on a pool where we are the QUOTE, a "buy" is somebody SELLING us.
 *
 * Rules, each a way this could mislead:
 *
 *  • A POOL POSITIVELY IDENTIFIED AS QUOTE-SIDE NEVER DESCRIBES US. The side is
 *    read from the pool's own `relationships.base_token / quote_token` ids
 *    ("<network>_<address>"). ⚠️ A pool whose relationships are ABSENT keeps its
 *    old treatment (usable) rather than being dropped: this sandbox cannot reach
 *    GeckoTerminal to prove every response shape carries them, and a filter that
 *    dropped every pool on an unexpected shape would blank every board on the
 *    site. Base-side pools rank first, unknown ones after them.
 *
 *  • A QUOTE-SIDE POOL STILL KNOWS OUR USD PRICE — `quote_token_price_usd` —
 *    and nothing else about us. `quoteView` carries that, the swapped buy/sell
 *    counts, and nulls for the base's cap and change.
 *
 *  • THE MATCH IS EXACT. EVM hex compares case-insensitively; base58 is
 *    case-SENSITIVE — `sameAddr` is the DexScreener rule's own.
 */
const { sameAddr } = require('../dexscreener/tokenPairs');

/** The address out of a relationship `{ data: { id: "<net>_<address>" } }`. */
function relAddr(rel) {
  const id = rel && rel.data && rel.data.id;
  if (typeof id !== 'string') return '';
  const i = id.indexOf('_');
  return i >= 0 ? id.slice(i + 1) : '';
}

/** 'base' | 'quote' | null — which side of a GeckoTerminal pool this token is. */
function gtSideOf(pool, address) {
  const rel = pool && pool.relationships;
  if (!rel) return null;
  if (sameAddr(relAddr(rel.base_token), address)) return 'base';
  if (sameAddr(relAddr(rel.quote_token), address)) return 'quote';
  return null;
}

const reserve = (p) => Number((p && p.attributes && p.attributes.reserve_in_usd) || 0) || 0;

/**
 * The pools that may describe `address`: every pool that is NOT positively
 * quote-side, base-side first, then by depth.
 */
function ownGtPools(pools, address) {
  const rank = (p) => (gtSideOf(p, address) === 'base' ? 0 : 1);
  return (Array.isArray(pools) ? pools : [])
    .filter((p) => p && p.attributes && gtSideOf(p, address) !== 'quote')
    .sort((a, b) => rank(a) - rank(b) || reserve(b) - reserve(a));
}

/** The best pool that describes `address`, or null. */
function bestGtPool(pools, address) {
  return ownGtPools(pools, address)[0] || null;
}

const finite = (v) => {
  if (v == null || String(v).trim() === '') return null; // Number(null) is 0 — not a reading
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * What the deepest QUOTE-side pool can honestly say about `address`: our USD
 * price, our symbol (the second half of the pool's name), the counts the right
 * way round. Its cap, change and depth are the base token's and are left out.
 */
function quoteView(pools, address) {
  const q = (Array.isArray(pools) ? pools : [])
    .filter((p) => p && p.attributes && gtSideOf(p, address) === 'quote')
    .sort((a, b) => reserve(b) - reserve(a))[0];
  if (!q) return null;
  const a = q.attributes;
  const parts = String(a.name || '').split('/').map((s) => s.trim());
  const tx = (a.transactions && a.transactions.h24) || {};
  return {
    priceUsd: finite(a.quote_token_price_usd),
    symbol: parts.length >= 2 ? parts[1] || null : null,
    buys24h: finite(tx.sells), // a base buy is a sale of US
    sells24h: finite(tx.buys),
    pool: q,
  };
}

module.exports = { gtSideOf, ownGtPools, bestGtPool, quoteView, relAddr };
