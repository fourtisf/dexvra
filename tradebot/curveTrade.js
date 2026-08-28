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
const { decodeCurveIface, describeIface, TRANSFER_TOPIC } = require('./curveIface.js');
const { buildCurveCall, simulate, sane, _big: big } = require('./curveRoute.js');

/*
 * ⚠️ THE INDEXER'S TRADE LIST SEEDS DISCOVERY, because the window ladder can
 * be structurally blind on the box this feature is for.
 *
 * Robinhood's public RPC silently caps wide `eth_getLogs` — a 50,000-block ask
 * answered [] over real trades, which is what forced the stepped walk — and
 * the wider windows' steps grow with the span (400,000/24 ≈ 16,667 blocks), so
 * past some age the walk cannot see a trade AT ALL: every range big enough to
 * reach it within the budget is silently emptied. A curve token whose last
 * trade is half a day old therefore read "no trades found" for ever, and its
 * card said "can't route through yet" over a token DexScreener was pricing on
 * the same render.
 *
 * The indexer that prices it also PUBLISHES its trades' transaction hashes.
 * They are used as POINTERS ONLY: everything decoded still comes from the
 * chain's own receipts and transactions — the same trust base as getLogs — so
 * a wrong or fabricated hash yields no receipt or no Transfer of OUR token and
 * contributes nothing. Every gate downstream (classification, sane(),
 * simulate) is unchanged. An indexer that is down costs the seed and nothing
 * else: the ladder still runs.
 */
const SEED_MAX_TX = 12;

/** This token's trade Transfers, read off the RECEIPTS of the given hashes.
 *  Oldest-first, the order the walk produces. Per-receipt failures are
 *  skipped — a pointer that resolves to nothing contributes nothing. */
async function _receiptLogs(chain, token, hashes) {
  if (typeof chain.getTransactionReceipt !== 'function') return [];
  const lcTok = String(token).toLowerCase();
  const out = [];
  // Newest-first from the indexer; decode expects oldest-first input.
  for (const h of hashes.slice(0, SEED_MAX_TX).reverse()) {
    let rcpt = null;
    try { rcpt = await chain.getTransactionReceipt(h); } catch (_) { continue; }
    for (const lg of (rcpt && rcpt.logs) || []) {
      if (!lg || String(lg.address || '').toLowerCase() !== lcTok) continue;
      if (!lg.topics || lg.topics[0] !== TRANSFER_TOPIC) continue;
      out.push({ transactionHash: h, topics: lg.topics, data: lg.data, blockNumber: lg.blockNumber });
    }
  }
  return out;
}

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

/** The cached interface for a token, or null. Read-only, no network.
 *
 *  `canTradeNow` needs this: it is polled on a timer by the CA snipe and the
 *  launch retry ring, so it may not pay a dozen RPC reads per probe. A cached
 *  yes is a cheap yes; the absence of one is not a no, which is why the caller
 *  must not turn a miss into "this token cannot be traded". */
function cached(chainKey, ca) { return _cached(chainKey, ca); }

/** Forget a token's interface.
 *
 *  ⚠️ A CURVE THAT REJECTS OUR CALL MAY HAVE BEEN REDEPLOYED, and the cache
 *  holds its OLD address for half an hour. Without this, every buy in that
 *  window aims at an abandoned contract, is refused with "the curve rejected
 *  this call", and there is no path back except waiting — a stuck state that
 *  looks exactly like a broken feature. Re-discovery costs a dozen reads; being
 *  stuck costs the token. */
function forget(chainKey, ca) { _cache.delete(key(chainKey, ca)); }

/**
 * The curve interface for a token, discovered once and remembered.
 *
 * `chain` needs `getLogs`, `getTransaction` and `getBlockNumber`. Injected, so
 * this is provable without a node — the only way it CAN be proved from a
 * sandbox with no egress, which is where every line of it was written.
 */
/*
 * ⚠️ THE WINDOW IS ESCALATED, because "any launchpad" means any PACE.
 *
 * The decoder's default window is 5000 blocks — under three hours on a
 * two-second chain. A pad whose tokens trade a few times a day reads as "no
 * trades found" there, which is a statement about the WINDOW being reported as
 * a fact about the token, and it is what would have made this feature look
 * Pons-shaped: fine on a busy launch, blind on a quiet one.
 *
 * Widening the first look instead would make every lookup pay for the slowest
 * pad, on a call that sits inside the wallet lock. So: start cheap, and widen
 * only when the cheap look found NOTHING — which is the one answer a wider
 * window can change. A transport failure never escalates: asking a dead node
 * three times is three times the wait for the same silence.
 */
const WINDOWS = (() => {
  const raw = String(process.env.CURVE_WINDOWS || '5000,60000,400000').split(',');
  const out = raw.map((x) => Math.floor(Number(String(x).trim()))).filter((n) => Number.isFinite(n) && n >= 100);
  return out.length ? out : [5000, 60000, 400000];
})();

async function ifaceFor(chain, chainKey, ca, opts = {}) {
  const hit = _cached(chainKey, ca);
  if (hit) return hit;
  let head;
  try { head = Number(await chain.getBlockNumber()); }
  catch (e) { return { ok: false, why: `could not read the chain head (${(e && e.message) || e})` }; }   // NOT cached: an outage is not a fact about the token

  // At most ONE seed attempt per discovery, tried after the FIRST empty window
  // — the cheap window finds a fresh launch's trades by itself, and a quiet
  // token gets the seed before paying for the two wide windows that are
  // usually blind to it anyway (see the header on _receiptLogs).
  let seedTried = false;
  const trySeed = async () => {
    if (seedTried || typeof opts.tradeHashes !== 'function') return null;
    seedTried = true;
    let hashes = null;
    try { hashes = await opts.tradeHashes(); } catch (_) { return null; }
    if (!Array.isArray(hashes) || !hashes.length) return null;
    const logs = await _receiptLogs(chain, ca, hashes);
    if (!logs.length) return null;
    const r = await decodeCurveIface(chain, ca, { logs, maxTx: opts.maxTx });
    return r.ok ? r : null;
  };

  const windows = opts.blocks ? [Math.floor(Number(opts.blocks))] : WINDOWS;
  let res = null;
  for (const blocks of windows) {
    res = await decodeCurveIface(chain, ca, { head, blocks, maxTx: opts.maxTx, steps: opts.steps });
    if (res.ok) break;
    // Only "we looked and this window held nothing" is worth widening. Every
    // other refusal — a call we cannot decode, a token that never touched the
    // contract, a node that would not answer — says the same thing at any size.
    if (!/^no trades found/.test(res.why || '')) break;
    const s = await trySeed();
    if (s) { res = s; break; }
  }
  // A walk that ended in a transport failure never reached the seed — and the
  // seed is a DIFFERENT transport, so it is still worth one try.
  if (res && !res.ok) { const s = await trySeed(); if (s) res = s; }

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
async function prepareBuy(chain, chainKey, ca, { wallet, valueWei, quoteRaw, slippageBps, expectedTokens, tolPct, minOutRaw }) {
  // Normalised at the door, so a Number from core.js's price side can never
  // reach a BigInt comparison and throw instead of refusing.
  const spendWei = big(valueWei) ?? 0n;
  // A pad priced in an ERC-20 pays nothing in `value`; what it spends is the
  // allowance the caller has already granted. One of the two must be real.
  const spendQuote = big(quoteRaw) ?? 0n;
  if (!(spendWei > 0n) && !(spendQuote > 0n)) return { ok: false, stage: 'build', why: 'no amount to spend' };
  const iface = await ifaceFor(chain, chainKey, ca);
  if (!iface.ok) return { ok: false, why: iface.why, stage: 'discover' };
  // `ok` means "an interface was read", which since the sell-only fix no longer
  // implies a BUY leg. The buy question needs its own answer and its own
  // sentence — one more trade on the pad is the fix, and saying so is the
  // difference between a diagnosis and a shrug.
  if (!iface.buy) {
    return { ok: false, stage: 'discover', needsMoreTrades: true, why: 'no BUY has been seen through this curve yet — the recent trades are all sells. One purchase by anyone on the pad teaches it.' };
  }

  /*
   * ⚠️ A PAYABLE CALL AND A QUOTE-TOKEN CALL ARE DIFFERENT TRANSACTIONS, and
   * sending one as the other loses the money: `value` handed to a function that
   * never asked for it is simply gone.
   *
   * A quote-token pad is supported now — the caller has to have swapped into
   * that token and approved the curve for it first, which is why `quoteRaw` is
   * REQUIRED here rather than assumed. Refusing without it is what stops a
   * value-less call being built for a payable pad and vice versa.
   */
  if (iface.buy.native && !(spendWei > 0n)) {
    return { ok: false, stage: 'build', why: "this pad's buy is paid in the native coin and no amount was given" };
  }
  if (!iface.buy.native) {
    if (!iface.buy.quote) {
      return { ok: false, stage: 'build', why: "this pad's buy is not paid in the native coin, and its trades do not show what it IS paid in — refusing rather than guessing a token address" };
    }
    if (!(spendQuote > 0n)) {
      return { ok: false, stage: 'quote', quoteToken: iface.buy.quote, why: `this pad is priced in ${iface.buy.quote}, not the native coin` };
    }
  }

  const built = buildCurveCall(iface.buy, {
    token: ca, wallet, slippageBps, minOutRaw,
    valueWei: iface.buy.native ? spendWei : 0n,
    sizeRaw: iface.buy.native ? 0n : spendQuote,
  });
  if (!built.ok) return { ok: false, why: built.why, stage: 'build', needsMoreTrades: built.needsMoreTrades };

  const call = { to: iface.curve, data: built.data, value: iface.buy.native ? spendWei : 0n };
  const sim = await simulate(chain, call, wallet);
  // A rejected call may mean the pad redeployed under us — see `forget`.
  if (!sim.ok) { forget(chainKey, ca); return { ok: false, why: sim.why, stage: 'simulate', call }; }

  // NOT `built.expected ?? expectedTokens` — that compared the indexer's own
  // number against itself and passed everything.
  const check = sane(built.expected, expectedTokens, tolPct);
  if (!check.ok) return { ok: false, why: check.why, stage: 'sane', call };

  return { ok: true, why: null, call, gas: sim.gas, iface, slots: built.slots, quoteToken: iface.buy.native ? null : iface.buy.quote, boundedByIndependentPrice: built.boundedByIndependentPrice, describe: describeIface(iface) };
}

/**
 * A sell on the curve.
 *
 * ⚠️ SELLING NEEDS AN ALLOWANCE and this does not build one, so it refuses
 * rather than sending a call that will revert at the transferFrom. Saying that
 * plainly is the whole point: "the sell reverted" sends somebody hunting
 * through slippage settings for a step that was never taken.
 */
async function prepareSell(chain, chainKey, ca, { wallet, amountRaw, slippageBps, expectedNative, tolPct, allowance = 0n, minOutRaw }) {
  const sellRaw = big(amountRaw);
  if (!(sellRaw > 0n)) return { ok: false, stage: 'build', why: 'no amount to sell' };
  const have = big(allowance) ?? 0n;   // an allowance we could not read is not an allowance
  const iface = await ifaceFor(chain, chainKey, ca);
  if (!iface.ok) return { ok: false, why: iface.why, stage: 'discover' };
  if (!iface.sell) {
    return { ok: false, stage: 'discover', why: "no SELL has been seen on this curve yet — one sale by anyone teaches it, and then this works" };
  }

  /*
   * ⚠️ THE ALLOWANCE CHECK RUNS LAST, AND THAT ORDER IS THE POINT.
   *
   * It used to run FIRST — above build, above the price check, above simulate —
   * so a `stage:'approve'` refusal said nothing at all about whether the call
   * was buildable or sanely priced. The caller granted an allowance to a
   * contract address inferred from log scoring, re-called, and could still be
   * refused at 'build' ("argument 2 is not understood") or at 'sane'. The
   * approval stayed granted, forever, for a sell that never happened.
   *
   * Built and priced first collapses that to the one case that genuinely cannot
   * be pre-run: `simulate`, which reverts at the transferFrom without an
   * allowance. Everything that can refuse for free now refuses for free.
   */
  const built = buildCurveCall(iface.sell, { token: ca, wallet, amountRaw: sellRaw, slippageBps, minOutRaw });
  if (!built.ok) return { ok: false, why: built.why, stage: 'build', needsMoreTrades: built.needsMoreTrades };

  const check = sane(built.expected, expectedNative, tolPct);
  if (!check.ok) return { ok: false, why: check.why, stage: 'sane' };

  const call = { to: iface.curve, data: built.data, value: 0n };
  if (have < sellRaw) {
    // ⚠️ `amountRaw` EXACTLY, never an unlimited grant. The spender here was
    // inferred from Transfer logs and is vouched for by nobody — v4.js already
    // draws this line for a discovered router: "an operator-set router gets a
    // standing allowance; a discovered one gets this sell and nothing more."
    // An unlimited grant to a wrong address is the only unbounded loss in this
    // whole design, and it outlives the trade.
    return { ok: false, stage: 'approve', needsApprove: { spender: iface.curve, amountRaw: sellRaw, exact: true }, call, why: 'the curve needs an allowance for this token before it can take it' };
  }

  const sim = await simulate(chain, call, wallet);
  if (!sim.ok) { forget(chainKey, ca); return { ok: false, why: sim.why, stage: 'simulate', call }; }

  return { ok: true, why: null, call, gas: sim.gas, iface, slots: built.slots, quoteToken: (iface.sell && iface.sell.quote) || null, boundedByIndependentPrice: built.boundedByIndependentPrice };
}

module.exports = { ifaceFor, prepareBuy, prepareSell, cached, forget, _reset, _cache };
