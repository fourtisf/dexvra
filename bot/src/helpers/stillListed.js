// IS THIS TOKEN STILL LISTED — asked FRESH, right before an alert goes out.
//
// "SAYA SUDAH DELETE TOKEN FROM DATABASE TPI PUMP ALERT MASIH SPAMM". The
// alert loops (pump, rank-up) read the site's list once and then walk it for
// minutes; a row an operator deleted in that window was still announced from
// the stale copy. Every alert asks this, with a fresh read, before the tweet
// and the channel post — one owner, so the next alert type cannot forget it.
//
// ⚠️ A READ THAT FAILS IS "NO". We cannot prove the token is still listed, and
// posting about a deleted one is the defect this exists for; the alert is not
// latched, so it goes out on a later sweep once the site answers.
const api = require("../api/dexvra");

const keyOf = (r) => `${r.chain}:${String(r.address).toLowerCase()}`;

/** Approved rows by key — the only rows an alert may be about. */
function liveMap(rows) {
  const out = new Map();
  for (const r of Array.isArray(rows) ? rows : []) {
    if (r && r.chain && r.address && r.status === "approved") out.set(keyOf(r), r);
  }
  return out;
}

/**
 * Is this row STILL on the site, approved, and the same listing the baseline
 * was taken from? Asked with a FRESH read right before an alert goes out.
 *   { ok:true }            — announce it
 *   { ok:false, why }      — do not; `why` names the reason for the log line
 * A read that fails is `ok:false`: we cannot prove the token is still listed,
 * and posting about a deleted one is the defect this exists for.
 */
async function confirmListed(r, base, getListings = () => api.getListings(), checkIdentity = identityOf) {
  let rows;
  try {
    rows = await getListings();
  } catch (e) {
    return { ok: false, why: `could not re-read the site's listings (${e.message}) — not posting blind` };
  }
  const live = liveMap(rows).get(keyOf(r));
  if (!live) return { ok: false, why: "no longer listed on the site (deleted or unlisted)" };
  if (base && base.listedAt && live.listedAt && Number(base.listedAt) !== Number(live.listedAt)) {
    return { ok: false, why: "re-listed since its baseline was taken — a new ladder starts next sweep" };
  }
  const scam = auditScam(keyOf(r));
  if (scam) return { ok: false, why: `flagged by the listing audit (${scam})` };
  // ⚠️ AND THE NAME THE ALERT WOULD PRINT MUST BE THIS TOKEN'S. A row listed
  // from a stranger's pool ($LTC over Big Titty Coin's contract) keeps a
  // baseline taken from the STRANGER's price, while the fixed readers now
  // price the real token — so the ladder can fire "+100% since listing" under
  // a name that is not the token's, about a move that never happened. The
  // token's own contract decides (services/tokenIdentity.js). A contract that
  // could not be read does NOT hold the alert: the door and the readers are the
  // first line, and an RPC outage must not silence every alert on a chain.
  const named = live.sym || live.symbol || r.sym || r.symbol;
  const clash = await checkIdentity(r.chain, r.address, named).catch(() => null);
  if (clash) {
    return {
      ok: false,
      why: `published under another token's name — the listing says $${clash.published}, its own contract says $${clash.contract}; delete it and list it again`,
    };
  }
  return { ok: true, why: null };
}

/**
 * `{ published, contract }` when the token's own contract names a different
 * ticker from the one the listing publishes, else null — including when the
 * contract could not be read, or the check is switched off. Pages ops once
 * (de-duplicated) with the command that finds every such row.
 */
async function identityOf(chain, address, sym) {
  const tokenIdentity = require("../services/tokenIdentity");
  const v = await tokenIdentity.checkX(chain, address, { symbol: sym }, { budgetMs: 5000 });
  if (!v.refusal || !v.contract) return null;
  const c = tokenIdentity.conflict(sym, v.contract.symbol);
  if (c) tokenIdentity.noteMismatch("pump/rank-up alert", chain, address, c);
  return c;
}

/**
 * The listing audit's reason when it has flagged this token as a SCAM, else
 * null. A row the audit flagged only for its artwork is not silenced — a broken
 * logo is not a reason to stop announcing a real token's move.
 */
function auditScam(key) {
  let flags = {};
  try {
    flags = require("../services/listingAudit").flagged() || {};
  } catch {
    return null;
  }
  const f = flags[key];
  if (!f || !f.why) return null;
  return /^no logo/i.test(String(f.why)) ? null : String(f.why);
}

module.exports = { liveMap, confirmListed, auditScam, keyOf, _identityOf: identityOf };
