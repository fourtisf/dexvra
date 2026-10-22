// Launchpad data for a token that has NOT migrated yet.
//
// A thin shim over ../../shared/launchpads. The registry, the hosts, the
// failover and the parsing live there because the trade bot needs exactly the
// same answers, and this repo has already paid once for two processes carrying
// separate ideas of which pump.fun host was current — marketdata.js was on v3
// while tradebot/solana.js was still on the retired host, and Solana snipe
// discovery was blind for days while /health printed green.
//
// What lives HERE is only the reshaping into what this bot's callers already
// read: `fetchTokenInfo` returns the exact shape dexscreener.fetchTokenInfo
// does, so listing autofill and the auto-lister work on a bonding-curve token
// without knowing where the data came from.
const lp = require("../../shared/launchpads");
const log = require("./helpers/logger");
const { httpsLogo } = require("./helpers/httpsLogo");

/**
 * Which pads did NOT know a token, and why — remembered per address for the
 * listing form's "no website, X or Telegram" line, the same way
 * `solanaMeta.lastWhy` serves its own half of that line. Read at the moment of
 * the paste, because `launchpads:check` minutes later answers a different
 * minute: $KVR's pump.fun lookup was a fact at 09:49 and gone by the time
 * anybody looked. Bounded; a miss we never recorded is simply absent.
 */
const _why = new Map();
const WHY_MAX = 200;
function noteWhy(chain, address, tried) {
  const k = `${chain}:${address}`;
  const line = lp.whyNot(tried);
  _why.delete(k);
  if (!line) return;
  if (_why.size >= WHY_MAX) _why.delete(_why.keys().next().value);
  _why.set(k, line);
}
const lastWhy = (chain, address) => _why.get(`${chain}:${address}`) || null;

/** Does any enabled pad cover this chain? Callers skip the leg otherwise. */
const covers = (chain) => lp.padsFor(chain).length > 0;

/**
 * Token info in the shape dexscreener.fetchTokenInfo returns — AND WHETHER
 * EVERY PAD THAT MATTERS COULD BE ASKED.
 *
 * FIELD NAMES AND THE ZERO-VS-NULL CONVENTION ARE NOT NEGOTIABLE HERE.
 * autoLister.rejectReason reads `liq`, `vol24` and `pairCreatedAt` by those
 * names and treats 0 as "no data" — a null would read as a PASSING score on a
 * gate the operator set, and auto-list a token with no liquidity at all. The
 * same note sits on poolstrade.fetchTokenInfo for the same reason.
 *
 * `info` is null when no pad knows the token, which is the normal outcome for
 * anything that migrated long ago — the caller falls through to DexScreener.
 *
 * ⚠️ `failed` IS WHY THIS HAS AN X FORM. "No pad knows this token" and "the pad
 * that would know it did not answer" both come back as a null `info`, and the
 * paid post's liquidity watch has to tell them apart: the first is the post
 * being honest, the second is a hole we could have filled. Only VERIFIED pads
 * are listed — an unverified pad's request shape is a guess that is expected
 * to fail on some boxes (moonshot's host is retired, four.meme refuses
 * datacenter IPs), and paging on it would make the watch permanently red.
 *
 * @returns {Promise<{info: object|null, ok: boolean, why: string, failed: string[]}>}
 */
async function fetchTokenInfoX(chain, address) {
  if (!covers(chain)) return { info: null, ok: true, why: `no launchpad covers ${chain}`, failed: [] };
  let r;
  try {
    r = await lp.tokenRecord(chain, address);
  } catch (e) {
    log.debug(`[launchpads] ${chain}/${address}: ${e.message}`);
    return { info: null, ok: false, why: e.message, failed: [] };
  }
  // Worth one debug line: "no pad answered" and "no pad knows it" look
  // identical from here and need different answers from an operator.
  if (!r.ok && r.why) log.debug(`[launchpads] ${chain}/${address}: ${r.why}`);
  noteWhy(chain, address, r.tried);
  const verified = new Set(lp.padsFor(chain).filter((p) => p.verified).map((p) => p.key));
  const failed = (r.tried || [])
    .filter((t) => !t.ok && !t.found && verified.has(t.pad))
    // The registry already spells each reason with the pad's label in front.
    .map((t) => String(t.why || `${t.pad}: no answer`));
  const rec = r.record;
  if (!rec) return { info: null, ok: r.ok, why: r.why || "", failed };
  return { info: shape(rec), ok: r.ok, why: r.why || "", failed };
}

/** The same lookup, collapsed to the shape every older caller reads. */
async function fetchTokenInfo(chain, address) {
  return (await fetchTokenInfoX(chain, address)).info;
}

function shape(rec) {
  return {
    name: rec.name,
    symbol: rec.symbol,
    priceUsd: rec.priceUsd,
    mcap: rec.mcapUsd,
    // ⚠️ REWRITTEN HERE, ONCE, FOR EVERY BOT CONSUMER. The registry publishes
    // what a pad actually said, and a launchpad pins its artwork on IPFS — the
    // one scheme `adminValidate`'s LOGO_RE refuses and no `<img>` can load. A
    // caller that got the raw URI would either fail the whole listing over its
    // picture or draw the fallback mark; both have happened, one layer up.
    logoUrl: httpsLogo(rec.logoUrl),
    website: rec.website,
    twitter: rec.twitter,
    telegram: rec.telegram,
    liq: Number(rec.liqUsd) || 0,
    // The SOL a bonding curve holds, in USD — pump.fun's "Total liquidity".
    // Its OWN NAME, beside `liq` rather than in it, and that is the rule this
    // field exists under: `liq` above is what the auto-lister's `minLiq` gate
    // reads, and a curve reserve is not the pool depth that gate was written
    // for. Only `marketdata.mergeCurve` takes it — LAST, filling a hole an
    // indexer left — so it reaches the post's 💧 line and nothing that decides
    // whether a token may be listed. The ponsChain record carries the same
    // field for the same reason. Null, never 0: a 0 there reads as a rug.
    curveLiq: Number(rec.curveLiqUsd) > 0 ? Number(rec.curveLiqUsd) : null,
    // The reserve in its OWN coin. Carried so a reserve we HAVE and could not
    // price ("pump.fun changed its response shape") is distinguishable from a
    // pad that publishes no reserve at all — the first is a fault, the second
    // is the post being honest.
    raised: Number(rec.raisedNative) > 0 ? Number(rec.raisedNative) : null,
    nativeSym: rec.nativeSym || null,
    vol24: Number(rec.vol24Usd) || 0,
    change24h: 0,
    pairCreatedAt: Number(rec.createdAt) || 0,
    pairCount: 1,
    // Launchpad-only extras. Callers that do not know them ignore them; the
    // listing review card uses them to say a token is still bonding, which is
    // the whole reason an operator asked for this.
    description: rec.description,
    graduated: rec.graduated,
    onCurve: rec.onCurve,
    progressPct: rec.progressPct,
    progressSource: rec.progressSource,
    holders: rec.holders,
    launchpad: rec.launchpad,
    launchUrl: rec.launchUrl,
    source: rec.source,
  };
}

/**
 * The project's own description, set at mint.
 *
 * marketdata.fetchTokenDescription used to hardcode a pump.fun URL for Solana,
 * so a token launched on bonk.fun, Believe, Boop or Moonshot got no overview at
 * all and the listing fell back to the auto-written intro. Routed through the
 * registry it works for every pad, and there is one place that knows pump.fun's
 * host instead of two.
 */
async function fetchDescription(chain, address) {
  const info = await fetchTokenInfo(chain, address).catch(() => null);
  return (info && info.description) || null;
}

module.exports = { covers, fetchTokenInfo, fetchTokenInfoX, fetchDescription, lastWhy, chains: lp.chains, padsFor: lp.padsFor, all: lp.all, reload: lp.reload, tokenRecord: lp.tokenRecord };
