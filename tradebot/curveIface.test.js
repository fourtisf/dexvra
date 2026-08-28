'use strict';
/*
 * The curve decoder, driven against a stub chain.
 *
 * Every case is a way the inference can go wrong on somebody's money, and each
 * one is the reason the corresponding line exists. Driven rather than scanned
 * because a source guard cannot tell a correct inference from a plausible one.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { decodeCurveIface, describeIface, TRANSFER_TOPIC, _wordAddr } = require('./curveIface.js');

const TOKEN = '0x3f8c5ac4c9b9391c99f4796e56228852a6796ddf';
const CURVE = '0xc0000000000000000000000000000000000000c0';
const ROUTER = '0xd0000000000000000000000000000000000000d0';
const WALLET = '0xa0000000000000000000000000000000000000a0';

const word = (a) => '0'.repeat(24) + a.slice(2);
const topic = (a) => '0x' + '0'.repeat(24) + a.slice(2);
const num = (n) => BigInt(n).toString(16).padStart(64, '0');

/** A chain that answers from a script, and counts what it was asked. */
function stub({ logs = [], txs = {} } = {}) {
  const calls = { getLogs: 0, getTransaction: 0 };
  return {
    calls,
    async getLogs() { calls.getLogs++; return logs; },
    async getTransaction(h) { calls.getTransaction++; return txs[h] || null; },
  };
}
const xfer = (from, to, hash) => ({ topics: [TRANSFER_TOPIC, topic(from), topic(to)], transactionHash: hash });

test('the buy is read off a real trade: contract, selector, args, and the token slot', async () => {
  const chain = stub({
    logs: [xfer(CURVE, WALLET, '0xh1')],                       // curve paid out → a BUY
    txs: { '0xh1': { to: CURVE, value: 10n ** 17n, data: '0xaabbccdd' + word(TOKEN) + num(500) } },
  });
  const r = await decodeCurveIface(chain, TOKEN, { head: 9000 });
  assert.equal(r.ok, true, r.why);
  assert.equal(r.curve, CURVE);
  assert.equal(r.buy.selector, '0xaabbccdd');
  assert.equal(r.buy.native, true);
  assert.equal(r.buy.args[0].isToken, true, 'the token slot is identified, not assumed');
  assert.equal(r.buy.args[1].num, 500n);
});

test('⚠️ the CURVE is the contract the token moves to and from — not whatever was called', async () => {
  // A router in front of the curve is called too, and it appears in the trace
  // exactly like the curve does. Only the curve is on the other end of the
  // token's own Transfer, which is the one property that separates them —
  // and picking the router would send every buy to the wrong contract.
  const chain = stub({
    logs: [xfer(CURVE, WALLET, '0xh1'), xfer(CURVE, WALLET, '0xh2')],
    txs: {
      '0xh1': { to: ROUTER, value: 10n ** 17n, data: '0x11111111' + word(TOKEN) },
      '0xh2': { to: CURVE, value: 10n ** 17n, data: '0x22222222' + word(TOKEN) },
    },
  });
  const r = await decodeCurveIface(chain, TOKEN, { head: 9000 });
  assert.equal(r.curve, CURVE, 'the router must not be mistaken for the curve');
  assert.equal(r.buy.selector, '0x22222222');
});

test('⚠️ direction comes from the Transfer, not from msg.value', async () => {
  // A pad whose buy is priced in a quote token sends no native value, so a
  // classifier reading `value` alone would call every buy a sell — and then
  // build a "buy" out of the sell selector.
  const chain = stub({
    logs: [xfer(CURVE, WALLET, '0xbuy'), xfer(WALLET, CURVE, '0xsell')],
    txs: {
      '0xbuy': { to: CURVE, value: 0n, data: '0xb0b0b0b0' + word(TOKEN) },
      '0xsell': { to: CURVE, value: 0n, data: '0x5e115e11' + word(TOKEN) },
    },
  });
  const r = await decodeCurveIface(chain, TOKEN, { head: 9000 });
  assert.equal(r.ok, true, r.why);
  assert.equal(r.buy.selector, '0xb0b0b0b0', 'the payout leg is the buy');
  assert.equal(r.buy.native, false, 'and it is correctly marked as not payable');
  assert.equal(r.sell.selector, '0x5e115e11');
});

test('the sell is never the same selector as the buy', async () => {
  const chain = stub({
    logs: [xfer(CURVE, WALLET, '0xh1'), xfer(WALLET, CURVE, '0xh2')],
    txs: {
      '0xh1': { to: CURVE, value: 5n, data: '0xdeadbeef' + word(TOKEN) },
      '0xh2': { to: CURVE, value: 0n, data: '0xdeadbeef' + word(TOKEN) },
    },
  });
  const r = await decodeCurveIface(chain, TOKEN, { head: 9000 });
  assert.equal(r.buy.selector, '0xdeadbeef');
  assert.equal(r.sell, null, 'one selector cannot be both legs');
});

test('the largest trade of a shape wins, so one dust buy does not define the route', async () => {
  const chain = stub({
    logs: [xfer(CURVE, WALLET, '0xsmall'), xfer(CURVE, WALLET, '0xbig')],
    txs: {
      '0xsmall': { to: CURVE, value: 1n, data: '0xaaaaaaaa' + word(TOKEN) + num(1) },
      '0xbig': { to: CURVE, value: 10n ** 18n, data: '0xaaaaaaaa' + word(TOKEN) + num(999) },
    },
  });
  const r = await decodeCurveIface(chain, TOKEN, { head: 9000 });
  assert.equal(r.buy.value, 10n ** 18n);
  assert.equal(r.buy.args[1].num, 999n);
  assert.equal(r.buy.seen, 2, 'both sightings still count towards confidence');
});

test('⚠️ "could not look" and "nothing to look at" never collapse — and neither is a verdict on the token', async () => {
  const dead = { async getLogs() { throw new Error('ETIMEDOUT'); }, async getTransaction() { return null; } };
  const a = await decodeCurveIface(dead, TOKEN, { head: 1 });
  assert.equal(a.ok, false);
  assert.match(a.why, /could not read/);

  const quiet = await decodeCurveIface(stub({ logs: [] }), TOKEN, { head: 1 });
  assert.equal(quiet.ok, false);
  assert.match(quiet.why, /nobody has traded/);
  assert.notEqual(a.why, quiet.why, 'an outage must not read as an untraded token');
});

test('a token that only ever moved INTO the curve reports no buy, and says what would fix it', async () => {
  const chain = stub({
    logs: [xfer(WALLET, CURVE, '0xh1')],
    txs: { '0xh1': { to: CURVE, value: 0n, data: '0x5e115e11' + word(TOKEN) } },
  });
  const r = await decodeCurveIface(chain, TOKEN, { head: 9000 });
  assert.equal(r.ok, false);
  assert.match(r.why, /no BUY/);
  assert.match(r.why, /make one small buy/i);
});

test('plain wallet-to-wallet transfers name no curve at all', async () => {
  const chain = stub({
    logs: [xfer(WALLET, ROUTER, '0xh1')],
    txs: { '0xh1': { to: ROUTER, value: 0n, data: '0xa9059cbb' + word(WALLET) } },
  });
  const r = await decodeCurveIface(chain, TOKEN, { head: 9000 });
  // ROUTER is on the receiving end of the Transfer AND is what was called, so
  // it does score — but it is a sell-shaped leg with no buy, which is honest.
  assert.equal(r.ok, false);
  assert.ok(/no BUY|never to or from/.test(r.why), r.why);
});

test('a bad token address is refused before any request is made', async () => {
  const chain = stub();
  const r = await decodeCurveIface(chain, 'not-an-address', { head: 1 });
  assert.equal(r.ok, false);
  assert.equal(chain.calls.getLogs, 0, 'no network call for input we can reject outright');
});

test('the transaction reads are BOUNDED — a busy token must not cost hundreds of round trips', async () => {
  const logs = Array.from({ length: 200 }, (_, i) => xfer(CURVE, WALLET, '0xh' + i));
  const txs = {};
  for (let i = 0; i < 200; i++) txs['0xh' + i] = { to: CURVE, value: 1n, data: '0xaaaaaaaa' + word(TOKEN) };
  const chain = stub({ logs, txs });
  await decodeCurveIface(chain, TOKEN, { head: 9000, maxTx: 12 });
  assert.ok(chain.calls.getTransaction <= 12, `read ${chain.calls.getTransaction} transactions`);
});

test('describeIface never claims a route, only an observation', () => {
  const line = describeIface({ ok: true, curve: CURVE, buy: { selector: '0xaabbccdd', native: true, args: [{ isToken: true }, { num: 1n }] }, sell: null });
  assert.match(line, /curve 0xc000/);
  assert.match(line, /buy 0xaabbccdd \(payable\)/);
  assert.match(line, /args\[TOKEN,num\]/);
  assert.match(line, /sell not seen/);
  assert.doesNotMatch(line, /routable|can trade|ready/i);
});

test('an ABI address word is only an address when its top 12 bytes are zero', () => {
  assert.equal(_wordAddr('0'.repeat(24) + 'a'.repeat(40)), '0x' + 'a'.repeat(40));
  assert.equal(_wordAddr('1' + '0'.repeat(23) + 'a'.repeat(40)), null, 'a big number is not an address');
  assert.equal(_wordAddr('0'.repeat(64)), null, 'the zero address is not a participant');
});
