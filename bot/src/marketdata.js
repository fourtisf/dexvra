// Live market data for a listed token (GeckoTerminal free API, DexScreener
// fallback), used to enrich channel/X posts and drive the pump checker. Same
// sources the website uses; we only ever query specific listed addresses
// (never crawl a chain). Robinhood has no GT coverage (geckoNetwork:null) →
// DexScreener only; chains neither indexes → null (posts show TBA).
const { chainOf } = require("./config/chains");
const launchpads = require("./launchpads");
const log = require("./helpers/logger");

const GT = "https://api.geckoterminal.com/api/v2";
// This module has its own fetch calls against GeckoTerminal, and for a long
// time they went out with no regard for the shared 429 cooldown or for any
// budget — nine background pipelines (pump, rank-up, auto-trend, gainers,
// trending poster, fulfilment, listing) all price tokens through here on
// timers. So the jobs nobody is watching in real time were tripping the rate
// limit, and the buy bot — the one path a group notices going quiet — took the
// two-minute punishment for it.
//
// Same gate as group/gtPairs now, at BACKGROUND priority: these wait, the buy
// bot's trades feed does not.
const gtGate = require("./group/gtPairs");
/** Wait for this process's GeckoTerminal turn. Resolves false when the shared
 *  cooldown is armed or the queue is saturated — the caller must then treat GT
 *  as unavailable and fall through to DexScreener, which is what it already
 *  does for a timeout. */
async function gtTurn() {
  if (gtGate.inCooldown()) return false;
  try {
    await gtGate.gtSlot(gtGate.PRIO_BACKGROUND);
  } catch (_) {
    return false;
  }
  return !gtGate.inCooldown();
}
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

// A 24h change beyond this is broken data, not a market move — a pool created
// hours ago compares against a near-zero opening tick and prints six digits.
// format.js already refuses to publish such a number in pump/rank-up copy; the
// board printed "+521366.00%" for BONK because nothing filtered it upstream.
const SANE_CHANGE_PCT = 5000;
// Two sources disagreeing by more than this on market cap means one of them is
// reading a poisoned pool. BONK showed $258M on one refresh and $1.3T on the
// next — a 5,000× "move" in five minutes.
const MCAP_DISAGREE_FACTOR = 20;

// One complaint per token per hour about a broken pool. Bounded so a long-lived
// process cannot accumulate an entry per token it has ever priced.
const BROKEN_POOL_QUIET_MS = 60 * 60 * 1000;
const _brokenPool = new Map(); // "chain/address" → last complaint (ms)
function noteBrokenPool(chain, address) {
  const key = `${chain}/${address}`;
  const now = Date.now();
  const last = _brokenPool.get(key);
  if (last && now - last < BROKEN_POOL_QUIET_MS) return false;
  if (_brokenPool.size > 1000) _brokenPool.clear();
  _brokenPool.set(key, now);
  return true;
}

/** The pool a token's numbers should come from: the DEEPEST one, not whichever
 *  GeckoTerminal happened to list first. A thin, freshly-created pool is where
 *  the absurd percentages and fake valuations live. */
function deepestPool(j) {
  const ids = new Set((j.data?.relationships?.top_pools?.data || []).map((p) => p.id));
  const pools = (j.included || []).filter((p) => p && ids.has(p.id) && p.attributes);
  if (!pools.length) return null;
  return pools.reduce((best, p) =>
    (num(p.attributes.reserve_in_usd) || 0) > (num(best.attributes.reserve_in_usd) || 0) ? p : best,
  );
}

/** A pool's own 24h reading, or null. GT sends the object with a null h24 for a
 *  pool that has not traded in the window, which is a different thing from the
 *  pool not existing. */
const poolChange = (pool) =>
  pool && pool.attributes && pool.attributes.price_change_percentage
    ? snum(pool.attributes.price_change_percentage.h24)
    : null;

/** How thin a sibling pool may be before its percentage stops being about the
 *  token and starts being about the pool. A tenth of the deepest pool's
 *  liquidity is still a real market; a dust pool is where a 4-figure percentage
 *  comes from, which is the thing `deepestPool` exists to avoid. */
const CHANGE_POOL_MIN_SHARE = 0.1;

/**
 * The 24h change to publish, given the deepest pool.
 *
 * ⚠️ "ADA BEBERAPA TOKEN TIDAK ADA PERSENAN" — rows on the public board with a
 * market cap and no percentage. One cause is here: the change was read from the
 * DEEPEST pool and from nowhere else, so a token whose main pool has not traded
 * in 24h (GT sends h24: null) lost its percentage even when a sibling pool of
 * the same token had a perfectly good reading.
 *
 * Price, cap and liquidity still come from the deepest pool — those are claims
 * about the market, and the deepest pool is the honest one. Only the CHANGE
 * falls back, and only to a pool with real liquidity behind it.
 */
function changeFromPools(j, deepest) {
  const own = poolChange(deepest);
  if (own != null) return own;
  const ids = new Set((j.data?.relationships?.top_pools?.data || []).map((p) => p.id));
  const floor = (num(deepest && deepest.attributes && deepest.attributes.reserve_in_usd) || 0) * CHANGE_POOL_MIN_SHARE;
  const alt = (j.included || [])
    .filter((p) => p && ids.has(p.id) && p.attributes && p !== deepest)
    .filter((p) => poolChange(p) != null && (num(p.attributes.reserve_in_usd) || 0) >= floor)
    .sort((a, b) => (num(b.attributes.reserve_in_usd) || 0) - (num(a.attributes.reserve_in_usd) || 0))[0];
  return alt ? poolChange(alt) : null;
}

async function fetchGT(chain, address) {
  const net = chainOf(chain) && chainOf(chain).geckoNetwork;
  if (!net) return null;
  try {
    if (!(await gtTurn())) return null; // GT is rate limited — DexScreener fills in
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
    const pool = deepestPool(j);
    const poolId = j.data.relationships?.top_pools?.data?.[0]?.id;
    const poolAddress =
      (pool && pool.attributes && pool.attributes.address) ||
      (poolId ? poolId.split("_").slice(1).join("_") || null : null);
    const rawChange = changeFromPools(j, pool);
    // Publish nothing rather than nonsense: the board prints this straight.
    let change24h = rawChange;
    // WHY there is no reading, for the operator — the board renders "no pool
    // traded in 24h" and "the reading was 12,400% and we refused it" the same
    // way, and only one of those is a broken pool. Never rendered publicly;
    // `trending:check --rows` is the only reader.
    let changeWhy = rawChange == null ? (deepestPool(j) ? "pools have no 24h reading (no trades in the window)" : "GT lists no pool for this token") : null;
    if (rawChange != null && Math.abs(rawChange) > SANE_CHANGE_PCT) {
      // Once per token per hour, not once per poll. A pool with a broken
      // opening tick stays broken, and this runs on the board's refresh
      // interval — one BSC token produced a warning every three minutes,
      // indefinitely. The rejection itself is silent and permanent; the
      // operator only needs to be told the token exists.
      if (noteBrokenPool(chain, address)) {
        log.noise(`[market] GT ${chain}/${address}: ignoring absurd 24h change ${rawChange}% (pool data is broken)`);
      }
      change24h = null;
      changeWhy = `the pool reported ${Math.round(rawChange).toLocaleString("en-US")}% — refused as broken (over ${SANE_CHANGE_PCT}%)`;
    }
    const img = attr.image_url;
    const liq = pool && pool.attributes ? num(pool.attributes.reserve_in_usd) : null;
    return {
      priceUsd: price,
      mcap,
      liq,
      poolAddress,
      change24h,
      changeWhy,
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

/** A launchpad carries the project's OWN description (set at mint) for launches
 *  GeckoTerminal hasn't enriched yet — the text DexScreener shows.
 *
 *  THIS USED TO BE A HARDCODED pump.fun URL, and it was wrong twice over. A
 *  token launched on bonk.fun, Believe, Boop or Moonshot got no overview at all
 *  and the listing fell back to the auto-written intro; and it was this repo's
 *  SECOND private answer to "which pump.fun host is current", the other living
 *  in tradebot/solana.js — the two drifted apart once already and Solana snipe
 *  discovery was blind for days behind a green health tick. There is now one
 *  table, in shared/launchpads, and both processes read it.
 *
 *  Best-effort: any failure → null, the caller falls back to an auto-intro. */
async function fetchLaunchpadDescription(chain, address) {
  try {
    return await launchpads.fetchDescription(chain, address);
  } catch (e) {
    log.debug(`[market] launchpad ${chain}/${address}: ${e.message}`);
    return null;
  }
}

/** Project description for the "overview" paragraph — GeckoTerminal's token-info
 *  endpoint first, then the launchpad the token was minted on (GT often lacks
 *  it for a fresh launch, and always lacks it before migration). One collapsed
 *  paragraph, or null. */
async function fetchTokenDescription(chain, address) {
  const net = chainOf(chain) && chainOf(chain).geckoNetwork;
  // `if (net && await gtTurn())`, NOT an early return inside the try: a rate
  // limited GeckoTerminal must fall THROUGH to the launchpad below, which is the
  // better source for a fresh launch anyway. Returning here would have
  // made every description on Solana disappear for the length of a cooldown.
  if (net && (await gtTurn())) {
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
  // Every chain a pad covers, not just Solana — four.meme on BNB Chain and
  // Virtuals on Base have the same gap, and the old `chain === "solana"` guard
  // meant they could never be asked.
  if (launchpads.covers(chain)) return fetchLaunchpadDescription(chain, address);
  return null;
}

/**
 * The launchpad, LAST, and only for what the indexers left blank.
 *
 * Both indexers read pools. A token that has not migrated has no pool, so both
 * come back empty for its entire pre-migration life and every post about it
 * said "TBA" — for a token whose price, market cap and holder count are all
 * public on its launchpad. Filling here rather than replacing keeps the rule
 * the rest of this file is built on: a live pool reading always beats a
 * launchpad's copy of the same number.
 */
async function fillFromLaunchpad(chain, address, out) {
  if (!launchpads.covers(chain)) return out;
  const lp = await launchpads.fetchTokenInfo(chain, address).catch((e) => {
    log.debug(`[market] launchpad ${chain}/${address}: ${e.message}`);
    return null;
  });
  if (!lp) return out;
  const base = out || {};
  return {
    ...base,
    priceUsd: num(base.priceUsd) ?? num(lp.priceUsd),
    mcap: num(base.mcap) ?? num(lp.mcap),
    liq: num(base.liq) ?? num(lp.liq),
    // No pool is the whole point — there is nothing to link to yet, and
    // inventing an address here would send a chart link somewhere that 404s.
    poolAddress: base.poolAddress || null,
    change24h: base.change24h ?? null,
    name: base.name || lp.name || null,
    symbol: base.symbol || lp.symbol || null,
    logoUrl: base.logoUrl || lp.logoUrl || null,
    // Curve state, for the callers that know to look. Ignored by the ones that
    // do not, which is every existing one.
    onCurve: lp.onCurve,
    progressPct: lp.progressPct,
    launchpad: lp.launchpad,
  };
}

/** @returns {Promise<{priceUsd:number|null,mcap:number|null,poolAddress:string|null}|null>} */
async function fetchMarket(chain, address) {
  const gt = await fetchGT(chain, address);
  // Only skip DexScreener when GT already has EVERYTHING. GT often returns a
  // price+mcap but no liquidity (reserve_in_usd null) for GT-primary chains
  // (Robinhood/Plasma) — without this, "Liquidity: —" stuck forever.
  //
  // `change24h` counts as part of EVERYTHING, for the same reason: the trending
  // board prints it, and a row with a cap and no percentage reads as broken to
  // 10,593 subscribers. It costs nothing where it cannot help — DexScreener
  // does not index the GT-primary chains at all, so `fetchDS` returns before
  // any request is made.
  if (gt && gt.priceUsd && gt.mcap && gt.liq && gt.change24h != null) return gt;
  // GT missing entirely, or missing price/mcap/liq → let DexScreener fill gaps.
  const ds = await fetchDS(chain, address);
  let out;
  if (!gt && !ds) out = null;
  else if (!gt) out = ds;
  else if (!ds) out = gt;
  else {
    // Both sources answered. If their market caps disagree wildly, one is reading
    // a poisoned pool — take the numbers backed by the DEEPER liquidity, and say
    // so. Silently averaging or preferring a fixed source is how a $1.3T BONK
    // reaches a pinned public board.
    const trusted = pickTrusted(gt, ds, chain, address);
    out = {
      ...trusted,
      priceUsd: trusted.priceUsd ?? gt.priceUsd ?? ds.priceUsd,
      mcap: trusted.mcap ?? gt.mcap ?? ds.mcap,
      liq: trusted.liq ?? gt.liq ?? ds.liq,
      poolAddress: trusted.poolAddress || gt.poolAddress || ds.poolAddress,
      change24h: trusted.change24h ?? gt.change24h ?? ds.change24h,
      changeWhy: gt.changeWhy || null,
      name: gt.name || ds.name,
      symbol: gt.symbol || ds.symbol,
      logoUrl: gt.logoUrl || ds.logoUrl,
    };
  }
  // Only when something the callers actually render is still missing — an
  // indexed token must not pay a launchpad round trip on every poll, and nine
  // background pipelines call this on timers.
  if (!out || !out.priceUsd || !out.mcap) out = await fillFromLaunchpad(chain, address, out);
  return out;
}

/** Which of two disagreeing sources to believe. Agreement (or a missing value)
 *  keeps the GeckoTerminal reading, which is the normal path. */
function pickTrusted(gt, ds, chain, address) {
  const a = num(gt.mcap);
  const b = num(ds.mcap);
  if (!a || !b) return gt;
  const ratio = a > b ? a / b : b / a;
  if (ratio < MCAP_DISAGREE_FACTOR) return gt;
  const winner = (num(ds.liq) || 0) > (num(gt.liq) || 0) ? ds : gt;
  log.warn(
    `[market] ${chain}/${address}: market cap disagreement ${Math.round(ratio)}× ` +
      `(GT $${Math.round(a).toLocaleString("en-US")} / DS $${Math.round(b).toLocaleString("en-US")}) — ` +
      `using the deeper-liquidity source (${winner === ds ? "DexScreener" : "GeckoTerminal"})`,
  );
  return winner;
}

module.exports = {
  _deepestPool: deepestPool,
  _changeFromPools: changeFromPools,
  CHANGE_POOL_MIN_SHARE,
  _pickTrusted: pickTrusted,
  SANE_CHANGE_PCT,
  MCAP_DISAGREE_FACTOR, fetchMarket, fetchTokenDescription };
