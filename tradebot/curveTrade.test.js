'use strict';
/*
 * The gate between "we read an interface" and "we sign a transaction".
 * Every case is a way a discovered route could move money it should not.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { TRANSFER_TOPIC } = require('./curveIface.js');
const ct = require('./curveTrade.js');

const TOKEN = '0x3f8c5ac4c9b9391c99f4796e56228852a6796ddf';
const CURVE = '0xc0000000000000000000000000000000000000c0';
const WALLET = '0xa0000000000000000000000000000000000000a0';
const E17 = 10n ** 17n;
const word = (a) => '0'.repeat(24) + a.slice(2);
const topic = (a) => '0x' + '0'.repeat(24) + a.slice(2);
const num = (n) => BigInt(n).toString(16).padStart(64, '0');
const xfer = (from, to, hash, amt = 0n) => ({ topics: [TRANSFER_TOPIC, topic(from), topic(to)], data: '0x' + num(amt), transactionHash: hash });

/** Two buys of different sizes: enough for every slot to be explained. */
function chainWithBuys({ gas = async () => 210000n, sell = false } = {}) {
  const logs = [xfer(CURVE, WALLET, '0xb1'), xfer(CURVE, WALLET, '0xb2')];
  const txs = {
    '0xb1': { to: CURVE, from: WALLET, value: E17, data: '0xaabbccdd' + word(TOKEN) + num(1000n) },
    '0xb2': { to: CURVE, from: WALLET, value: 2n * E17, data: '0xaabbccdd' + word(TOKEN) + num(2000n) },
  };
  if (sell) {
    // Two sells of DIFFERENT size — the only thing that can explain a sell's
    // arguments, since msg.value is zero on both.
    logs.push(xfer(WALLET, CURVE, '0xs1', 1000n), xfer(WALLET, CURVE, '0xs2', 2000n));
    txs['0xs1'] = { to: CURVE, from: WALLET, value: 0n, data: '0x5e115e11' + word(TOKEN) + num(10n) };
    txs['0xs2'] = { to: CURVE, from: WALLET, value: 0n, data: '0x5e115e11' + word(TOKEN) + num(20n) };
  }
  return {
    async getBlockNumber() { return 9000; },
    async getLogs() { return logs; },
    async getTransaction(h) { return txs[h] || null; },
    estimateGas: gas,
  };
}

test.beforeEach(() => ct._reset());

test('a curve buy is prepared, simulated and price-checked before it can be signed', async () => {
  const chain = chainWithBuys();
  const r = await ct.prepareBuy(chain, 'robinhood', TOKEN, {
    wallet: WALLET, valueWei: E17, slippageBps: 500, expectedTokens: 1000n,
  });
  assert.equal(r.ok, true, r.why);
  assert.equal(r.call.to, CURVE);
  assert.ok(r.call.data.startsWith('0xaabbccdd'));
  assert.equal(r.call.value, E17);
  assert.equal(r.gas, 210000n);
});

test('⚠️ a call the chain would revert is NEVER signed, and the reason travels', async () => {
  const chain = chainWithBuys({ gas: async () => { throw new Error('execution reverted: NotOpen'); } });
  const r = await ct.prepareBuy(chain, 'robinhood', TOKEN, { wallet: WALLET, valueWei: E17, expectedTokens: 1000n });
  assert.equal(r.ok, false);
  assert.equal(r.stage, 'simulate');
  assert.match(r.why, /NotOpen/);
});

const QUOTE = '0x9999999999999999999999999999999999999999';

/** A pad priced in an ERC-20: no msg.value, and the payment visible only in the
 *  transaction's OTHER Transfer logs. */
function quoteChain({ quoteToken = QUOTE, agree = true } = {}) {
  const logs = [xfer(CURVE, WALLET, '0xq1'), xfer(CURVE, WALLET, '0xq2')];
  const txs = {
    '0xq1': { to: CURVE, from: WALLET, value: 0n, data: '0xaabbccdd' + word(TOKEN) + num(900n) },
    '0xq2': { to: CURVE, from: WALLET, value: 0n, data: '0xaabbccdd' + word(TOKEN) + num(1800n) },
  };
  const paid = { '0xq1': 1000n, '0xq2': 2000n };
  const other = { '0xq1': quoteToken, '0xq2': agree ? quoteToken : '0x8888888888888888888888888888888888888888' };
  return {
    async getBlockNumber() { return 9000; },
    async getLogs() { return logs; },
    async getTransaction(h) { return txs[h]; },
    async getTransactionReceipt(h) {
      return { logs: [{ address: other[h], topics: [TRANSFER_TOPIC, topic(WALLET), topic(CURVE)], data: '0x' + num(paid[h]) }] };
    },
    async estimateGas() { return 210000n; },
  };
}

test('⚠️ a quote-token curve is never sent a value it never asked for — and the token is READ, not guessed', async () => {
  // Its buy carries no native value, so sending ours would lose it to a
  // function that takes payment in an ERC-20. Which ERC-20 is in neither the
  // calldata nor this token's own logs — it is in the transaction's other
  // Transfer logs, where the trader paid the curve.
  const r = await ct.prepareBuy(quoteChain(), 'robinhood', TOKEN, { wallet: WALLET, valueWei: E17, expectedTokens: 900n });
  assert.equal(r.ok, false);
  assert.equal(r.stage, 'quote', 'a caller that can swap into it needs to know that, not just "no"');
  assert.equal(r.quoteToken, QUOTE);
  assert.match(r.why, /priced in/);
});

test('…and WITH the quote already in hand it builds, carrying no value at all', async () => {
  const r = await ct.prepareBuy(quoteChain(), 'robinhood', TOKEN, {
    // ⚠️ A NATIVE AMOUNT IS PASSED TOO, deliberately. The caller that swapped
    // into the quote token still knows what it spent, and a build that carried
    // that number into `value` would hand it to a function which never asked
    // for it — simply gone. Mutation-tested: without the native/quote branch
    // this assertion is the only thing that fails.
    wallet: WALLET, valueWei: E17, quoteRaw: 1000n, expectedTokens: 900n, slippageBps: 500,
  });
  assert.equal(r.ok, true, r.why);
  assert.equal(r.call.value, 0n, 'a value here would simply be lost');
  assert.equal(r.quoteToken, QUOTE);
  // Sized by the QUOTE paid, not by a native value that is zero by construction
  // — without which every slot correlates against zero and the pad reads as
  // broken rather than different.
  assert.equal(BigInt('0x' + r.call.data.slice(74, 138)), 855n);   // 900 less 5%
});

test('⚠️ samples that disagree about the quote token refuse — one token or none', async () => {
  // Two pads behind one selector, a router in the middle, or a read that went
  // wrong. Picking the commonest would put a guessed token address on a money
  // path.
  const r = await ct.prepareBuy(quoteChain({ agree: false }), 'robinhood', TOKEN, {
    wallet: WALLET, quoteRaw: 1000n, expectedTokens: 900n,
  });
  assert.equal(r.ok, false);
  assert.match(r.why, /do not show what it IS paid in/);
});

test('a payable pad still refuses when no native amount is given', async () => {
  const r = await ct.prepareBuy(chainWithBuys(), 'robinhood', TOKEN, {
    wallet: WALLET, quoteRaw: 1000n, expectedTokens: 1000n,
  });
  assert.equal(r.ok, false);
  assert.match(r.why, /paid in the native coin/);
});

test('⚠️ a quote that disagrees with the indexer refuses — gas estimating is not agreeing', async () => {
  const chain = chainWithBuys();
  const r = await ct.prepareBuy(chain, 'robinhood', TOKEN, {
    wallet: WALLET, valueWei: E17, slippageBps: 0, expectedTokens: 1n,   // indexer says 1, curve says ~1000
  });
  assert.equal(r.ok, false);
  assert.equal(r.stage, 'sane');
  assert.match(r.why, /away from the indexed price/);
});

test('no independent price is a refusal — there would be nothing left to catch a misread slot', async () => {
  const r = await ct.prepareBuy(chainWithBuys(), 'robinhood', TOKEN, { wallet: WALLET, valueWei: E17 });
  assert.equal(r.ok, false);
  assert.equal(r.stage, 'sane');
});

test('⚠️ selling refuses without an allowance, and names the step rather than the symptom', async () => {
  const chain = chainWithBuys({ sell: true });
  const r = await ct.prepareSell(chain, 'robinhood', TOKEN, { wallet: WALLET, amountRaw: 1000n, expectedNative: 10n, allowance: 0n });
  assert.equal(r.ok, false);
  assert.equal(r.stage, 'approve');
  assert.equal(r.needsApprove.spender, CURVE);
  // "the sell reverted" would send somebody hunting through slippage settings
  // for a step that was never taken.
  assert.match(r.why, /allowance/);
});

test('a curve nobody has sold on says so, and says what teaches it', async () => {
  const r = await ct.prepareSell(chainWithBuys(), 'robinhood', TOKEN, { wallet: WALLET, amountRaw: 1n, expectedNative: 1n, allowance: 10n ** 30n });
  assert.equal(r.ok, false);
  assert.match(r.why, /no SELL has been seen/);
});

test('with an allowance and a seen sell, the call is built against the curve', async () => {
  const chain = chainWithBuys({ sell: true });
  const r = await ct.prepareSell(chain, 'robinhood', TOKEN, {
    wallet: WALLET, amountRaw: 1000n, slippageBps: 500, expectedNative: 10n, allowance: 10n ** 30n,
  });
  assert.equal(r.ok, true, r.why);
  assert.equal(r.call.to, CURVE);
  assert.ok(r.call.data.startsWith('0x5e115e11'));
  assert.equal(r.call.value, 0n);
});

test('⚠️ an RPC outage is never cached as a fact about the token', async () => {
  let head = 0;
  const dead = { async getBlockNumber() { head++; throw new Error('ETIMEDOUT'); }, async getLogs() { return []; }, async getTransaction() { return null; }, async estimateGas() { return 1n; } };
  await ct.ifaceFor(dead, 'robinhood', TOKEN);
  await ct.ifaceFor(dead, 'robinhood', TOKEN);
  assert.equal(head, 2, 'a failed read must be retried, not remembered');
});

test('a successful discovery is remembered — rediscovery is a dozen RPC reads', async () => {
  const chain = chainWithBuys();
  let reads = 0;
  const counting = { ...chain, async getLogs() { reads++; return chain.getLogs(); } };
  await ct.ifaceFor(counting, 'robinhood', TOKEN);
  await ct.ifaceFor(counting, 'robinhood', TOKEN);
  assert.equal(reads, 1);
});

test('⚠️ the price gate must be able to FAIL — it once compared a number with itself', async () => {
  // `sane(built.expected ?? expectedTokens, expectedTokens)` with `expected`
  // never set compared the indexer's own figure against itself, so it passed
  // everything. A gate that cannot fail reads as protection in every review of
  // the code and stops nothing. Both outcomes go through the real path here, so
  // a regression to self-comparison fails this test.
  const chain = chainWithBuys();
  const agree = await ct.prepareBuy(chain, 'robinhood', TOKEN, { wallet: WALLET, valueWei: E17, slippageBps: 0, expectedTokens: 1000n });
  assert.equal(agree.ok, true, agree.why);
  ct._reset();
  const disagree = await ct.prepareBuy(chain, 'robinhood', TOKEN, { wallet: WALLET, valueWei: E17, slippageBps: 0, expectedTokens: 100000n });
  assert.equal(disagree.ok, false);
  assert.equal(disagree.stage, 'sane');
});

test('a buy with no amount-scaled argument is refused — nothing could check the interface', async () => {
  // No minimum-out slot means the pad offers no on-chain bound of its own AND
  // leaves us no curve-side number to compare against the indexer.
  const logs = [xfer(CURVE, WALLET, '0xb1', 1n), xfer(CURVE, WALLET, '0xb2', 2n)];
  const txs = {
    '0xb1': { to: CURVE, from: WALLET, value: E17, data: '0xaabbccdd' + word(TOKEN) },
    '0xb2': { to: CURVE, from: WALLET, value: 2n * E17, data: '0xaabbccdd' + word(TOKEN) },
  };
  const chain = { async getBlockNumber() { return 9000; }, async getLogs() { return logs; }, async getTransaction(h) { return txs[h]; }, async estimateGas() { return 1n; } };
  const r = await ct.prepareBuy(chain, 'robinhood', TOKEN, { wallet: WALLET, valueWei: E17, expectedTokens: 1000n });
  assert.equal(r.ok, false);
  assert.equal(r.stage, 'sane');
});

test('⚠️ the allowance gate runs LAST, so nothing is approved for a sell that then refuses', async () => {
  // It used to run first — above build, above the price check — so a
  // stage:'approve' refusal said nothing about whether the call was buildable.
  // The caller granted an allowance to a log-scored address, re-called, and
  // could still be refused at 'build'. The approval stayed granted for ever,
  // for a sell that never happened.
  const chain = chainWithBuys({ sell: true });
  const r = await ct.prepareSell(chain, 'robinhood', TOKEN, {
    wallet: WALLET, amountRaw: 1000n, slippageBps: 500,
    expectedNative: 1n, allowance: 0n,        // nothing approved
  });
  assert.equal(r.ok, false);
  assert.notEqual(r.stage, 'approve', 'a call that cannot be built must refuse before asking for an allowance');
});

test("⚠️ a discovered spender is approved for THIS SELL and nothing more", async () => {
  // The sell leg's own ratio is 10 native per 1000 tokens, so 2000 tokens is
  // 20 — a price the gate agrees with, which is what lets it reach 'approve'.
  const chain = chainWithBuys({ sell: true });
  const r = await ct.prepareSell(chain, 'robinhood', TOKEN, {
    wallet: WALLET, amountRaw: 2000n, slippageBps: 500, expectedNative: 20n, allowance: 0n,
  });
  assert.equal(r.stage, 'approve', r.why);
  // v4.js already draws this line for a discovered router. An unlimited grant
  // to an address inferred from log scoring is the only unbounded loss in this
  // design, and it outlives the trade.
  assert.equal(r.needsApprove.amountRaw, 2000n);
  assert.equal(r.needsApprove.exact, true);
});

test('a curve that rejects our call is FORGOTTEN, so a redeploy heals itself', async () => {
  // The cache holds the discovered ADDRESS for half an hour. Without eviction,
  // every buy in that window aims at an abandoned contract and there is no path
  // back except waiting — a stuck state indistinguishable from a broken bot.
  const chain = chainWithBuys({ gas: async () => { throw new Error('execution reverted'); } });
  const before = await ct.prepareBuy(chain, 'robinhood', TOKEN, {
    wallet: WALLET, valueWei: 4n * 10n ** 17n, slippageBps: 500, expectedTokens: 4000n,
  });
  assert.equal(before.stage, 'simulate', before.why);
  assert.equal(ct.cached('robinhood', TOKEN), null, 'the rejected interface must not be served again');
});

test('cached() is a cheap yes and never a no', () => {
  // canTradeNow polls on a timer, so it may not pay a dozen RPC reads per
  // probe. The absence of a cached interface is "we have not looked", which the
  // caller must not render as "this token cannot be traded".
  ct._reset();
  assert.equal(ct.cached('robinhood', TOKEN), null);
});

test('⚠️ the window ESCALATES, because "any launchpad" means any PACE', async () => {
  // 5000 blocks is under three hours on a two-second chain. A pad whose tokens
  // trade a few times a day reads as "no trades found" there — a statement
  // about the WINDOW reported as a fact about the TOKEN, and exactly what would
  // have made this feature Pons-shaped: fine on a busy launch, blind on a quiet
  // one. Widening the FIRST look instead would make every lookup pay for the
  // slowest pad, on a call that sits inside the wallet lock.
  const logs = [xfer(CURVE, WALLET, '0xb1'), xfer(CURVE, WALLET, '0xb2')];
  const txs = {
    '0xb1': { to: CURVE, from: WALLET, value: E17, data: '0xaabbccdd' + word(TOKEN) + num(1000n) },
    '0xb2': { to: CURVE, from: WALLET, value: 2n * E17, data: '0xaabbccdd' + word(TOKEN) + num(2000n) },
  };
  const seen = [];
  const chain = {
    async getBlockNumber() { return 500000; },
    async getLogs(f) {
      const span = 500000 - Number(f.fromBlock);
      seen.push(span);
      return span >= 60000 ? logs : [];        // the trades are older than three hours
    },
    async getTransaction(h) { return txs[h]; },
    async estimateGas() { return 210000n; },
  };
  const r = await ct.ifaceFor(chain, 'robinhood', TOKEN);
  assert.equal(r.ok, true, r.why);
  assert.ok(Math.max(...seen) >= 60000, 'it looked further than the cheap first window');
  assert.equal(seen[0], 5000, 'and it still STARTED cheap — every lookup must not pay for the slowest pad');
});

test('…but a dead node is not widened — three tries is three times the same silence', async () => {
  let asked = 0;
  const chain = {
    async getBlockNumber() { return 500000; },
    async getLogs() { asked++; throw new Error('ETIMEDOUT'); },
    async getTransaction() { return null; },
  };
  const r = await ct.ifaceFor(chain, 'robinhood', TOKEN);
  assert.equal(r.ok, false);
  assert.match(r.why, /could not read/);
  // The stepped walk inside one window is expected; what must not happen is the
  // whole window ladder being climbed for an outage.
  assert.ok(asked < 30, `a transport failure escalated the window (${asked} reads)`);
  assert.equal(ct.cached('robinhood', TOKEN), null, 'and an outage is never remembered');
});
