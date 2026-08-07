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
 * Market data for one token, from whichever source knows it.
 *
 * pools.trade is asked FIRST for its own chain and only its own chain: it is
 * the launchpad the token was created on, so it holds the socials, the logo and
 * the curve state that no general indexer has. It returns null for every other
 * chain, and null for a Robinhood token that was not launched through it —
 * either way the DexScreener/GeckoTerminal path below still runs.
 */
async function fetchTokenInfo(chain, address) {
  if (chain === poolstrade.OUR_CHAIN) {
    const info = await poolstrade.fetchTokenInfo(chain, address).catch(() => null);
    if (info) return info;
  }
  return ds.fetchTokenInfo(chain, address);
}

module.exports = { fetchDiscovery, fetchTokenInfo };
