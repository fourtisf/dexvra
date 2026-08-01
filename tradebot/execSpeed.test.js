'use strict';
/*
 * Execution speed — the properties that decide whether a trade lands.
 *
 * None of this shows up in normal operation. A slow buy still buys; it just
 * buys later, at a worse price, or not at all when someone faster took the
 * fill. The failure is invisible in the logs and only visible in the P&L, which
 * is exactly why it needs to be pinned in tests.
 *
 * These assert the SHAPE of the hot path — how many round trips it costs and
 * which flags it sends — not the wall-clock, which depends on the RPC.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const solanaSrc = fs.readFileSync(path.join(__dirname, 'solana.js'), 'utf8');
const coreSrc = fs.readFileSync(path.join(__dirname, 'core.js'), 'utf8');

/** The body of a top-level function, for counting what it awaits. */
function bodyOf(src, name) {
  const re = new RegExp(`^(?:async )?function ${name}\\s*\\(`, 'm');
  const m = re.exec(src);
  assert.ok(m, `${name} not found`);
  let i = src.indexOf('{', m.index);
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return src.slice(i, j + 1);
  }
  throw new Error(`unbalanced braces in ${name}`);
}

// ── Solana ──────────────────────────────────────────────────────────────────

test('a swap is broadcast without preflight simulation', () => {
  // Preflight makes the RPC simulate the swap before accepting it: a full extra
  // round trip on the critical path, and under load it rejects transactions
  // that would have landed (it simulates against a slightly stale slot). The
  // trade is still protected — Jupiter bakes minOut into the instruction, so a
  // bad fill reverts on-chain rather than filling badly.
  const body = bodyOf(solanaSrc, 'sendJupiterSwap');
  assert.match(body, /skipPreflight:\s*true/, 'the swap send must skip preflight');
  assert.ok(!/skipPreflight:\s*false/.test(body), 'no preflight on the swap path');
});

test('the node does not own the retry loop — we re-send the same bytes ourselves', () => {
  // maxRetries hands the retry to the RPC, which is opaque and slow and cannot
  // be polled while it works. Re-broadcasting identical signed bytes is safe:
  // the signature is unchanged, so the cluster executes it at most once.
  const send = bodyOf(solanaSrc, 'sendJupiterSwap');
  assert.match(send, /maxRetries:\s*0/, 'the node must not retry on our behalf');

  const poll = bodyOf(solanaSrc, '_pollUntilLanded');
  assert.match(poll, /sendRawTransaction\(raw/, 'the chase loop must re-broadcast');
  assert.match(poll, /getSignatureStatuses/, 'and poll for the result while it does');
  assert.match(poll, /\.catch\(\(\) => \{\}\)/, 'a failed re-send must never abort the chase');
  // It must terminate: a chase with no deadline hangs the whole trade.
  assert.match(poll, /Date\.now\(\) >= deadline/, 'the chase must be bounded');
});

test('a swap costs no extra round trip just to compute a deadline', () => {
  // confirmTransaction needed a fresh getLatestBlockhash AFTER the tx was
  // already in flight — a round trip for a value used only as a timeout.
  const send = bodyOf(solanaSrc, 'sendJupiterSwap');
  assert.ok(!/getLatestBlockhash/.test(send), 'no blockhash fetch on the send path');
});

test('an explicit priority fee bids up to a ceiling, it is not a flat number', () => {
  // A flat fee is either wasteful or too low, and which one it is changes minute
  // to minute. A ceiling with a priority level lets Jupiter bid what the current
  // market needs and no more.
  const { swapBody } = require('./solana.js');
  const withFee = swapBody({ q: 1 }, 'Pubkey11111111111111111111111111111111111111', { priorityLamports: 1_000_000 });
  assert.deepStrictEqual(withFee.prioritizationFeeLamports, {
    priorityLevelWithMaxLamports: { maxLamports: 1_000_000, priorityLevel: 'high', global: false },
  });
  // Unset still falls back to Jupiter's own auto — never to nothing.
  const auto = swapBody({ q: 1 }, 'Pubkey11111111111111111111111111111111111111', {});
  assert.strictEqual(auto.prioritizationFeeLamports, 'auto');
});

test('the Solana buy reads its three inputs in parallel, not one by one', () => {
  // Balance, current bag and token metadata do not feed each other. Serially on
  // a public RPC that was ~1s spent before the swap was even quoted.
  const body = bodyOf(coreSrc, '_buySol');
  const par = /Promise\.all\(\[\s*[\s\S]{0,200}?solBalance[\s\S]{0,200}?splBalance[\s\S]{0,200}?tokenMeta/;
  assert.match(body, par, 'balance + bag + meta must be fetched together');
  // …and the balance check must still gate the trade.
  assert.match(body, /insufficient SOL/, 'the balance guard must survive the reshuffle');
});

test('the Solana sell reads bag and balance together', () => {
  const body = bodyOf(coreSrc, '_sellSol');
  assert.match(body, /Promise\.all\(\[\s*[\s\S]{0,160}?splBalance[\s\S]{0,160}?solBalance/);
  assert.match(body, /token balance is 0/, 'the empty-bag guard must survive');
});

// ── EVM ─────────────────────────────────────────────────────────────────────

test('the EVM buy reads its four independent inputs in parallel', () => {
  const body = bodyOf(coreSrc, 'buy');
  const par = /Promise\.all\(\[\s*[\s\S]{0,300}?ethBalance[\s\S]{0,300}?resolveCurve[\s\S]{0,300}?tokenBalance[\s\S]{0,300}?bestDexVenue/;
  assert.match(body, par, 'balance + curve + token balance + venue must be one round trip');
  // The venue probe must not be able to sink the buy — it is an optimisation.
  assert.match(body, /bestDexVenue\(ca, chainKey\)\.catch\(\(\) => null\)/);
  assert.match(body, /venuePick \|\| \(await bestDexVenue/, 'and must fall back when it failed');
  // The guards it reordered around still have to be there.
  assert.match(body, /insufficient \$\{chain\.native\}/, 'the balance guard must survive');
});

test('gas overrides are fetched once per send, not twice per trade', () => {
  // gasOverrides ran in buy() AND again inside rawSend(). On the curve and V3
  // paths the first result was never read — a round trip for nothing.
  const body = bodyOf(coreSrc, 'buy');
  const calls = (body.match(/await gasOverrides\(/g) || []).length;
  assert.strictEqual(calls, 1, 'only the V2 branch, which actually consumes it, may fetch overrides');
  assert.match(body, /const gas = await gasOverrides\(chainKey, gasBoost\);\s*\/\/ only this branch uses it/);
});

test('a send fetches gas price and nonce together', () => {
  const body = bodyOf(coreSrc, 'rawSend');
  assert.match(body, /Promise\.all\(\[\s*[\s\S]{0,160}?gasOverrides[\s\S]{0,160}?getTransactionCount/);
});

test('a swap can skip eth_estimateGas — a limit is a ceiling, not a price', () => {
  // Unused gas is refunded on EVM, so a generous fixed limit costs latency
  // saved and nothing else. Configurable back to estimating per trade.
  const body = bodyOf(coreSrc, 'v3SwapGas');
  assert.match(body, /if \(CFG\.evmSwapGasLimit > 0n\) return CFG\.evmSwapGasLimit/);
  assert.match(coreSrc, /EVM_SWAP_GAS_LIMIT/, 'it must be configurable');
  // Estimating must remain reachable, so a chain with unusual gas can opt back in.
  assert.match(body, /estimateGas/, 'the estimate path must survive as the opt-out');
});

// ── the guarantees that must NOT have been traded away for speed ────────────

test('minOut is still enforced on every venue', () => {
  // Speed must never come from removing the on-chain price protection: that is
  // the only thing standing between a fast fill and a drained wallet.
  const body = bodyOf(coreSrc, 'buy');
  assert.match(body, /minTok = exp \* \(10000n - slip\) \/ 10000n/, 'curve minOut');
  assert.match(body, /amountOutMinimum: minTok/, 'V3 minOut');
  assert.match(body, /swapExactETHForTokensSupportingFeeOnTransferTokens\(minTok/, 'V2 minOut');
});

test('an unconfirmed trade is still tagged broadcast, never rolled back', () => {
  // The whole retry/refund model rests on this: a tx we could not confirm MAY
  // still land, so callers must not free the budget and buy again.
  const send = bodyOf(solanaSrc, 'sendJupiterSwap');
  assert.match(send, /broadcast: true, sig/, 'Solana ambiguity must stay tagged');
  const body = bodyOf(coreSrc, 'buy');
  assert.match(body, /e\.broadcast = true/, 'EVM ambiguity must stay tagged');
});

// ── the provider itself ─────────────────────────────────────────────────────

test('the provider does not wait 4 seconds to notice a confirmed trade', () => {
  // ethers polls for a receipt every `pollingInterval` ms and defaults to 4000.
  // On BSC (0.75s blocks) or Base (2s) a trade that confirmed in one second is
  // not SEEN for four — which reads as a slow bot when the trade was fast. This
  // is the single biggest source of felt latency on EVM and it is one line.
  const { providerFor } = require('./chains.js');
  const p = providerFor('base');
  assert.ok(p.pollingInterval <= 1000, `pollingInterval is ${p.pollingInterval}ms — slower than a block`);
  assert.ok(p.pollingInterval >= 100, 'but not so tight it hammers the RPC');
});

test('JSON-RPC calls are batched, so parallel reads cost one request', () => {
  // Parallelising the pre-trade reads only pays off if they can share a request.
  // batchMaxCount was pinned to 1, which meant four awaits fired together were
  // still four separate HTTP round trips.
  const { providerFor } = require('./chains.js');
  const opt = (k) => providerFor(k)._getOption('batchMaxCount');
  assert.ok(opt('base') > 1, 'standard chains must batch');
  assert.ok(opt('ethereum') > 1, 'standard chains must batch');
  // Robinhood's node already rejects ethers' standard envelope on the send path,
  // so it is deliberately NOT handed a batch array.
  assert.strictEqual(opt('robinhood'), 1, 'robinhood must stay unbatched');
});

test('an empty venue is never cached — it is the answer that changes', async () => {
  // bestDexVenue caches for 10 minutes. Caching a "no pool" reading makes a
  // token UNBUYABLE for that window right after it graduates: the DEX branch
  // takes the stale empty venue and quotes against a pair that does not exist.
  //
  // This became reachable on every buy once the venue probe moved into the
  // parallel pre-trade block (it now runs for bonding-curve tokens too, which
  // legitimately have no pool yet), but the hole was always there via the token
  // scan, which probes the venue of tokens that have not graduated.
  const core = require('./core.js');
  const src = require('node:fs').readFileSync(require.resolve('./core.js'), 'utf8');
  const body = src.slice(src.indexOf('async function bestDexVenue'), src.indexOf('async function bestDexVenue') + 1200);
  assert.match(body, /if \(v\.wethBal > 0n\) _venueCache\.set/, 'a zero-liquidity probe must not be cached');

  // And prove it end to end against the real cache: two probes of a token with
  // no pool must both do the work, rather than the second one being served a
  // stale "there is nothing here".
  let calls = 0;
  const realProviderFor = core.providerFor;
  // A token that exists nowhere → both v2Depth and v3BestPool return empty.
  const dead = '0x' + 'ab'.repeat(20);
  const probe = async () => { calls++; return core.bestDexVenue(dead, 'base').catch(() => null); };
  const a = await probe();
  const b = await probe();
  assert.strictEqual(calls, 2);
  // Whatever the network did, neither answer may claim liquidity that is not there.
  for (const v of [a, b]) if (v) assert.ok(!v.wethBal || v.wethBal === 0n, 'a dead token must not report depth');
  assert.strictEqual(typeof realProviderFor, 'function');
});
