'use strict';
/*
 * BUILD A BUY/SELL ON A LAUNCHPAD CURVE — from an interface that was OBSERVED,
 * never one that was researched.
 *
 * `curveIface.js` reads the call shape off real trades and `classifySlots`
 * works out what each argument means. This turns that into OUR call, and its
 * whole job is to be strict about the one thing that matters:
 *
 *     A SLOT NOBODY CAN EXPLAIN STOPS THE TRADE.
 *
 * Not defaults to zero, not reuses the stranger's value, not "probably a
 * deadline". Pons shipped a researched factory AND a researched event
 * signature; the box measured both and both were wrong. Those failures made
 * the bot go quiet. This one would move money.
 *
 * ⚠️ AND CALLDATA IS STILL NOT PERMISSION. Nothing here signs. `simulate()` has
 * to accept the built call, and the caller has to cross-check what it would
 * receive against an independent price, before any of this reaches a wallet.
 * Knowing an interface and being allowed to fill a swap are different things —
 * the line v4.js already draws between price() and canSwapLive().
 */
const { classifySlots } = require('./curveIface.js');

const HEX = (n) => BigInt(n).toString(16).padStart(64, '0');
const addrWord = (a) => '0'.repeat(24) + String(a).slice(2).toLowerCase();
const E18 = 10n ** 18n;

/**
 * Our own call on the curve.
 *
 * `valueWei` is what WE are spending (a buy) and `amountRaw` what we are
 * selling. `slippageBps` is applied to every slot that scales with the trade —
 * those are minimum-out bounds, and ours must be computed for OUR size.
 */
function buildCurveCall(leg, opts) {
  const { token, wallet, valueWei = 0n, amountRaw = 0n, slippageBps = 500, minSamples } = opts || {};
  if (!leg || !leg.selector) return { ok: false, why: 'no observed call to build from' };
  if (!/^0x[a-fA-F0-9]{40}$/.test(String(token || ''))) return { ok: false, why: 'not an EVM token address' };
  if (!/^0x[a-fA-F0-9]{40}$/.test(String(wallet || ''))) return { ok: false, why: 'no wallet to build for' };

  const cls = classifySlots(leg, token, { minSamples });
  if (!cls.ok) return { ok: false, why: cls.why, slots: cls.slots, needsMoreTrades: /only \d+ sample/.test(cls.why || '') };

  // The size OUR call is denominated in: what we pay on a buy, what we hand
  // over on a sell. A scaling slot is a bound on the other side of that.
  const size = valueWei > 0n ? valueWei : amountRaw;

  const words = [];
  // What the CURVE's own arguments say we should receive, before slippage. This
  // is the only number the built call itself asserts, and it is what `sane()`
  // has to compare against an independent price — see the note at the return.
  let expected = null;
  for (const s of cls.slots) {
    if (s.role === 'token') { words.push(addrWord(token)); continue; }
    if (s.role === 'sender') { words.push(addrWord(wallet)); continue; }
    if (s.role === 'constant') { words.push(s.value); continue; }
    if (s.role === 'scales') {
      if (size <= 0n) return { ok: false, why: 'this call has an amount-scaled argument but no amount was given' };
      // ⚠️ RECOMPUTED FOR OUR SIZE, then cut by slippage. Reusing the observed
      // number would carry somebody else's bound: too high and every buy
      // reverts, too low and it is a free option for anyone watching.
      expected = (s.ratioE18 * size) / E18;
      const bounded = (expected * BigInt(10000 - Math.max(0, Math.min(9000, slippageBps)))) / 10000n;
      words.push(HEX(bounded > 0n ? bounded : 1n));
      continue;
    }
    return { ok: false, why: `argument ${s.i} is not understood — refusing to build a call around it` };
  }

  return {
    ok: true,
    why: null,
    data: leg.selector + words.join(''),
    value: valueWei,
    slots: cls.slots,
    samples: cls.samples,
    /**
     * ⚠️ THE CALL'S OWN EXPECTATION, and `null` when it has none.
     *
     * `sane()` exists to catch an interface read the right shape and the wrong
     * meaning, and it can only do that by comparing TWO independent numbers.
     * The caller passed `built.expected ?? expectedTokens` for a while, which
     * — with `expected` never set — compared the indexer's number against
     * itself and therefore passed everything. A gate that cannot fail is worse
     * than no gate: it reads as protection in every review of the code.
     *
     * `null` is honest and is a REFUSAL upstream: a pad whose buy carries no
     * amount-scaled argument gives us nothing to check the interface against,
     * and offers no on-chain slippage bound of its own either.
     */
    expected,
  };
}

/**
 * Would the chain accept this call?
 *
 * `estimateGas` reverts exactly when the transaction would, so it is the
 * cheapest honest answer to "is this really the buy function" — and it costs
 * nothing and moves nothing. It is a gate, never a promise: gas estimating is
 * not the same as receiving what we expect, which is why the caller still has
 * to compare the outcome against an independent price.
 */
async function simulate(chain, call, from) {
  try {
    const gas = await chain.estimateGas({ from, to: call.to, data: call.data, value: call.value });
    return { ok: true, gas: BigInt(gas), why: null };
  } catch (e) {
    const m = (e && (e.shortMessage || e.message)) || String(e);
    return { ok: false, gas: 0n, why: `the curve rejected this call (${m})` };
  }
}

/**
 * The last gate: does what we would receive agree with what the indexer says
 * the token is worth?
 *
 * An observed interface can be right about the SHAPE and wrong about the
 * meaning — a slot read as a minimum-out that is really a fee tier still
 * estimates gas cleanly. So the built call's own expectation is compared with
 * an independent price, and a wide disagreement refuses the trade. This is the
 * check that makes a discovered route safe to sign rather than merely likely.
 */
function sane(expectedTokens, indexerTokens, tolPct = 35) {
  if (!(expectedTokens > 0n) || !(indexerTokens > 0n)) {
    return { ok: false, why: 'no independent price to check the curve quote against' };
  }
  const hi = expectedTokens > indexerTokens ? expectedTokens : indexerTokens;
  const lo = expectedTokens > indexerTokens ? indexerTokens : expectedTokens;
  const offPct = Number(((hi - lo) * 100n) / hi);
  if (offPct > tolPct) {
    return { ok: false, offPct, why: `the curve would give ${offPct}% away from the indexed price — refusing rather than guessing which is right` };
  }
  return { ok: true, offPct, why: null };
}

module.exports = { buildCurveCall, simulate, sane, _addrWord: addrWord, _HEX: HEX };
