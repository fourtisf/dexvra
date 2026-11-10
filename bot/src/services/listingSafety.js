'use strict';
/**
 * IS THIS TOKEN SAFE ENOUGH TO LIST FOR FREE?
 *
 * "tambahkan filter scam honeypot dll intinya yang token2 potensi scam
 * honeypot tidak patut di free listing".
 *
 * `listingQuality.js` answers what the MARKET record can show (a copied ticker,
 * no logo, a pool holding the supply, a pinned price). What it cannot see is
 * the CONTRACT: a honeypot trades normally until you try to sell, and a 30%
 * sell tax, a pausable transfer or an owner who can rewrite balances all look
 * like an ordinary healthy pair from DexScreener. The trade bot has asked
 * exactly this question before every buy since it was written — GoPlus on
 * EVM, RugCheck on Solana — so the modules moved to `shared/security/` and this
 * asks the SAME source rather than a second, drifting idea of "is it a scam".
 *
 * ⚠️ THE BAR IS STRICTER THAN THE TRADE BOT'S, AND THAT IS DELIBERATE. The trade
 * card WARNS and lets a user decide with their own money; a free listing is
 * Dexvra vouching for the token to 12,000 subscribers, so a warning the trade
 * bot merely prints is a refusal here. A refused real token is a missed free
 * listing; a listed honeypot is somebody's money and our name on it.
 *
 * ⚠️ "WE COULD NOT ASK" IS NOT "SAFE", AND NOT "A SCAM" EITHER. `{ ok:false }`
 * — the scan counts it with the upstreams it could not reach (no cool-off, so
 * the next scan asks again) instead of listing an unchecked token or benching a
 * good one for twelve hours over somebody else's outage.
 *
 * ⚠️ A CHAIN NO SAFETY API COVERS IS ASKED OF THE CHAIN ITSELF, if it is EVM.
 * This used to read "passes": Robinhood, Polygon, Optimism, Blast… had no
 * contract check at all, and a honeypot ($NASDUCK, Robinhood) was free-listed
 * and pump-announced with GMGN printing "Possible honeypot! Buying is
 * allowed". `sellSim.js` simulates a recent buyer selling back into the pool
 * with `eth_call`; a revert is the refusal, and an inconclusive answer is
 * "could not ask" — never safe. A non-EVM chain no source covers (Tron, TON,
 * Sui…) still passes on the market checks in listingQuality alone, because no
 * check can be run there.
 *
 * `FREE_LISTING_SAFETY=0` turns this off (the test runner does, because every
 * test stubs the network; the tests for this module turn it back on). Blank is
 * ON — the `raid/sourceFlag.js` rule.
 */
const goplus = require('../../../shared/security/goplus');
const rugcheck = require('../../../shared/security/rugcheck');
const sellSim = require('./sellSim');

const enabled = () => {
  const v = String(process.env.FREE_LISTING_SAFETY == null ? '' : process.env.FREE_LISTING_SAFETY).trim().toLowerCase();
  return !(v === '0' || v === 'false' || v === 'off' || v === 'no');
};

// Fewer holders than this on a token past $1M is not a community, it is a
// handful of wallets (the fake $SHIB had 25). A null count makes no claim.
const MIN_HOLDERS = 100;
const MAX_TAX_PCT = 5;
const MAX_TOP10_PCT = 70;

/** Every reason a GoPlus (EVM) record is unfit for a free listing. */
function evmFlags(s) {
  const out = [...goplus.verdict(s).red];
  if (s.mintable) out.push('mintable supply');
  if (s.openSource === false) out.push('contract not verified');
  if (s.proxy) out.push('upgradeable proxy');
  if (s.tradingCooldown) out.push('trading cooldown');
  if ((s.buyTaxPct || 0) > MAX_TAX_PCT || (s.sellTaxPct || 0) > MAX_TAX_PCT) {
    const tax = Math.max(s.buyTaxPct || 0, s.sellTaxPct || 0);
    if (!out.includes('tax over 10%')) out.push(`tax ${Math.round(tax)}%`);
  }
  if (s.holders != null && s.holders < MIN_HOLDERS) out.push(`only ${s.holders} holders`);
  return out;
}

/** …and a RugCheck (Solana) one. */
function solFlags(s) {
  const out = [...rugcheck.verdict(s).red];
  if (s.mintAuthorityEnabled) out.push('mint authority active');
  if (s.top10Pct != null && s.top10Pct >= MAX_TOP10_PCT) out.push(`top 10 hold ${Math.round(s.top10Pct)}%`);
  if (s.totalHolders != null && s.totalHolders < MIN_HOLDERS) out.push(`only ${s.totalHolders} holders`);
  return out;
}

/**
 *   { ok:true,  refusal:null }        — safe enough, or no source covers the chain
 *   { ok:true,  refusal:"potential scam (…)" }
 *   { ok:false, why }                 — the safety source could not be asked
 */
async function checkX(chain, address, { sources = {}, pool = null } = {}) {
  if (!enabled()) return { ok: true, refusal: null, why: 'safety check switched off' };
  const src0 = { goplus, rugcheck, sellSim, ...sources };
  const svm = String(chain) === 'solana';
  const src = svm ? src0.rugcheck : src0.goplus;
  let ans;
  try {
    ans = await src.tokenSecurityX(chain, address);
  } catch (e) {
    ans = { sec: null, ok: false, why: e.message };
  }
  if (ans && ans.unsupported) return askTheChain(chain, address, ans.why, svm, src0.sellSim, pool);
  if (!ans || !ans.ok || !ans.sec) return { ok: false, refusal: null, why: `safety check: ${(ans && ans.why) || 'no answer'}` };
  const flags = svm ? solFlags(ans.sec) : evmFlags(ans.sec);
  if (!flags.length) return { ok: true, refusal: null, why: null };
  // Figures in parentheses: the scan tallies reasons with them stripped, so
  // every refusal here is ONE bucket — "potential scam" — on the scan line.
  // ⚠️ The flags are the providers' own words and some carry parentheses of
  // their own ("honeypot (can’t sell)") — nested inside ours they break the
  // bucket strip and every refusal becomes its own reason. Flattened.
  const shown = [...new Set(flags.map((f) => String(f).replace(/[()]/g, '').replace(/\s+/g, ' ').trim()))];
  return { ok: true, refusal: `potential scam (${shown.slice(0, 3).join(', ')})`, why: null };
}

/**
 * The contract check for a chain no safety API covers: ask the chain whether a
 * holder can sell (sellSim.js). Figures go in parentheses so the scan tallies
 * every refusal as ONE "potential scam" bucket and every inconclusive answer as
 * ONE "could not be safety-checked" bucket.
 */
async function askTheChain(chain, address, apiWhy, svm, sim, pool) {
  if (svm || !sim || !sim.enabled()) return { ok: true, refusal: null, why: apiWhy };
  let r;
  try {
    r = await sim.sellCheckX(chain, address, { pool });
  } catch (e) {
    r = { ok: false, why: e.message };
  }
  if (r && r.unsupported) return { ok: true, refusal: null, why: `${apiWhy}; ${r.why}` };
  if (!r || !r.ok) {
    const why = String((r && r.why) || 'no answer').replace(/[()]/g, '');
    return { ok: false, refusal: null, why: `safety check: on-chain sell check inconclusive (${chain}: ${why})` };
  }
  if (!r.sells) {
    const why = String(r.why || 'the sell reverts').replace(/[()]/g, '');
    return { ok: true, refusal: `potential scam (honeypot — ${why})`, why: null };
  }
  return { ok: true, refusal: null, why: `${apiWhy}; an on-chain sell simulation passed` };
}

module.exports = { checkX, evmFlags, solFlags, enabled, MIN_HOLDERS, MAX_TAX_PCT, MAX_TOP10_PCT };
