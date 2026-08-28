'use strict';
/*
 * THE LEARNED-SHAPE TRANSFER — a fresh launch, bought by its FIRST buyer.
 *
 * The live report (2026-08-28, "ini token kan belum bonding"): a Pons launch at
 * 0% progress with one dust buy, refused for ever by a route that reads
 * interfaces off a token's own trade history — a fresh token HAS none, and the
 * first buy is the entire point of a launch snipe. The transfer's safety
 * argument lives in buildFromShape's header: byte-identical curve code carries
 * the sibling's sane()-checked meaning, simulate answers the storage question,
 * and OUR strong-price floor rides on-chain. These tests pin each half, and
 * the refusals that keep it honest.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fss = require('node:fs');
process.env.DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), 'dexvra-curveshape-'));

const { TRANSFER_TOPIC } = require('./curveIface.js');
const { buildFromShape } = require('./curveRoute.js');
let ct = require('./curveTrade.js');

const SIB = '0x3f8c5ac4c9b9391c99f4796e56228852a6796ddf';      // the taught sibling
const FRESH = '0x1f94e478675d37f15704a48756b5fdf969e39845';    // the fresh launch (the reported token)
const CURVE = '0xc0000000000000000000000000000000000000c0';    // sibling's curve
const NEWCURVE = '0xc1000000000000000000000000000000000000c1'; // fresh token's curve
const WALLET = '0xa0000000000000000000000000000000000000a0';
const CODE = '0x60806040deadbeef' + 'ab'.repeat(64);           // the pad's curve bytecode, shared
const E17 = 10n ** 17n;
const E18 = 10n ** 18n;

const word = (a) => '0'.repeat(24) + a.slice(2);
const topic = (a) => '0x' + '0'.repeat(24) + a.slice(2);
const num = (n) => BigInt(n).toString(16).padStart(64, '0');
const xfer = (from, to, hash) => ({ topics: [TRANSFER_TOPIC, topic(from), topic(to)], data: '0x' + num(0n), transactionHash: hash });

/** The sibling: two buys of different sizes — a full, teachable history. */
function sibChain() {
  const logs = [xfer(CURVE, WALLET, '0xb1'), xfer(CURVE, WALLET, '0xb2')];
  const txs = {
    '0xb1': { to: CURVE, from: WALLET, value: E17, data: '0xaabbccdd' + word(SIB) + num(1000n * E18) },
    '0xb2': { to: CURVE, from: WALLET, value: 2n * E17, data: '0xaabbccdd' + word(SIB) + num(2000n * E18) },
  };
  return {
    async getBlockNumber() { return 9000; },
    async getLogs() { return logs; },
    async getTransaction(h) { return txs[h] || null; },
    async getCode(a) { return [CURVE, NEWCURVE].includes(String(a).toLowerCase()) ? CODE : '0x'; },
    async call() { return '0x'; },
    async estimateGas() { return 210000n; },
  };
}

/** The fresh launch: NOTHING to read — every getLogs is empty. */
function freshChain({ code = CODE } = {}) {
  return {
    async getBlockNumber() { return 9000; },
    async getLogs() { return []; },
    async getTransaction() { return null; },
    async getCode(a) { return String(a).toLowerCase() === NEWCURVE ? code : '0x'; },
    async call() { return '0x'; },
    async estimateGas() { return 210000n; },
  };
}

test.beforeEach(() => { ct._reset(); ct._resetShapes(); });

test('⚠️ a discovered sibling TEACHES the pad, and a fresh launch with zero history gets the route', async () => {
  const sib = await ct.ifaceFor(sibChain(), 'robinhood', SIB);
  assert.equal(sib.ok, true, sib.why);

  const r = await ct.ifaceFor(freshChain(), 'robinhood', FRESH, { poolHint: async () => NEWCURVE });
  assert.equal(r.ok, true, `the transfer did not fire: ${r.why}`);
  assert.equal(r.transferred, true);
  assert.equal(r.curve, NEWCURVE, 'the route aims at the FRESH token\'s own curve');
  assert.ok(r.buy && r.buy.shape, 'the buy leg carries the learned shape');
  assert.equal(String(r.learnedFrom.curve).toLowerCase(), CURVE);
  assert.ok(ct.cached('robinhood', FRESH), 'a transferred route caches like a read one — canTradeNow lights up');
});

test('⚠️ NOTHING taught the pad — the bot teaches ITSELF from a sibling, with no manual step', async () => {
  // The four-times-reported shape: telling the operator to go and paste a
  // traded token first is "apt-get install is not a fix, it is a request".
  // The indexer lists the pad's other pools; the bot reads one of them and
  // teaches itself. Nothing is learned before the bytecode matches.
  const sibLogs = [xfer(CURVE, WALLET, '0xb1'), xfer(CURVE, WALLET, '0xb2')];
  const sibTxs = {
    '0xb1': { to: CURVE, from: WALLET, value: E17, data: '0xaabbccdd' + word(SIB) + num(1000n * E18) },
    '0xb2': { to: CURVE, from: WALLET, value: 2n * E17, data: '0xaabbccdd' + word(SIB) + num(2000n * E18) },
  };
  const chain = {
    async getBlockNumber() { return 9000; },
    // OUR token has no history; the sibling does.
    async getLogs(f) { return String((f && f.address) || '').toLowerCase() === SIB ? sibLogs : []; },
    async getTransaction(h) { return sibTxs[h] || null; },
    async getCode(a) { return [CURVE, NEWCURVE].includes(String(a).toLowerCase()) ? CODE : '0x'; },
    async call() { return '0x'; },
    async estimateGas() { return 210000n; },
  };
  let askedSiblings = 0;
  const r = await ct.ifaceFor(chain, 'robinhood', FRESH, {
    poolHint: async () => NEWCURVE,
    siblings: async () => { askedSiblings++; return [{ token: SIB, pool: CURVE }]; },
  });
  assert.equal(r.ok, true, `the pad was never taught: ${r.why}`);
  assert.equal(r.transferred, true);
  assert.equal(askedSiblings, 1, 'the sibling list is asked once, not per window');
  assert.equal(String(r.learnedFrom.token).toLowerCase(), SIB, 'and it says WHICH token taught it');
});

test('⚠️ a sibling from a DIFFERENT pad teaches nothing — the bytecode gate holds on the teaching path too', async () => {
  const OTHER = '0xc2000000000000000000000000000000000000c2';   // another pad's curve
  const otherLogs = [xfer(OTHER, WALLET, '0xo1'), xfer(OTHER, WALLET, '0xo2')];
  const otherTxs = {
    '0xo1': { to: OTHER, from: WALLET, value: E17, data: '0x99887766' + word(SIB) + num(1000n * E18) },
    '0xo2': { to: OTHER, from: WALLET, value: 2n * E17, data: '0x99887766' + word(SIB) + num(2000n * E18) },
  };
  const chain = {
    async getBlockNumber() { return 9000; },
    async getLogs(f) { return String((f && f.address) || '').toLowerCase() === SIB ? otherLogs : []; },
    async getTransaction(h) { return otherTxs[h] || null; },
    // The sibling's curve carries DIFFERENT code from ours.
    async getCode(a) { return String(a).toLowerCase() === OTHER ? '0x60806040' + 'ee'.repeat(64) : (String(a).toLowerCase() === NEWCURVE ? CODE : '0x'); },
    async call() { return '0x'; },
    async estimateGas() { return 210000n; },
  };
  const r = await ct.ifaceFor(chain, 'robinhood', FRESH, {
    poolHint: async () => NEWCURVE,
    siblings: async () => [{ token: SIB, pool: OTHER }],
  });
  assert.equal(r.ok, false, "a foreign pad's shape must never cross onto our curve");
  assert.match(r.why, /no trades found/);
});

test('⚠️ DIFFERENT bytecode refuses the transfer — identity is the whole safety argument', async () => {
  await ct.ifaceFor(sibChain(), 'robinhood', SIB);
  const r = await ct.ifaceFor(freshChain({ code: '0x60806040' + 'ff'.repeat(64) }), 'robinhood', FRESH, { poolHint: async () => NEWCURVE });
  assert.equal(r.ok, false, 'a shape may never cross onto code nobody taught');
  assert.match(r.why, /no trades found/);
});

test('prepareBuy on a transferred route builds OUR call: our token, our floor, sane() replaced as documented', async () => {
  await ct.ifaceFor(sibChain(), 'robinhood', SIB);
  const chain = freshChain();
  await ct.ifaceFor(chain, 'robinhood', FRESH, { poolHint: async () => NEWCURVE });
  const floor = 1000n * E18;
  const prep = await ct.prepareBuy(chain, 'robinhood', FRESH, {
    wallet: WALLET, valueWei: E17, slippageBps: 500,
    expectedTokens: floor, tolPct: 35, minOutRaw: floor,   // the strong price core supplies (indexer cap ÷ supply)
  });
  assert.equal(prep.ok, true, prep.why);
  assert.equal(prep.transferred, true);
  assert.equal(prep.boundedByIndependentPrice, true, 'the on-chain floor is ours');
  assert.equal(prep.call.to, NEWCURVE);
  assert.equal(prep.call.value, E17);
  const body = prep.call.data.slice(10);
  assert.equal(prep.call.data.slice(0, 10), '0xaabbccdd', 'the sibling\'s selector');
  assert.equal(body.slice(0, 64), word(FRESH), 'the token slot carries the FRESH token, never the sibling');
  assert.equal(BigInt('0x' + body.slice(64, 128)), (floor * 9500n) / 10000n, 'the floor is OUR strong price cut by OUR slippage');
});

test('⚠️ no strong floor, no transferred trade — the mandatory-floor refusal', async () => {
  await ct.ifaceFor(sibChain(), 'robinhood', SIB);
  const chain = freshChain();
  await ct.ifaceFor(chain, 'robinhood', FRESH, { poolHint: async () => NEWCURVE });
  const prep = await ct.prepareBuy(chain, 'robinhood', FRESH, {
    wallet: WALLET, valueWei: E17, slippageBps: 500, expectedTokens: 0n, tolPct: 35,   // no minOutRaw — the weak-price case
  });
  assert.equal(prep.ok, false);
  assert.match(prep.why, /independent minimum-out from a strong price/);
});

test('⚠️ ONE trade is not two — the classify-short case falls back to the learned shape', async () => {
  await ct.ifaceFor(sibChain(), 'robinhood', SIB);
  // The fresh token has ONE observed buy — enough to decode, not enough to
  // classify ("only 1 sample"). Same selector, same curve code.
  const logs = [xfer(NEWCURVE, WALLET, '0xf1')];
  const txs = { '0xf1': { to: NEWCURVE, from: WALLET, value: E17, data: '0xaabbccdd' + word(FRESH) + num(500n * E18) } };
  const chain = {
    async getBlockNumber() { return 9000; },
    async getLogs() { return logs; },
    async getTransaction(h) { return txs[h] || null; },
    async getCode(a) { return [CURVE, NEWCURVE].includes(String(a).toLowerCase()) ? CODE : '0x'; },
    async call() { return '0x'; },
    async estimateGas() { return 210000n; },
  };
  const floor = 900n * E18;
  const prep = await ct.prepareBuy(chain, 'robinhood', FRESH, {
    wallet: WALLET, valueWei: E17, slippageBps: 500, expectedTokens: floor, tolPct: 35, minOutRaw: floor,
  });
  assert.equal(prep.ok, true, prep.why);
  assert.equal(prep.transferred, true, 'built from the learned shape, under the same code-identity proof');
});

test('the shapes SURVIVE a restart — one taught sibling, ever, is enough', async () => {
  await ct.ifaceFor(sibChain(), 'robinhood', SIB);
  for (const m of ['./curveTrade.js']) delete require.cache[require.resolve(m)];
  const ct2 = require('./curveTrade.js');
  const hit = await ct2._shapeFor(freshChain(), 'robinhood', NEWCURVE);
  assert.ok(hit && hit.buy && hit.buy.selector === '0xaabbccdd', 'the learned shape came back off disk');
  ct = require('./curveTrade.js');   // keep later tests on the fresh module
});

test('a learned shape carrying a stranger\'s constant address refuses at build', () => {
  const r = buildFromShape(
    { selector: '0xaabbccdd', native: true, slots: [{ i: 0, role: 'constant', value: word('0xf00d000000000000000000000000000000000f00') }, { i: 1, role: 'scales' }] },
    { token: FRESH, wallet: WALLET, valueWei: E17, minOutRaw: 1000n, slippageBps: 500 },
  );
  assert.equal(r.ok, false);
  assert.match(r.why, /constant address/);
});

test('a shape with NO minimum-out slot refuses — gas alone is no gate', () => {
  const r = buildFromShape(
    { selector: '0xaabbccdd', native: true, slots: [{ i: 0, role: 'token' }] },
    { token: FRESH, wallet: WALLET, valueWei: E17, minOutRaw: 1000n, slippageBps: 500 },
  );
  assert.equal(r.ok, false);
  assert.match(r.why, /no minimum-out slot/);
});
