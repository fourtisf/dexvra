// WHO GAVE A LISTING ITS TIER — the difference between a tidy-up and a
// customer to put right. The auto-lister's package rotation hands out XPRESS
// and DIAMOND/GOLD/SILVER as well as FREE, so "not FREE" does not mean somebody
// paid (the listings:nostables lesson). The tier it gave is READ from its own
// record, never re-derived. One owner, for every script that deletes or
// reports a listing.
const keyOf = (chain, address) => `${chain}:${String(address).toLowerCase()}`;

/** The tier the auto-lister gave each row it made, keyed chain:address. */
function autoTiers() {
  try {
    return require("../services/autoLister").autoListedTiers() || {};
  } catch {
    return {};
  }
}

function provenance(row, granted = {}) {
  const tier = String(row.tier || "").toUpperCase();
  if (!tier || tier === "FREE") return "a free listing";
  if (granted[keyOf(row.chain, row.address)] === tier) return `tier ${tier} given by the auto-lister, not bought`;
  return `tier ${tier}, not given by the auto-lister — if somebody paid for it, list it again on the same package (an admin order costs nothing)`;
}

module.exports = { autoTiers, provenance, keyOf };
