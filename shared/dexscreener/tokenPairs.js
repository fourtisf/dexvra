'use strict';
/*
 * "Which of these DexScreener pairs is ABOUT this token?" One owner, for every
 * package that asks `latest/dex/tokens/{address}`.
 *
 * Reported 2026-11-05 with C5xph2yL6gMdxmuLGxJBkGpmuDFfyi5fqkBNhvL6pump
 * (Big Titty Coin, $BTC, Solana): the bot LISTED it as "Little Titty Coin
 * ($LTC)" — LTC's name, LTC's ticker, LTC's logo on the banner and LTC's
 * price, cap and liquidity in the post, to 12,338 subscribers.
 *
 * ⚠️ `latest/dex/tokens/{address}` RETURNS EVERY PAIR THE TOKEN IS IN — ON
 * EITHER SIDE. Somebody had opened an LTC/BTC pool, i.e. a pool where OUR
 * token is the QUOTE, and it was deeper ($1.1M) than BTC's own BTC/WBTC pool
 * ($486K). Every reader took "the deepest pair on the chain" and then read
 * `baseToken`, `priceUsd`, `marketCap` and `info` off it — and every one of
 * those fields describes a pair's BASE token. So the deepest pool decided whose
 * token we were describing, and the answer was a stranger's.
 *
 * The site has carried the right rule since its DexScreener fallback was
 * written ("counts base-side pairs only: a token seen as the quote of
 * someone else's pair must not take that pair's price"). The bot and the trade
 * bot each had their own reader — ten of them — and none had it.
 *
 * Rules, each a way this could mislead:
 *
 *  • ONLY A PAIR WHOSE BASE IS THIS TOKEN DESCRIBES IT. `priceUsd`,
 *    `priceNative`, `marketCap`, `fdv`, `priceChange`, `baseToken` and `info`
 *    (logo, socials, websites) are all the base's. `ownPairs` keeps exactly
 *    those pairs, deepest first.
 *
 *  • A QUOTE-SIDE PAIR STILL KNOWS TWO THINGS ABOUT US, and nothing else:
 *    our identity (`quoteToken.name/symbol`) and our USD price, which is the
 *    base's USD price divided by the base's price IN us (`priceUsd /
 *    priceNative`). Its cap, logo, socials, 24h change and liquidity belong to
 *    the other token — `quoteView` returns null for every one of them rather
 *    than a number about somebody else. It is a FALLBACK, used only when the
 *    token has no pair of its own.
 *
 *  • THE MATCH IS EXACT. EVM hex compares case-insensitively; base58 and every
 *    other spelling is case-SENSITIVE (a lowercased Solana mint is a different
 *    account) — the rule pair.js states.
 */

const sameAddr = (a, b) => {
  const x = String(a || '').trim();
  const y = String(b || '').trim();
  if (!x || !y) return false;
  return /^0x/i.test(x) ? x.toLowerCase() === y.toLowerCase() : x === y;
};

/** 'base' | 'quote' | null — which side of `pair` this token is. */
function sideOf(pair, address) {
  if (!pair) return null;
  if (pair.baseToken && sameAddr(pair.baseToken.address, address)) return 'base';
  if (pair.quoteToken && sameAddr(pair.quoteToken.address, address)) return 'quote';
  return null;
}

const depth = (p) => Number((p && p.liquidity && p.liquidity.usd) || 0) || 0;
const onChain = (p, chainId) => !chainId || (p && p.chainId === chainId);

/**
 * The pairs that describe `address` — its BASE-side pairs — on `chainId` (any
 * chain when omitted), deepest first. `priced` drops a pair with no USD price.
 */
function ownPairs(pairs, address, { chainId = null, priced = false } = {}) {
  return (Array.isArray(pairs) ? pairs : [])
    .filter((p) => p && onChain(p, chainId) && sideOf(p, address) === 'base' && (!priced || Number(p.priceUsd) > 0))
    .sort((a, b) => depth(b) - depth(a));
}

/** The deepest pair that describes `address`, or null. */
function bestOwnPair(pairs, address, opts = {}) {
  return ownPairs(pairs, address, opts)[0] || null;
}

const finite = (v) => {
  if (v == null || String(v).trim() === '') return null; // Number(null) is 0 — not a reading
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * What a QUOTE-side pair can honestly say about `address`, from the deepest
 * one on `chainId`: `{ name, symbol, priceUsd, pairAddress, pair }`, or null.
 * `priceUsd` is null when the pair publishes no `priceNative` to divide by.
 * Everything else the pair carries is about the OTHER token and is left out.
 */
function quoteView(pairs, address, { chainId = null } = {}) {
  const q = (Array.isArray(pairs) ? pairs : [])
    .filter((p) => p && onChain(p, chainId) && sideOf(p, address) === 'quote')
    .sort((a, b) => depth(b) - depth(a))[0];
  if (!q) return null;
  const usd = finite(q.priceUsd), native = finite(q.priceNative);
  const t = q.quoteToken || {};
  return {
    name: t.name || null,
    symbol: t.symbol || null,
    priceUsd: usd > 0 && native > 0 ? usd / native : null,
    pairAddress: q.pairAddress || null,
    pair: q,
  };
}

module.exports = { sameAddr, sideOf, ownPairs, bestOwnPair, quoteView, depth };
