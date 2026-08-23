'use strict';
/*
 * BRING A CHAIN UP TO N LISTINGS, from its own biggest real tokens.
 *
 * "tambahkan token chain bsc base eth 50 token top nya memecoin atau apa bebas
 * tidak perlu di announce cukup tambahkan aja tokennya" — the site's chain
 * chips read Solana 83 · Robinhood 53 · BSC 23 · Base 10 · Ethereum 9, and the
 * three EVM chains needed filling out. Not a market event, not a promotion:
 * inventory.
 *
 * WHAT IT IS NOT, and each of these is a different feature that already exists:
 *
 *   autoLister.runOnce  hunts projects crossing ~$1M for the FIRST time, a few
 *                       per day, on a random cadence, and can announce. This is
 *                       a bulk one-off over tokens that are already big.
 *   trendFill.fillChain fills the trending BOARD when a chain has nothing left
 *                       to promote, and lists with the `trending` package — a
 *                       real tier plus a board slot. Doing that fifty times a
 *                       chain would publish a board nobody sold.
 *
 * So this lists with the `free` package and nothing else: FREE tier, no board
 * slot, no tier that reads as a purchase. The listing itself still goes through
 * `autoLister.createFromInfo`, which stays the one owner of what an auto
 * listing is — and which never announces (only `runOnce` does, and only with a
 * `tg` this path never has).
 *
 * THE TARGET IS "UP TO", NOT "ADD". `target: 50` on a chain already carrying 50
 * lists nothing, so a re-run after a half-finished pass is safe and a second
 * run cannot double the chain. That is also what the operator was looking at:
 * the number on the chip.
 */
const bigCoins = require('./bigCoins');
const autoLister = require('./autoLister');
const discovery = require('../discovery');
const api = require('../api/dexvra');
const { chainOf } = require('../config/chains');
const log = require('../helpers/logger');

const keyOf = (chain, address) => `${chain}:${String(address || '').toLowerCase()}`;

/** GeckoTerminal serves at most 10 pages of pools per network. Asking for more
 *  is not a bigger net, it is a wasted request against a shared quota. */
const GT_MAX_PAGES = 10;

const DEFAULTS = {
  target: 50,
  minMcap: 1_000_000,
  minLiq: 50_000,
  pages: GT_MAX_PAGES,
  gapMs: 400, // between creates — the site is one small server, not a CDN
};

/**
 * WHICH candidates to list, and why the plan is short when it is. PURE — no
 * network, no disk — so the arithmetic that decides how many public listings
 * get created is testable by execution rather than by reading it.
 *
 * `current` is how many listings the chain already carries, so the plan can be
 * expressed in the operator's own unit: the number on the chip.
 */
function plan({ chain, target, current, candidates, known, everListed }) {
  const need = Math.max(0, target - current);
  const out = { chain, target, current, need, take: [], skipped: { listed: 0, everListed: 0 }, why: null };
  if (!need) {
    out.why = `already at ${current}/${target}`;
    return out;
  }
  for (const c of candidates || []) {
    if (out.take.length >= need) break;
    if (!c || !c.address || !c.symbol || !c.name) continue; // a nameless row on a public site
    const k = keyOf(chain, c.address);
    if (known && known.has(k)) {
      out.skipped.listed++;
      continue;
    }
    // Listed once and gone means the operator removed it, or somebody paid for
    // it and it lapsed. Either way it must not come back free — the memo both
    // the scan and the board filler already honour.
    if (everListed && everListed(chain, c.address)) {
      out.skipped.everListed++;
      continue;
    }
    out.take.push(c);
  }
  if (out.take.length < need) {
    // ⚠️ WHICH shortfall it is decides what the operator does next. "everything
    // big here is already listed" is a full chain; "the market only returned
    // four tokens above the floor" is a floor to lower or a thin chain. The
    // first cut printed the dedup counts either way, so an empty candidate list
    // read as a chain we had already filled.
    const skipped = out.skipped.listed + out.skipped.everListed;
    out.why = skipped
      ? `only ${out.take.length} of the ${need} needed are new — ` +
        `${out.skipped.listed} already listed, ${out.skipped.everListed} listed before and removed`
      : `only ${out.take.length} token(s) on ${chain} clear the floor — ${need} needed`;
  }
  return out;
}

/**
 * Bring one chain up to `target` listings. Never throws.
 *
 * `apply: false` (the default) plans and reports without creating anything —
 * this makes fifty public rows on a live site, so the shape of the run is
 * readable before it is irreversible.
 *
 * Returns `{ chain, target, current, need, listed, planned, why, ok }`.
 * ⚠️ `ok:false` and an empty `listed` are different facts: the first says the
 * market or the site could not be READ, the second says there was nothing new
 * to add. Collapsing them is how "GeckoTerminal is rate-limited" reads as
 * "this chain is full" — the rule `bigCoins` and `pumpfunNewX` are written
 * under, one caller down.
 */
async function seedChain(chain, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const deps = o.deps || {};
  const top = deps.topByMcap || bigCoins.topByMcap;
  const info = deps.fetchTokenInfo || discovery.fetchTokenInfo;
  const create = deps.createFromInfo || autoLister.createFromInfo;
  const listings = deps.getListings || api.getListings;
  const everListed = deps.wasEverListed || autoLister.wasEverListed;
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));

  const out = { chain, target: o.target, current: 0, need: 0, planned: 0, listed: [], failed: 0, why: null, ok: false };
  if (!chainOf(chain)) {
    out.why = `unknown chain ${chain}`;
    return out;
  }

  let rows;
  try {
    rows = (await listings()) || [];
  } catch (e) {
    // Without the site's list we cannot tell a new token from one already
    // listed, and a duplicate listing is worse than an unfilled chain.
    out.why = `site API unreachable: ${e.message}`;
    return out;
  }
  const known = new Set(rows.map((r) => keyOf(r.chain, r.address)));
  out.current = rows.filter((r) => r.chain === chain).length;
  out.need = Math.max(0, o.target - out.current);
  if (!out.need) {
    out.ok = true;
    out.why = `already at ${out.current}/${o.target}`;
    return out;
  }

  const res = await top(chain, {
    // Ask for far more than the shortfall: the tokens already listed are the
    // ones most likely to sit at the TOP of a by-cap list, so a limit of
    // exactly `need` comes back mostly consumed by rows we already have.
    limit: Math.max(out.need * 4, 60),
    minMcap: o.minMcap,
    minLiq: o.minLiq,
    pages: Math.min(o.pages, GT_MAX_PAGES),
  }).catch((e) => ({ ok: false, why: e.message, items: [] }));
  if (!res.ok && !res.items.length) {
    out.why = `could not read the market for ${chain}: ${res.why || 'unknown'}`;
    return out;
  }
  out.ok = true;

  const p = plan({ chain, target: o.target, current: out.current, candidates: res.items, known, everListed });
  out.planned = p.take.length;
  out.why = p.why;
  if (!p.take.length) {
    if (!out.why) out.why = `no token on ${chain} clears the floor (mcap ≥ $${o.minMcap.toLocaleString('en-US')})`;
    return out;
  }
  if (!o.apply) return out; // dry run: the plan is the whole answer

  for (const c of p.take) {
    // Enrich from the source every other listing uses, so a seeded row carries
    // the same logo and socials a scanned one does. An UPGRADE only: GT already
    // gave a name, a symbol, a cap and an image, so a failed lookup must not
    // cost the listing.
    let full = null;
    try {
      full = await info(chain, c.address);
    } catch (e) {
      log.debug(`[chainseed] token info ${chain}/${c.address}: ${e.message}`);
    }
    const merged = {
      ...(full || {}),
      name: (full && full.name) || c.name,
      symbol: (full && full.symbol) || c.symbol,
      logoUrl: (full && full.logoUrl) || c.logoUrl,
      mcap: (full && full.mcap) || c.mcap,
      priceUsd: (full && full.priceUsd) || c.priceUsd,
      liq: (full && full.liq) || c.liq,
      vol24: (full && full.vol24) || c.vol24,
    };
    try {
      // `free` and nothing else — see the header. The absence of a `tg` here is
      // not an accident either: announce() is unreachable from this path.
      const made = await create(chain, c.address, merged, { pkgKey: 'free' });
      if (!made) continue;
      out.listed.push({ chain, address: c.address, sym: made.input.sym, mcap: c.mcap });
      log.info(
        `[chainseed] listed ${made.input.sym} on ${chain} at $${Math.round(c.mcap || 0).toLocaleString('en-US')} ` +
          `(${out.current + out.listed.length}/${o.target})`,
      );
    } catch (e) {
      // One refusal must not end the run — the next candidate is a different
      // token and usually fine.
      out.failed++;
      log.warn(`[chainseed] listing refused for ${c.symbol} (${chain}): ${e.message}`);
    }
    if (o.gapMs) await sleep(o.gapMs);
  }
  if (out.listed.length < out.need && !out.why) {
    out.why = `listed ${out.listed.length}/${out.need}${out.failed ? ` — ${out.failed} refused by the site` : ''}`;
  }
  return out;
}

module.exports = { seedChain, plan, DEFAULTS, GT_MAX_PAGES };
