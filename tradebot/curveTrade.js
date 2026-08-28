'use strict';
/*
 * THE ONE OWNER of "can this launchpad curve be traded, and with what call?"
 *
 * `curveIface` reads a curve's call shape off real trades. `curveRoute` turns
 * that into OUR calldata and refuses anything it cannot explain. This ties the
 * two together, holds the cache, and runs the gates — so `core.buy` and
 * `core.sell` ask ONE question and get one answer, rather than growing two
 * private ideas of when a discovered route may be signed. Three callers were
 * about to; `canTradeNow` exists for exactly that reason, one question over.
 *
 * WHERE IT SITS. A token on a bonding curve has no AMM pool, so `bestDexVenue`
 * finds nothing and the buy path ends at:
 *
 *     "this token's liquidity is on <venue>, which Dexvra can't route through
 *      yet — no swap to sign"
 *
 * That sentence is true only while nobody has read the curve's interface. This
 * is what reads it.
 *
 * ⚠️ EVERY REFUSAL HERE IS A REFUSAL TO SIGN, NOT A VERDICT ON THE TOKEN. The
 * caller must be able to tell "we cannot build this safely" from "this token
 * cannot be traded", because the first is ours and the second is not ours to
 * assert. `why` says which, always.
 */
const { decodeCurveIface, describeIface } = require('./curveIface.js');
const { buildCurveCall, simulate, sane } = require('./curveRoute.js');

/** Interfaces are per (chain, token) and change only when a pad redeploys, so
 *  they are worth holding — a rediscovery is a dozen RPC reads. A MISS is held
 *  far more briefly: it usually means "not enough trades yet", which the next
 *  trade fixes, and caching that for an hour would make the pad look dead. */
const OK_TTL_MS = 30 * 60_000;
const MISS_TTL_MS = 90_000;
const _cache = new Map();
const key = (chainKey, ca) => `${chainKey}:${String(ca).toLowerCase()}`;

function _cached(chainKey, ca) {
  const hit = _cache.get(key(chainKey, ca));
  if (!hit) return null;
  const ttl = hit.res && hit.res.ok ? OK_TTL_MS : MISS_TTL_MS;
  if (Date.now() - hit.ts > ttl) { _cache.delete(key(chainKey, ca)); return null; }
  return hit.res;
}

/** Test seam — the cache is process-wide by design. */
function _reset() { _cache.clear(); }

/**
 * The curve interface for a token, discovered once and remembered.
 *
 * `chain` needs `getLogs`, `getTransaction` and `getBlockNumber`. Injected, so
 * this is provable without a node — the only way it CAN be proved from a
 * sandbox with no egress, which is where every line of it was written.
 */
async function ifaceFor(chain, chainKey, ca, opts = {}) {
  const hit = _cached(chainKey, ca);
  if (hit) return hit;
  let head;
  try { head = Number(await chain.getBlockNumber()); }
  catch (e) { return { ok: false, why: `could not read the chain head (${(e && e.message) || e})` }; }   // NOT cached: an outage is not a fact about the token
  const res = await decodeCurveIface(chain, ca, { head, blocks: opts.blocks, maxTx: opts.maxTx });
  // A transport failure is never remembered — the `pumpfunNewX` rule, on the
  // path that spends money.
  if (res.ok || !/could not read/.test(res.why || '')) _cache.set(key(chainKey, ca), { res, ts: Date.now() });
  return res;
}

/**
 * A buy on the curve, ready to sign — or a refusal that says why.
 *
 * `expectedTokens` is what an independent source says `valueWei` should buy.
 * It is REQUIRED: without it `sane()` has nothing to catch a misread argument
 * with, and a slot read as a minimum-out that is really a fee tier estimates
 * gas perfectly cleanly.
 */
async function prepareBuy(chain, chainKey, ca, { wallet, valueWei, slippageBps, expectedTokens, tolPct }) {
  const iface = await ifaceFor(chain, chainKey, ca);
  if (!iface.ok) return { ok: false, why: iface.why, stage: 'discover' };

  const built = buildCurveCall(iface.buy, { token: ca, wallet, valueWei, slippageBps });
  if (!built.ok) return { ok: false, why: built.why, stage: 'build', needsMoreTrades: built.needsMoreTrades };
  // ⚠️ A CURVE PRICED IN A QUOTE TOKEN IS NOT SUPPORTED YET, and must not be
  // sent as if it were payable: the value would simply be lost to a function
  // that never asked for it. Buying with an ERC-20 needs an allowance step
  // this does not build.
  if (!iface.buy.native) {
    return { ok: false, stage: 'build', why: "this pad's buy is priced in a token rather than the native coin, which needs an approval step Dexvra doesn't build yet" };
  }

  const call = { to: iface.curve, data: built.data, value: valueWei };
  const sim = await simulate(chain, call, wallet);
  if (!sim.ok) return { ok: false, why: sim.why, stage: 'simulate', call };

  // NOT `built.expected ?? expectedTokens` — that compared the indexer's own
  // number against itself and passed everything.
  const check = sane(built.expected, expectedTokens, tolPct);
  if (!check.ok) return { ok: false, why: check.why, stage: 'sane', call };

  return { ok: true, why: null, call, gas: sim.gas, iface, slots: built.slots, describe: describeIface(iface) };
}

/**
 * A sell on the curve.
 *
 * ⚠️ SELLING NEEDS AN ALLOWANCE and this does not build one, so it refuses
 * rather than sending a call that will revert at the transferFrom. Saying that
 * plainly is the whole point: "the sell reverted" sends somebody hunting
 * through slippage settings for a step that was never taken.
 */
async function prepareSell(chain, chainKey, ca, { wallet, amountRaw, slippageBps, expectedNative, tolPct, allowance = 0n }) {
  const iface = await ifaceFor(chain, chainKey, ca);
  if (!iface.ok) return { ok: false, why: iface.why, stage: 'discover' };
  if (!iface.sell) {
    return { ok: false, stage: 'discover', why: "no SELL has been seen on this curve yet — one sale by anyone teaches it, and then this works" };
  }
  if (BigInt(allowance) < BigInt(amountRaw)) {
    return { ok: false, stage: 'approve', needsApprove: { spender: iface.curve, amountRaw }, why: 'the curve needs an allowance for this token before it can take it' };
  }
  const built = buildCurveCall(iface.sell, { token: ca, wallet, amountRaw, slippageBps });
  if (!built.ok) return { ok: false, why: built.why, stage: 'build', needsMoreTrades: built.needsMoreTrades };

  const call = { to: iface.curve, data: built.data, value: 0n };
  const sim = await simulate(chain, call, wallet);
  if (!sim.ok) return { ok: false, why: sim.why, stage: 'simulate', call };

  const check = sane(built.expected, expectedNative, tolPct);
  if (!check.ok) return { ok: false, why: check.why, stage: 'sane', call };

  return { ok: true, why: null, call, gas: sim.gas, iface, slots: built.slots };
}

module.exports = { ifaceFor, prepareBuy, prepareSell, _reset, _cache };
