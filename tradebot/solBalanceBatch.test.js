'use strict';
/*
 * solBalanceBatch.test.js — "liat ini skrg trading bot mengapa tidak baca saldo
 * solana": /wallet reporting `Couldn't reach Solana` on all five wallets while
 * every EVM chain answered.
 *
 * Not flakiness — arithmetic. The dashboard reads wallets × chains at once, so
 * five separate `getBalance` calls landed on the public Solana endpoint in the
 * same millisecond, it rate-limited the burst, and web3.js retried past the
 * screen's 2.5s bound. `getSignatureStatuses` was batched for exactly this
 * reason ("five wallets were throttling each other") and `getMultipleAccounts`
 * takes an array too — a lesson applied to one of two siblings.
 *
 * These tests DRIVE the real reader against a stub Connection that COUNTS
 * requests and refuses a burst, because "it makes fewer requests" is a property
 * no source scan can see.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const sol = require('./solana');

// Real base58 pubkeys — PublicKey parses these, so nothing here is measuring a
// rejected address instead of a request.
const ADDRS = [
  'HrX1QdULJEgitbNohZTh36cQTSCAiZSjWVw3DMUCmVSD',
  '11111111111111111111111111111111',
  'So11111111111111111111111111111111111111112',
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'ComputeBudget111111111111111111111111111111',
];

/** A node that serves batches and REFUSES anything past `limit` requests —
 *  the behaviour of the public endpoint this whole fix is about. */
function stubConn({ limit = Infinity, lamports = 1_000_000n, fail = null } = {}) {
  const c = { calls: 0, batched: [] };
  c.getMultipleAccountsInfo = async (keys) => {
    c.calls += 1;
    c.batched.push(keys.length);
    if (fail) throw fail;
    if (c.calls > limit) throw new Error('429 Too Many Requests');
    return keys.map(() => ({ lamports: Number(lamports) }));
  };
  return c;
}

test('every wallet is ONE request, not one per wallet', async () => {
  const c = stubConn();
  const r = await sol.solBalancesX(c, ADDRS);
  assert.equal(r.ok, true);
  assert.equal(c.calls, 1, 'five wallets must cost one request — this is the reported bug');
  assert.deepEqual(c.batched, [5]);
  assert.deepEqual(r.bals, ADDRS.map(() => 1_000_000n));
});

test('…so a node that refuses a BURST still answers the wallet screen', async () => {
  // The reported state: the endpoint serves one request and rate-limits the
  // rest of the wave. Per-wallet reads lose four of five cells; batched, none.
  const c = stubConn({ limit: 1 });
  const r = await sol.solBalancesX(c, ADDRS);
  assert.equal(r.ok, true, 'the batch fits inside the one request the node allows');
  assert.ok(r.bals.every((b) => b === 1_000_000n));

  // The same node, asked the old way, loses everything after the first.
  const c2 = stubConn({ limit: 1 });
  const one = await Promise.all(ADDRS.map((a) => sol.solBalancesX(c2, [a])));
  assert.equal(one.filter((x) => x.ok).length, 1, 'the shape that produced the screenshot');
});

test('a NULL account is a real zero, never an unread cell', async () => {
  // Solana answers null for an address nobody has funded — which is what a
  // fresh wallet is. Reading that as "could not ask" would park every new
  // wallet in the unread column for ever.
  const c = { calls: 0, getMultipleAccountsInfo: async (k) => { c.calls++; return k.map(() => null); } };
  const r = await sol.solBalancesX(c, ADDRS.slice(0, 2));
  assert.equal(r.ok, true);
  assert.deepEqual(r.bals, [0n, 0n]);
});

test('⚠️ the reason travels — a 429, a refusal and a timeout are three sentences', async () => {
  const cases = [
    ['429 Too Many Requests', /rate-limiting/],
    ['403 Forbidden', /refused this server/],
    ['fetch failed', /could not reach/],
  ];
  for (const [msg, re] of cases) {
    const r = await sol.solBalancesX(stubConn({ fail: new Error(msg) }), ADDRS);
    assert.equal(r.ok, false);
    assert.match(r.why, re, `"${msg}" must not collapse into the same shrug`);
  }
});

test('a refusal fails over to the NEXT host — a bucket is per host', async () => {
  // The standing base rule is transport-only, and a 429 is the documented
  // exception: it is a fact about the bucket on THAT host.
  const dead = stubConn({ fail: new Error('429 Too Many Requests') });
  const live = stubConn();
  const r = await sol.solBalancesX(dead, ADDRS, { conns: [dead, live] });
  assert.equal(r.ok, true, 'the second host was never asked');
  assert.equal(live.calls, 1);
});

test('…and the reason reported is the FIRST host\'s, not the last', async () => {
  const a = stubConn({ fail: new Error('429 Too Many Requests') });
  const b = stubConn({ fail: new Error('fetch failed') });
  const r = await sol.solBalancesX(a, ADDRS, { conns: [a, b] });
  assert.equal(r.ok, false);
  assert.match(r.why, /rate-limiting/, 'the later host\'s dead socket must not bury the rate limit that started it');
});

test('SOLANA_RPC is a LIST, and blank still resolves to the shipped default', () => {
  assert.deepEqual(sol.rpcUrls('https://a.example , https://b.example'), ['https://a.example', 'https://b.example']);
  assert.equal(sol.rpcUrls('https://one.example').length, 1);
  assert.equal(sol.rpcUrls('  ').length, 1, 'a blank override may not leave us with no host at all');
  assert.equal(sol.rpcUrls('').length, 1);
});

test('the single-address read still answers null on failure (its old contract)', async () => {
  assert.equal(await sol.solBalanceOrNull(stubConn({ fail: new Error('boom') }), ADDRS[0]), null);
  assert.equal(await sol.solBalanceOrNull(stubConn(), ADDRS[0]), 1_000_000n);
});

test('an unparseable address is ITS OWN answer, never the host\'s', async () => {
  const c = stubConn();
  const r = await sol.solBalancesX(c, [ADDRS[0], 'not-a-pubkey']);
  assert.equal(r.ok, true, 'one bad address must not mark the whole column unread');
  assert.equal(r.bals[0], 1_000_000n);
  assert.equal(r.bals[1], null);
  assert.deepEqual(c.batched, [1], 'and it is not sent to the node');
});

// ── the wiring, because a batch nothing calls is a batch that never helps ────

const src = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('⚠️ the screens read a COLUMN — a per-wallet read is the defect', () => {
  const t = src('telegram.js');
  assert.match(t, /async function readNativeColumn\(/);
  assert.match(t, /core\.nativeBalances\(c\.key, addrs\)/, 'and through core, not by reaching into solana.js');
  // The dashboard matrix and the sweep picker are the two screens that list
  // wallets; either one asking per wallet puts the burst straight back.
  assert.match(t, /readNativeColumn\(list, c\)/, 'the /wallet matrix');
  assert.match(t, /readNativeColumn\(list, ch\)/, 'the sweep picker');
  const wave = t.slice(t.indexOf('const colsP'), t.indexOf('const tokenBagsP'));
  assert.doesNotMatch(wave, /readNative\(w, c\)/, 'the per-cell read must not come back');
});

test('core.nativeBalances batches on svm and keeps EVM per-address', () => {
  const c = src('core.js');
  const fn = c.slice(c.indexOf('async function nativeBalances('), c.indexOf('\n}', c.indexOf('async function nativeBalances(')) + 2);
  assert.match(fn, /solana\.solBalancesX\(/, 'one request on Solana');
  assert.match(fn, /conns: solana\.readConnections\(/, 'with the host list');
  assert.match(fn, /p\.getBalance\(a\)/, 'EVM is unchanged — those endpoints are not the ones refusing us');
});

test('⚠️ the wallet screen SAYS why a chain went unread', () => {
  const t = src('telegram.js');
  assert.match(t, /chainWhy\[c\.key\] = cols\[ci\]\.why/, 'the reason is captured per chain');
  const block = t.slice(t.indexOf("if (unreadChains.length)"), t.indexOf("const evmChain"));
  assert.match(block, /chainWhy\[/, "…and printed — 'Couldn't reach Solana' with no reason is why this took a screenshot to diagnose");
  assert.match(block, /new Set\(/, 'de-duplicated: five chains behind one dead host is one sentence');
});

test("⚠️ the READ connections switch web3.js's 429 retry OFF", () => {
  // Measured in node_modules, not assumed: web3.js answers a 429 by retrying
  // five times with 500ms → 1s → 2s → 4s of backoff — 7.5 SECONDS before it
  // returns an error. The wallet screen waits 2500ms, so one 429 could never
  // finish inside the window, and the retries kept hitting the endpoint long
  // after the screen gave up. The SIGNING connection keeps the retry.
  const c = src('solana.js');
  const rc = c.slice(c.indexOf('function readConnections('), c.indexOf('async function solBalance('));
  assert.match(rc, /disableRetryOnRateLimit: true/);
  const gc = c.slice(c.indexOf('function getConnection('), c.indexOf('function rpcUrls('));
  assert.doesNotMatch(gc, /disableRetryOnRateLimit/, 'a confirmation that waits out a 429 is doing its job');
  // ⚠️ …AND THEY MUST BE SEPARATE OBJECTS, which no source scan can see: alias
  // the read cache to the signing one and `disableRetryOnRateLimit` is decided
  // by whichever call happened to construct the url first. Driven.
  const url = 'https://sol-read-vs-sign.example';
  assert.notStrictEqual(sol.readConnections(url)[0], sol.getConnection(url),
    'the read connection IS the signing connection — the retry-off is a coin toss');
  assert.strictEqual(sol.readConnections(url)[0], sol.readConnections(url)[0], 'and still cached');
});

test('every Solana read goes through ONE door in core', () => {
  const c = src('core.js');
  const eb = c.slice(c.indexOf('async function ethBalanceOrNull('));
  assert.match(eb.slice(0, eb.indexOf('\n}') + 2), /nativeBalances\(chainKey, \[addr\]\)/);
  const br = c.slice(c.indexOf('async function _balanceResilient('), c.indexOf('async function walletFunds('));
  assert.match(br, /nativeBalances\(chainKey, \[addr\]\)/, 'the removal survey too — two doors is how two screens disagree');
});
