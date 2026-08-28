'use strict';
/*
 * READ A LAUNCHPAD CURVE'S BUY/SELL INTERFACE OFF THE CHAIN.
 *
 * WHY THIS EXISTS
 * A token still on a bonding curve has no AMM pool, so on EVM there is nothing
 * for a router to route: the card says "this token's liquidity is on Pons v2,
 * which Dexvra can't route through yet", and every buy is refused. On Solana
 * the same class of token trades fine, because Jupiter aggregates those curves
 * and `_solRoutable` asks it for a real quote. EVM has no such aggregator, so
 * each pad's curve has to be called directly — and calling it needs its ABI.
 *
 * ⚠️ AND A GUESSED ABI ON A MONEY PATH IS THE ONE THING THIS REPO REFUSES.
 * Pons shipped a researched factory address AND a researched event signature
 * once; the box measured both and BOTH WERE WRONG (see CLAUDE.md). Two guesses,
 * each individually enough to make the scan inert. A buy built the same way
 * does not go inert — it spends somebody's money into a contract nobody
 * verified.
 *
 * So nothing here is guessed. Every field below is READ FROM A REAL TRADE that
 * somebody already made on the pad's own website:
 *
 *   every trade on a curve moves the token to or from the curve contract,
 *   which emits a Transfer, which carries its transaction hash, from which
 *   the call — contract, 4-byte selector, argument words — is one read away.
 *
 * This was already true in `scripts/robinhood-preflight.js` section 4x, where
 * it printed the lines for an operator to send back. That is a round trip, and
 * the round trip is the thing in the way: the bot can read the chain itself.
 * One owner, used by both — the script keeps the human-readable report, this
 * keeps the decision.
 *
 * ⚠️ THIS MODULE DECIDES NOTHING ABOUT SPENDING. It returns what it observed
 * and how sure it is. Whether that is enough to sign a transaction is the
 * caller's call, and the answer must involve simulating the built call before
 * anybody's money moves — the line `poolstrade.js` and `curveSnapshot()`
 * already draw between knowing a price and being able to fill a swap.
 */

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

/**
 * A 32-byte word that is an ABI-encoded address (12 zero bytes, then 20).
 *
 * ⚠️ A SMALL NUMBER IS SHAPE-IDENTICAL TO A LOW ADDRESS, and reading one as
 * the other is how a route writes the wrong value into the wrong argument
 * slot. `minTokensOut = 500` encodes as twelve zero bytes and then twenty more
 * that are "an address" — the first version of this accepted it, and a caller
 * building a buy from that layout would have put an amount where the contract
 * wanted a recipient.
 *
 * The 20 address bytes are therefore required to carry something in their TOP
 * four: a real address has a non-zero byte up there with overwhelming
 * probability, and a number small enough to look like an address does not.
 * `num` is computed for EVERY word regardless, so the ambiguity stays visible
 * to the caller instead of being silently resolved here.
 */
const wordAddr = (w) =>
  /^0{24}[0-9a-fA-F]{40}$/.test(w) && !/^0{8}/.test(w.slice(24)) ? '0x' + w.slice(24).toLowerCase() : null;
const topicAddr = (t) => (typeof t === 'string' && t.length === 66 ? '0x' + t.slice(26).toLowerCase() : null);
const lc = (s) => String(s || '').toLowerCase();
/** A Transfer's `value` — the non-indexed uint256 in the log data. */
const logAmount = (lg) => { try { return BigInt(lg && lg.data ? lg.data : 0); } catch (_) { return 0n; } };

/** The calldata's argument words, classified. Bounded: a curve buy takes a
 *  handful of arguments, and a long tail is calldata we do not understand
 *  anyway. */
function argsOf(data, token) {
  const body = String(data || '').slice(10);
  const out = [];
  for (let i = 0; i < Math.min(8, Math.floor(body.length / 64)); i++) {
    const w = body.slice(i * 64, i * 64 + 64);
    const addr = wordAddr(w);
    // ALWAYS both readings. A word that is an address is also a number, and a
    // caller deciding what to put in this slot needs to see what it actually
    // held rather than this module's opinion of it.
    let n = null;
    try { n = BigInt('0x' + w); } catch (_) { n = null; }
    out.push({ i, word: w, addr, num: n, isToken: !!addr && addr === lc(token) });
  }
  return out;
}

/**
 * What the chain says about how this token is traded.
 *
 * `chain` is anything with `getLogs` and `getTransaction` — an ethers provider
 * in production, a counting stub in the tests. Injected rather than imported so
 * this is provable without a node, which is the only way it CAN be proved from
 * a sandbox with no egress.
 *
 * Returns `{ ok, why, curve, buy, sell, samples }`. `ok:false` always means
 * "could not look" or "nothing to look at" — never "this token cannot be
 * traded", because those are different facts and the second one is not ours to
 * assert from a quiet block window.
 */
async function decodeCurveIface(chain, token, opts = {}) {
  const span = Math.max(100, Number(opts.blocks) || 5000);
  const maxTx = Math.max(1, Number(opts.maxTx) || 12);
  const head = Number(opts.head);
  if (!/^0x[a-fA-F0-9]{40}$/.test(String(token || ''))) return { ok: false, why: 'not an EVM token address' };

  let logs;
  try {
    logs = await chain.getLogs({ address: token, topics: [TRANSFER_TOPIC], fromBlock: Math.max(0, head - span), toBlock: head });
  } catch (e) {
    // "We could not look" — never cached, never rendered as a fact about the
    // token. The rule `pumpfunNewX` states, on the surface that spends money.
    return { ok: false, why: `could not read this token's transfers (${(e && e.message) || e})` };
  }
  if (!logs || !logs.length) return { ok: false, why: `nobody has traded this token in the last ${span} blocks` };

  // Newest first: a curve's interface can change between deployments, and the
  // most recent trades are the ones a route built now has to match.
  const newest = logs.slice(-maxTx).reverse();
  const calls = new Map(); // `${to}|${selector}` → record
  for (const lg of newest) {
    let tx = null;
    try { tx = await chain.getTransaction(lg.transactionHash); } catch (_) { continue; }
    if (!tx || !tx.to || !tx.data || tx.data.length < 10) continue;
    const to = lc(tx.to);
    const sel = tx.data.slice(0, 10).toLowerCase();
    const key = `${to}|${sel}`;
    const rec = calls.get(key) || { to, sel, n: 0, value: 0n, hash: lg.transactionHash, args: argsOf(tx.data, token), from: null, into: null, samples: [] };
    rec.n++;
    const v = BigInt(tx.value || 0);
    // ⚠️ EVERY SAMPLE IS KEPT, not just the biggest. One trade shows the SHAPE
    // of a call; it cannot show what any argument MEANS. A slot that holds 500
    // in one buy is a mystery — the same slot across three buys of different
    // sizes is either a constant, or a number that scales with the amount, and
    // those need opposite treatment when we build our own call. `classifySlots`
    // is what turns samples into meaning, and it needs more than one.
    // ⚠️ THE TOKEN AMOUNT, TOO — because on a SELL `msg.value` is always zero.
    // The size a sell is denominated in lives in an argument, not in the value
    // field, so correlating slots against `value` alone can never explain a
    // sell's arguments: every slot looks constant, nothing scales, and the
    // price gate then has no curve-side number to check. The Transfer log the
    // sample came from carries the amount, so it costs nothing to keep.
    rec.samples.push({ value: v, amount: logAmount(lg), args: argsOf(tx.data, token), from: lc(tx.from), hash: lg.transactionHash });
    // The largest value seen for this shape, so one dust trade does not hide a
    // real one.
    if (v > rec.value) { rec.value = v; rec.hash = lg.transactionHash; rec.args = argsOf(tx.data, token); }
    // ⚠️ DIRECTION COMES FROM THE TRANSFER, NOT FROM `value`. A buy moves the
    // token OUT of the curve and a sell moves it IN, and that is true even for
    // a pad whose buy takes a quote token rather than native — where `value`
    // is 0 and judging by it alone would classify every buy as a sell.
    if (topicAddr(lg.topics && lg.topics[1]) === to) rec.from = to;   // curve paid out → buy
    if (topicAddr(lg.topics && lg.topics[2]) === to) rec.into = to;   // curve took in  → sell
    calls.set(key, rec);
  }
  if (!calls.size) return { ok: false, why: 'no decodable calls behind those transfers — they may all be plain wallet-to-wallet sends' };

  // THE CURVE IS THE CONTRACT THE TOKEN ITSELF MOVES TO AND FROM. A router or a
  // wallet that merely appears in the calldata does not; this is the one
  // property that separates the curve from every other address in the trace.
  const score = new Map();
  for (const r of calls.values()) {
    if (!r.from && !r.into) continue;
    score.set(r.to, (score.get(r.to) || 0) + r.n);
  }
  const curve = [...score.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  if (!curve) {
    return { ok: false, why: 'the token moved, but never to or from the contract that was called — no curve in these trades' };
  }

  const mine = [...calls.values()].filter((r) => r.to === curve);
  const buy = mine.filter((r) => r.from).sort((a, b) => (b.value > a.value ? 1 : b.value < a.value ? -1 : b.n - a.n))[0] || null;
  const sell = mine.filter((r) => r.into && (!buy || r.sel !== buy.sel)).sort((a, b) => b.n - a.n)[0] || null;

  return {
    ok: !!buy,
    why: buy ? null : 'these trades show no BUY — only the curve taking the token in. Make one small buy on the pad and it will be read next time.',
    curve,
    buy: buy && { selector: buy.sel, value: buy.value, args: buy.args, hash: buy.hash, seen: buy.n, native: buy.value > 0n, samples: buy.samples },
    sell: sell && { selector: sell.sel, args: sell.args, hash: sell.hash, seen: sell.n, samples: sell.samples },
    samples: newest.length,
  };
}

/** One line for the ops log / the card. Never a claim that a route EXISTS —
 *  only that an interface was observed. */
function describeIface(r) {
  if (!r || !r.ok) return (r && r.why) || 'no curve interface found';
  const a = r.buy.args.map((x) => (x.isToken ? 'TOKEN' : x.addr ? 'addr' : x.num === null ? '?' : 'num')).join(',');
  return `curve ${r.curve} · buy ${r.buy.selector}${r.buy.native ? ' (payable)' : ''} args[${a}]${r.sell ? ` · sell ${r.sell.selector}` : ' · sell not seen'}`;
}

module.exports = { decodeCurveIface, describeIface, TRANSFER_TOPIC, _argsOf: argsOf, _wordAddr: wordAddr };

/*
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT DOES EACH ARGUMENT MEAN?
 *
 * Knowing a call's SHAPE is not knowing how to make one. `buy(address,uint256)`
 * with the observed words `[TOKEN, 500]` says nothing about whether 500 is a
 * minimum-out, a deadline, a referrer code or a slippage bound — and building
 * our own buy means putting OUR number in that slot. Guessing there is the same
 * class of mistake as guessing the contract address, with the same consequence.
 *
 * One trade cannot answer it. SEVERAL CAN, because the samples differ:
 *
 *   • a slot equal to the token, in every sample            → the token
 *   • a slot equal to that sample's SENDER                  → the recipient
 *   • a slot whose value/msg.value ratio holds across
 *     samples of different sizes                            → scales with the trade
 *   • a slot identical in every sample                      → a constant
 *   • anything else                                         → UNKNOWN
 *
 * ⚠️ AND UNKNOWN IS A REFUSAL, NOT A DEFAULT. A slot nobody can explain is the
 * one that must stop the buy: filling it with the value from somebody else's
 * trade is how a bot sends a stranger's referrer code, an expired deadline, or
 * a minimum-out computed for an amount 100× ours. "A missed trade is a shrug;
 * spending wrongly is not" — this repo's own rule, one module over.
 */

/** Two ratios agree if they are within `tolBps` of each other. Curves are not
 *  linear, so a minimum-out does NOT scale exactly with the amount — the test
 *  is that it tracks, not that it matches. */
const ratioClose = (a, b, tolBps) => {
  if (a === 0n || b === 0n) return a === b;
  const hi = a > b ? a : b, lo = a > b ? b : a;
  return (hi - lo) * 10000n <= hi * BigInt(tolBps);
};

/**
 * Per-slot roles for a decoded leg, from its samples.
 *
 * `minSamples` is 2 by default: with one sample every slot is "constant", which
 * is true and useless — and would let a referrer code be reused as a constant
 * while a minimum-out is frozen at somebody else's number.
 */
function classifySlots(leg, token, opts = {}) {
  const minSamples = Math.max(1, Number(opts.minSamples) || 2);
  const tolBps = Number(opts.tolBps) || 4000;      // curves bend; 40% is "tracks", not "equals"
  const samples = (leg && leg.samples) || [];
  const width = leg && leg.args ? leg.args.length : 0;
  const out = { ok: false, why: null, slots: [], samples: samples.length };

  if (!width) { out.ok = true; out.why = null; return out; }   // no arguments at all is a complete answer
  if (samples.length < minSamples) {
    out.why = `only ${samples.length} sample${samples.length === 1 ? '' : 's'} of this call — at least ${minSamples} are needed before an argument's meaning can be inferred`;
    out.slots = leg.args.map((a, i) => ({ i, role: 'unknown', value: a.word }));
    return out;
  }

  for (let i = 0; i < width; i++) {
    const words = samples.map((s) => (s.args[i] ? s.args[i].word : null));
    if (words.some((w) => w === null)) { out.slots.push({ i, role: 'unknown', why: 'not present in every sample' }); continue; }
    const first = samples[0].args[i];

    if (samples.every((s) => s.args[i].isToken)) { out.slots.push({ i, role: 'token' }); continue; }
    if (samples.every((s) => s.args[i].addr && s.from && s.args[i].addr === s.from)) { out.slots.push({ i, role: 'sender' }); continue; }

    const same = words.every((w) => w === words[0]);
    // A slot that scales BEFORE one that is merely constant: on a run of
    // equal-sized samples an amount slot is also constant, and freezing it
    // would send a minimum-out computed for a trade that is not ours.
    const values = samples.map((s) => s.args[i].num);
    // The SIZE this leg is denominated in: what was paid on a buy, what was
    // handed over on a sell. Without the second half a sell explains nothing.
    const vals = samples.map((s) => (s.value > 0n ? s.value : BigInt(s.amount || 0)));
    const varied = vals.some((v) => v !== vals[0]);
    if (varied && values.every((n) => n !== null && n > 0n) && vals.every((v) => v > 0n)) {
      const r0 = (values[0] * 10n ** 18n) / vals[0];
      if (samples.every((s, k) => ratioClose((values[k] * 10n ** 18n) / vals[k], r0, tolBps))) {
        out.slots.push({ i, role: 'scales', ratioE18: r0 });
        continue;
      }
    }
    if (same) { out.slots.push({ i, role: 'constant', value: first.word }); continue; }
    out.slots.push({ i, role: 'unknown', why: 'differs between samples with no relationship to the amount' });
  }

  const bad = out.slots.filter((s) => s.role === 'unknown');
  out.ok = bad.length === 0;
  // ⚠️ Never "the token cannot be traded" — only "we cannot build this call
  // safely yet". A wider window, or one more trade on the pad, changes it.
  if (!out.ok) out.why = `argument${bad.length === 1 ? '' : 's'} ${bad.map((s) => s.i).join(', ')} could not be explained from ${samples.length} samples`;
  return out;
}

module.exports.classifySlots = classifySlots;
module.exports._ratioClose = ratioClose;
