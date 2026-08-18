'use strict';
/*
 * THE BIGGEST REAL TOKENS ON A CHAIN, by market cap.
 *
 * WHY: the trending board fills each chain from what is LISTED on that chain,
 * and Ethereum and Base had 3 and 2 listings between them — so the board
 * published three Ethereum rows against a per-chain target of five, every
 * cycle, for as long as nobody listed anything there. Auto-trend already knew
 * ("board below target on ethereum, base — list more tokens on those chains")
 * and could do nothing about it: promoting is all it does. This is the source
 * that lets the shortfall be FILLED instead of merely reported.
 *
 * It is deliberately NOT the auto-lister's discovery feed. That one hunts
 * projects crossing ~$1M for the first time — new, small, unknown by design,
 * and it will never surface PEPE or BRETT because `maxMcapHard` exists to keep
 * established tokens out of a "found it early" feed. Filling a board is the
 * opposite question: who is BIG on this chain right now.
 *
 * ONE GeckoTerminal client, the shared one (`group/gtPairs`), at background
 * priority behind the same 429 cooldown as everything else. A second client
 * would have its own idea of the quota, and the buy bot — the one path a group
 * notices going quiet — would pay for it.
 */
const gt = require('../group/gtPairs');
const log = require('../helpers/logger');

const num = (x) => {
  const n = Number(x);
  return Number.isFinite(n) && n > 0 ? n : null;
};
const snum = (x) => {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
};

/*
 * NOT A PROJECT — the pool's other side, wearing a market cap.
 *
 * GT ranks POOLS, and the base token of a deep pool is very often the money
 * rather than the thing being traded: WETH, USDC, cbBTC, a liquid-staking
 * receipt. Every one of them has a huge cap and none of them is a listing
 * anybody wants to see on a trending board — a board whose Ethereum section
 * reads WETH · USDC · USDT is worse than one with three rows.
 *
 * Matched on the SYMBOL, plus a name prefix for the wrapper families that mint
 * a new ticker every quarter (Wrapped/Staked/Bridged/Rebasing…). A miss here
 * costs one wrong listing an operator can delete; a false positive costs a real
 * token, so the list stays specific — no substring matching on "USD", which
 * would eat every stablecoin-themed memecoin there is.
 */
const NOT_A_PROJECT = new Set([
  // stables
  'USDT', 'USDC', 'DAI', 'BUSD', 'TUSD', 'FDUSD', 'USDE', 'SUSDE', 'USDS', 'USDBC', 'USDT0',
  'PYUSD', 'LUSD', 'GUSD', 'USDD', 'FRAX', 'CRVUSD', 'GHO', 'USD1', 'EURC', 'EURS',
  // natives + their wrappers
  'ETH', 'WETH', 'BTC', 'WBTC', 'CBBTC', 'TBTC', 'BNB', 'WBNB', 'SOL', 'WSOL', 'MSOL',
  'MATIC', 'WMATIC', 'POL', 'AVAX', 'WAVAX', 'TRX', 'WTRX', 'TON', 'WTON', 'SUI', 'WSUI', 'XPL', 'WXPL',
  // liquid staking / restaking receipts
  'STETH', 'WSTETH', 'RETH', 'CBETH', 'WEETH', 'EETH', 'EZETH', 'RSETH', 'METH', 'SFRXETH', 'FRXETH',
  'JITOSOL', 'BSOL', 'JUPSOL', 'INF', 'SLISBNB', 'ASBNB', 'BNBX',
]);
const WRAPPER_NAME = /^(wrapped|staked|bridged|rebasing|liquid staked|restaked)\b/i;

/** Is this the money rather than the project? */
const notAProject = (sym, name) =>
  NOT_A_PROJECT.has(String(sym || '').toUpperCase()) || WRAPPER_NAME.test(String(name || ''));

/**
 * The chain's biggest tokens, market cap first.
 *
 * Returns `{ ok, why, items }` and never throws. **`ok:false` and an empty
 * `items` are different facts** — the first says GeckoTerminal did not answer
 * (cooldown, 429, timeout), the second says it answered and nothing on that
 * chain clears the floor. Collapsing them into `[]` is how a rate limit reads
 * as "this chain has no big tokens" and the board stays short with nobody the
 * wiser; the same rule `pumpfunNewX` and `core.dsPairsX` are written under.
 */
async function topByMcap(chain, { limit = 10, minMcap = 5_000_000, minLiq = 100_000, pages = 2 } = {}) {
  const net = gt.networkOf(chain);
  // Robinhood is the live example: GT does index it, but a chain with no
  // network id cannot be asked at all, and saying so is the difference between
  // "nothing qualifies" and "we never looked".
  if (!net) return { ok: false, why: `no GeckoTerminal network id for ${chain}`, items: [] };

  const best = new Map(); // token address (lower) → the deepest pool we saw for it
  let asked = 0;
  let why = null;
  for (let page = 1; page <= pages; page++) {
    // Ranked by 24h VOLUME, then re-sorted by cap here. GT has no
    // sort-by-market-cap, and volume is the right net to cast: a token with a
    // large cap and no trading is not on anybody's trending board either.
    const res = await gt.gtGet(`/networks/${net}/pools`, { include: 'base_token', page, sort: 'h24_volume_usd_desc' });
    if (!res.ok) {
      why = res.reason || `HTTP ${res.status}`;
      break; // partial results are still results — report them with the reason
    }
    asked++;
    const body = res.body || {};
    const tokens = new Map();
    for (const inc of body.included || []) {
      if (inc && inc.type === 'token' && inc.id) tokens.set(inc.id, inc.attributes || {});
    }
    for (const pool of body.data || []) {
      const a = (pool && pool.attributes) || {};
      const baseId =
        pool && pool.relationships && pool.relationships.base_token && pool.relationships.base_token.data
          ? pool.relationships.base_token.data.id
          : null;
      const t = baseId ? tokens.get(baseId) : null;
      if (!t || !t.address) continue;
      const key = String(t.address).toLowerCase();
      const item = {
        chain,
        address: t.address,
        symbol: t.symbol || null,
        name: t.name || t.symbol || null,
        logoUrl: t.image_url && /^https:\/\//.test(t.image_url) ? t.image_url : null,
        // GT leaves market_cap_usd null for most unverified tokens; fdv is the
        // documented stand-in and is what the rest of this repo already falls
        // back to (marketdata.js). num() rejects 0 so the fallback survives.
        mcap: num(a.market_cap_usd) || num(a.fdv_usd),
        liq: num(a.reserve_in_usd) || 0,
        vol24: num(a.volume_usd && a.volume_usd.h24) || 0,
        change24h: snum(a.price_change_percentage && a.price_change_percentage.h24),
        priceUsd: num(a.base_token_price_usd),
      };
      const prev = best.get(key);
      // One token, many pools: keep the deepest. Judging a token by a thin pool
      // it happens to also trade in is how a $2B token reads as illiquid.
      if (!prev || item.liq > prev.liq) best.set(key, item);
    }
  }

  const items = [...best.values()]
    .filter((t) => t.address && t.symbol && t.mcap)
    .filter((t) => !notAProject(t.symbol, t.name))
    .filter((t) => t.mcap >= minMcap && t.liq >= minLiq)
    .sort((a, b) => b.mcap - a.mcap)
    .slice(0, limit);

  if (why) log.debug(`[bigcoins] ${chain}: GT stopped after ${asked} page(s) — ${why}`);
  return { ok: asked > 0, why, items };
}

module.exports = { topByMcap, notAProject, NOT_A_PROJECT, _num: num };
