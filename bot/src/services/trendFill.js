'use strict';
/*
 * WHEN A CHAIN HAS NOTHING LEFT TO PROMOTE, LIST THE BIGGEST TOKENS ON IT.
 *
 * Reported from the live board: `ETHEREUM - Trending` with three rows and
 * `BASE - Trending` with two, against a per-chain target of five. Nothing was
 * broken — auto-trend promotes what is LISTED on a chain, and those two chains
 * had three and two listings in total. It already said so every cycle:
 *
 *   [autotrend] board below target on ethereum (needs 2, none eligible), base…
 *               — list more tokens on those chains, or lower the per-chain target
 *
 * …to an operator who cannot list a token from Telegram. A diagnosis with no
 * hands attached is where this feature had been sitting for weeks, which is why
 * the answer was "fixkan, dan jika kurang coin maka listingkan coin2 besar mc
 * gede": fill the gap with the chain's real large caps.
 *
 * WHAT IT IS NOT: a second auto-lister. `autoLister` hunts projects crossing
 * ~$1M for the first time and refuses anything over `maxMcapHard` — by design,
 * it can never produce a PEPE or a BRETT. This asks the opposite question ("who
 * is big on this chain right now"), runs only when a chain is SHORT, and lists
 * exactly the shortfall. The listing itself goes through
 * `autoLister.createFromInfo`, so there is still one owner of what an auto
 * listing is.
 */
const bigCoins = require('./bigCoins');
const autoLister = require('./autoLister');
const discovery = require('../discovery');
const api = require('../api/dexvra');
const { chainOf } = require('../config/chains');
const log = require('../helpers/logger');

const keyOf = (chain, address) => `${chain}:${String(address || '').toLowerCase()}`;

/**
 * Fill up to `need` slots on one chain. Never throws.
 *
 * Returns `{ listed, tried, why }` — `listed` is what reached the site, `why`
 * is why it is short of `need` when it is. A filler that quietly returns fewer
 * than asked is the reported bug one level up: the board stays short and the
 * only trace is a number nobody compares.
 */
async function fillChain(chain, need, { cfg = {}, now = Date.now(), deps = {}, maxDropPct } = {}) {
  const out = { chain, need, listed: [], tried: 0, why: null };
  if (!(need > 0)) return out;
  if (!chainOf(chain)) {
    out.why = `unknown chain ${chain}`;
    return out;
  }
  const top = deps.topByMcap || bigCoins.topByMcap;
  const info = deps.fetchTokenInfo || discovery.fetchTokenInfo;
  const create = deps.createFromInfo || autoLister.createFromInfo;
  const listings = deps.getListings || api.getListings;
  const everListed = deps.wasEverListed || autoLister.wasEverListed;

  // Ask for more than we need: the ones already on the site are the ones most
  // likely to be at the top of a by-cap list, so a limit of exactly `need`
  // would routinely come back fully consumed by tokens we already have.
  const res = await top(chain, {
    limit: Math.max(need * 5, 10),
    minMcap: Number(cfg.fillMinMcap) || 5_000_000,
    minLiq: Number(cfg.fillMinLiq) || 100_000,
  }).catch((e) => ({ ok: false, why: e.message, items: [] }));
  if (!res.ok && !res.items.length) {
    // "GT is rate-limited" and "this chain has no big tokens" need different
    // answers from whoever reads the log, and only one of them is worth
    // re-trying in ten minutes.
    out.why = `could not read the market for ${chain}: ${res.why || 'unknown'}`;
    return out;
  }
  if (!res.items.length) {
    out.why = `no token on ${chain} clears the floor (mcap ≥ $${(Number(cfg.fillMinMcap) || 5_000_000).toLocaleString('en-US')})`;
    return out;
  }

  let known;
  try {
    const rows = (await listings()) || [];
    known = new Set(rows.map((r) => keyOf(r.chain, r.address)));
  } catch (e) {
    // Without the site's list we cannot tell a new token from one already
    // listed, and listing a duplicate is worse than staying short for a cycle.
    out.why = `site API unreachable: ${e.message}`;
    return out;
  }

  // ⚠️ THE FREE-FALL BOUND APPLIES TO THIS DOOR TOO.
  //
  // The promoter refuses to put a listed token below −15% on the board, because
  // a slot filled by something in free-fall is worse than a short board. A
  // filler that then LISTS a big-cap down 40% to fill the same slot makes that
  // rule decorative — and on a red day it would do it on every chain, every
  // cycle. `autoTrend` owns the number and passes it in; the lazy require is
  // only for a direct caller, so there is still exactly one value.
  const maxDrop = Number.isFinite(Number(maxDropPct))
    ? Number(maxDropPct)
    : require('./autoTrend').FLOOR_FILL_MAX_DROP;

  let inFreeFall = 0;
  for (const c of res.items) {
    if (out.listed.length >= need) break;
    // An UNREADABLE change is not a fall — same exemption the promoter makes,
    // and for the same reason: Robinhood has no indexer, so judging by a number
    // nobody can read would mean never filling that chain at all.
    if (Number.isFinite(c.change24h) && c.change24h < -maxDrop) {
      inFreeFall++;
      continue;
    }
    if (known.has(keyOf(c.chain, c.address))) continue;
    // Listed once and gone means the operator removed it, or somebody paid for
    // it and it lapsed. Either way it must not come back free — the rule the
    // scan already follows via the same memo.
    if (everListed(c.chain, c.address)) continue;
    out.tried++;
    // Enrich from the source every other listing uses, so a filled listing
    // carries the same logo and socials a scanned one does. It is an UPGRADE:
    // GT already gave us a name, a symbol, a cap and an image, so a failed
    // lookup must not cost the fill.
    let full = null;
    try {
      full = await info(c.chain, c.address);
    } catch (e) {
      log.debug(`[trendfill] token info ${c.chain}/${c.address}: ${e.message}`);
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
      change24h: full && Number.isFinite(full.change24h) ? full.change24h : c.change24h,
    };
    if (!merged.symbol || !merged.name) continue; // a nameless row on a public board
    try {
      // The "trending" package: it lists AND books a board slot, so the chain
      // that was short is full on this pass rather than the next one. Anything
      // else would leave the board short for another auto-trend cycle — up to
      // two hours — which is the state being fixed.
      const made = await create(c.chain, c.address, merged, { now, pkgKey: 'trending' });
      if (!made) continue;
      out.listed.push({ chain: c.chain, address: c.address, sym: made.input.sym, mcap: c.mcap, tier: made.input.tier });
      log.info(
        `[trendfill] listed ${made.input.sym} on ${c.chain} at $${Math.round(c.mcap).toLocaleString('en-US')} ` +
          `to fill the board (${out.listed.length}/${need})`,
      );
    } catch (e) {
      // One refusal must not end the fill — the next candidate is a different
      // token and usually fine.
      log.warn(`[trendfill] createListing ${c.symbol} (${c.chain}): ${e.message}`);
    }
  }
  if (out.listed.length < need && !out.why) {
    out.why =
      out.tried === 0
        ? inFreeFall
          ? `every big token on ${chain} that is not already listed is down more than ${maxDrop}% — a short board beats one in free-fall`
          : `every big token on ${chain} is already listed`
        : `only ${out.listed.length}/${need} could be listed`;
  }
  return out;
}

module.exports = { fillChain };
