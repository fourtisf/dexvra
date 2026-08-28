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

test('⚠️ a quote-token curve is refused rather than sent with a value it never asked for', async () => {
  // Its buy carries no native value, so sending ours would simply lose it to a
  // function that takes payment in an ERC-20 we have not approved.
  const logs = [xfer(CURVE, WALLET, '0xb1'), xfer(CURVE, WALLET, '0xb2')];
  const txs = {
    '0xb1': { to: CURVE, from: WALLET, value: 0n, data: '0xaabbccdd' + word(TOKEN) + num(1000n) },
    '0xb2': { to: CURVE, from: WALLET, value: 0n, data: '0xaabbccdd' + word(TOKEN) + num(1000n) },
  };
  const chain = { async getBlockNumber() { return 9000; }, async getLogs() { return logs; }, async getTransaction(h) { return txs[h]; }, async estimateGas() { return 1n; } };
  const r = await ct.prepareBuy(chain, 'robinhood', TOKEN, { wallet: WALLET, valueWei: E17, expectedTokens: 1000n });
  assert.equal(r.ok, false);
  assert.match(r.why, /approval step/);
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
