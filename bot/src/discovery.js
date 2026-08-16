// Discovery + pricing for the auto-lister, across every source that indexes a
// chain Dexvra supports.
//
// The auto-lister used to call dexscreener.js directly. That was fine while
// DexScreener was the only source, but it does not index Robinhood Chain — so
// pools.trade launches, on a chain this repo otherwise supports end to end,
// were structurally invisible to auto-listing. This module is the seam: it
// merges every source into the two functions the service already calls, so
// adding a third source later touches this file and nothing else.
//
// Both functions preserve the fail-open contract the service depends on: a
// source that is down contributes nothing and the scan carries on with the
// rest. Only a total failure of ALL sources surfaces as an empty list, which
// the auto-lister already reports as a blocker.
const ds = require("./dexscreener");
const poolstrade = require("./poolstrade");
const launchpads = require("./launchpads");
const log = require("./helpers/logger");

/**
 * Candidates from every source, interleaved and de-duplicated.
 *
 * INTERLEAVED for the same reason dexscreener.fetchDiscovery interleaves its
 * own three feeds: the caller prices only the first N candidates per scan
 * (maxLookupsPerRun, 40 by default). Concatenating would put every pools.trade
 * launch behind ~40 DexScreener entries and it would never be priced at all —
 * the exact bug the round-robin in dexscreener.js was written to fix, one level
 * up. Round-robin gives each SOURCE an even share of the budget; order within
 * a source is preserved.
 *
 * THE PRE-MIGRATION LAUNCHPADS ARE DELIBERATELY NOT A SOURCE HERE, even though
 * they are one for fetchTokenInfo below. Auto-listing gates on minimum
 * liquidity, minimum 24h volume and a minimum age (autoLister.rejectReason),
 * and a token on a bonding curve fails all three by definition — it has no
 * pool, so there is no liquidity to measure, and it is minutes old. Adding the
 * feed would hand a third of every scan's lookup budget (round-robin, 40 per
 * run) to candidates that are rejected on arrival, and take that budget away
 * from the boosted feeds where the $1M projects actually are. That is the exact
 * starvation the round-robin was written to fix, re-introduced one level up.
 *
 * Pre-migration data belongs in the MANUAL listing flow, where a project is
 * paying to be listed and the form needs prefilling — which is fetchTokenInfo.
 *
 * @returns {Promise<Array<{chain: string, address: string}>>}
 */
async function fetchDiscovery() {
  const sources = [
    { name: "dexscreener", fn: () => ds.fetchDiscovery() },
    { name: "poolstrade", fn: () => poolstrade.fetchDiscovery() },
  ];
  const lists = await Promise.all(
    sources.map(async (s) => {
      try {
        const rows = await s.fn();
        return Array.isArray(rows) ? rows : [];
      } catch (e) {
        // One source failing must not take the scan down — that is the whole
        // reason this is a Promise.all over guarded thunks and not a bare one.
        log.debug(`[discovery] ${s.name}: ${e.message}`);
        return [];
      }
    }),
  );

  const seen = new Set();
  const out = [];
  const depth = Math.max(0, ...lists.map((l) => l.length));
  for (let i = 0; i < depth; i++) {
    for (const list of lists) {
      const c = list[i];
      if (!c || !c.chain || !c.address) continue;
      const key = `${c.chain}:${String(c.address).toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ chain: c.chain, address: c.address });
    }
  }
  return out;
}

/**
 * Merge a launchpad record UNDER an indexer record.
 *
 * `base` wins on every field it actually has, because a pool-backed indexer
 * reading a live market beats a launchpad's copy of the same numbers. The
 * launchpad fills the holes, and on a pre-migration token the holes are most of
 * the form: DexScreener has no `info` block to hang socials on until a pool
 * exists, so the project's X, Telegram, website, logo and description — set at
 * mint, and the only ones that exist yet — were unreachable.
 *
 * ZERO IS A VALUE HERE, NOT A HOLE. autoLister.rejectReason reads `liq`,
 * `vol24` and `pairCreatedAt` and treats 0 as "no data"; if a launchpad's
 * numbers could overwrite a real 0 from DexScreener the auto-lister would be
 * scoring a gate against a different source than the one it thinks it is
 * reading. Only null/undefined/'' are treated as missing.
 */
function mergeInfo(base, extra) {
  if (!extra) return base;
  if (!base) return extra;
  const out = { ...base };
  for (const [k, v] of Object.entries(extra)) {
    const have = out[k];
    if (have === null || have === undefined || have === "") out[k] = v;
  }
  // Provenance, so a caller (and a log line) can tell a merged record from a
  // plain DexScreener one without guessing from which fields are populated.
  out.source = base.source ? `${base.source}+${extra.source || "launchpad"}` : extra.source;
  return out;
}

/**
 * Market data for one token, from whichever source knows it.
 *
 * pools.trade is asked FIRST for its own chain and only its own chain: it is
 * the launchpad the token was created on, so it holds the socials, the logo and
 * the curve state that no general indexer has. It returns null for every other
 * chain, and null for a Robinhood token that was not launched through it —
 * either way the DexScreener/GeckoTerminal path below still runs.
 *
 * The pre-migration pads run CONCURRENTLY with DexScreener and are merged
 * under it, rather than being a fallback. A fallback would have been wrong in
 * both directions: pump.fun-style launches usually DO have a DexScreener pair
 * (so the pads would never be asked, and the socials stay missing), while the
 * numbers on that pair are the ones worth keeping (so the pads must not
 * overwrite them). Filling holes is the only combination that gets both.
 */
async function fetchTokenInfo(chain, address) {
  if (chain === poolstrade.OUR_CHAIN) {
    const info = await poolstrade.fetchTokenInfo(chain, address).catch(() => null);
    if (info) return info;
  }
  if (!launchpads.covers(chain)) return ds.fetchTokenInfo(chain, address);
  const [dsInfo, lpInfo] = await Promise.all([
    ds.fetchTokenInfo(chain, address).catch(() => null),
    launchpads.fetchTokenInfo(chain, address).catch((e) => {
      log.debug(`[discovery] launchpads ${chain}/${address}: ${e.message}`);
      return null;
    }),
  ]);
  return mergeInfo(dsInfo, lpInfo);
}

module.exports = { fetchDiscovery, fetchTokenInfo, mergeInfo };
