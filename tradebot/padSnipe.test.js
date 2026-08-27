'use strict';
/*
 * padSnipe.test.js — the launchpad snipe loop and the launch retry ring, offline.
 *
 * The defect this file pins: the snipe could see a launch and still never buy
 * it, in two independent ways.
 *
 *   1. Discovery was one launchpad per chain. A token born on any pad the event
 *      scans do not cover was invisible until it migrated — hours after the
 *      window anybody snipes in. padSnipeCycle closes that with the registry's
 *      feeds, for every chain any pad covers.
 *   2. A launch seen BEFORE its market opened was dropped for ever. The buy
 *      failed with "no route", the cursor had already advanced, the seen-set had
 *      already marked it — and a comment claimed it would be "retried while it's
 *      fresh" over code that could not. That is precisely the dev-wallet snipe's
 *      normal case: it sees the mint before the dev opens the pool, so the
 *      feature "worked" and never bought anything. The retry ring is the fix,
 *      and the tests here drive a launch through TOO-EARLY → RING → FILLED.
 *
 * Everything runs against stubbed core/safety/launchpads — no network, no RPC.
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

process.env.LAUNCH_RETRY_MS = process.env.LAUNCH_RETRY_MS || '180000';
// A small per-cycle budget so the overflow paths are exercisable with a
// handful of launches (the constant is read once, at require time).
process.env.DEX_SNIPE_MAX_TOKENS = '3';

// ---- stubs injected before watchers.js requires them ----
const USERS = [];
let BUY = async () => ({ sym: 'PAD', gotTokens: 100, spentEth: 0.05, native: 'ETH', hash: '0xhash', gotRaw: '100' });
let CAN_TRADE = async () => true;
let BAL_OR_NULL = async () => 10n ** 20n;   // plenty; a test sets null for "could not read"
let SAFETY = null;   // set to an async fn to make the safety gate real for one test
let FEEDS = {};   // chainKey -> { byPad: { key: {ok, why, items} }, ok, why }
const buys = [];
const notes = [];

const coreStub = {
  CFG: { gasBufferEth: '0.001', solGasBuffer: '0.01' },
  chains: {
    isSvm: (k) => k === 'solana',
    isEnabled: () => true,
    enabledChains: () => [{ key: 'robinhood' }, { key: 'bsc' }, { key: 'solana' }],
  },
  chainOf: (k) => ({ key: k, name: k, emoji: '◆', native: k === 'solana' ? 'SOL' : 'ETH', explorer: 'https://x' }),
  allUsers: () => USERS,
  walletList: (u) => u.wallets || [],
  activeWallet: (u) => (u.wallets || [])[0] || null,
  activeAddress: () => '0xME',
  walletAddress: () => 'SoMeAddr',
  ethBalance: async () => 10n ** 20n,   // plenty
  ethBalanceOrNull: async (...a) => BAL_OR_NULL(...a),   // what _canAfford actually reads
  gasBufferWei: () => 10n ** 15n,
  saveStoreNow: () => {},
  saveStore: () => {},
  copyHoldingAdd: () => {},
  canTradeNow: async (ca, chain) => CAN_TRADE(ca, chain),
  buy: async (chatId, token, amt, chain, wid, opts) => { const r = await BUY(chatId, token, amt, chain, wid, opts); buys.push({ chatId, token, amt, chain, wid }); return r; },
};
const safetyStub = { supported: () => !!SAFETY, tokenSecurity: async (...a) => SAFETY(...a), verdict: () => ({ level: 'ok' }) };
const solanaStub = { isSolAddress: () => true, WSOL_MINT: 'W', solToLamports: (n) => BigInt(Math.round(Number(n) * 1e9)), pumpfunNewX: async () => ({ ok: true, coins: [] }) };
const lpStub = {
  probes: () => [],   // upstreams.js reads the probe list at require time
  enabled: () => [],
  covers: (k) => k !== 'nowhere',
  padsFor: (chain) => {
    // Two pads with feeds on Robinhood (pons + a second), one on bsc, and on
    // Solana both pump.fun (which the loop must SKIP — it has its own poller)
    // and a second pad it must poll.
    if (chain === 'robinhood') return [{ key: 'pons', feedPath: '/f' }, { key: 'other', feedPath: '/f' }];
    if (chain === 'bsc') return [{ key: 'fourmeme', feedPath: '/f' }];
    if (chain === 'solana') return [{ key: 'pumpfun', feedPath: '/f' }, { key: 'letsbonk', feedPath: '/f' }];
    return [];
  },
  newLaunches: async (chain, n, opts) => {
    const r = FEEDS[chain] || { byPad: {}, ok: false, why: 'no stub feed' };
    // The loop must ask ONLY for the pads it filtered to — echo that back so a
    // test can assert pump.fun was never requested.
    r._asked = (opts && opts.only) || [];
    return r;
  },
};
const dir = __dirname;
const inject = (rel, exp) => { const p = require.resolve(path.join(dir, rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports: exp }; };
inject('core', coreStub);
inject('safety', safetyStub);
inject('goplus', {});
inject('solana', solanaStub);
inject('launchpads', lpStub);

const w = require(path.join(dir, 'watchers'));
w.setNotifier((chatId, text, kb, kind) => notes.push({ chatId, text, kind }));
const T = w._test;

let _uid = 0;   // NOT USERS.length: two users built before either is pushed would share an id
const armUser = (chain, amt = 0.05) => ({ chatId: 100 + _uid++, snipe: { chains: { [chain]: true }, ethAmount: amt }, wallets: [{ id: 'w1', address: '0xME' }] });
const devUser = (chain, dev) => ({ chatId: 100 + _uid++, wallets: [{ id: 'w1', address: '0xME' }], copy: { on: true, targets: [{ id: 'cp' + _uid, address: dev, chain, mode: 'launches', buyEth: '0.02', maxEth: '1', spentEth: 0, bought: {} }] } });

function reset() {
  USERS.length = 0; buys.length = 0; notes.length = 0;
  BUY = async () => ({ sym: 'PAD', gotTokens: 100, spentEth: 0.05, native: 'ETH', hash: '0xhash', gotRaw: '100' });
  CAN_TRADE = async () => true;
  BAL_OR_NULL = async () => 10n ** 20n;
  SAFETY = null;
  FEEDS = {};
  T._launchRetry.clear();
  T._padCursors.clear();
  // The feed-bench map and the per-pad stats persist across tests by design
  // (they are process state in the bot) — and a bench or a fail-count left
  // behind by the backoff test reads as "the pad loop is broken" in every
  // later test. Stated here, not inherited.
  T._padFeedFail.clear();
  for (const k of Object.keys(T._padSnipeStats.pads)) delete T._padSnipeStats.pads[k];
  T._padSnipeStats.lastErr = null; T._padSnipeStats.lastErrAt = null;
}
const feedOk = (items) => ({ ok: true, why: '', items });
const item = (addr, over) => Object.assign({ address: addr, symbol: 'PAD', name: 'Pad Token', creator: '', createdAt: Date.now(), graduated: false, pad: 'pons' }, over);

// ── discovery ────────────────────────────────────────────────────────────────

test('a launch on a NON-default launchpad is seen and bought', async () => {
  reset();
  USERS.push(armUser('robinhood'));
  const t0 = Date.now() - 5000;
  // First look seeds only — the auto-raid cursor's rule.
  FEEDS.robinhood = { ok: true, byPad: { pons: feedOk([item('0xAAA1', { createdAt: t0 })]), other: feedOk([]) } };
  await T.padSnipeCycle();
  assert.equal(buys.length, 0, 'the first look must seed, not snipe');
  // Second look: a NEW launch past the cursor fires.
  FEEDS.robinhood = { ok: true, byPad: { pons: feedOk([item('0xAAA2', { createdAt: t0 + 1000 }), item('0xAAA1', { createdAt: t0 })]), other: feedOk([]) } };
  await T.padSnipeCycle();
  assert.equal(buys.length, 1, 'the new launch was not bought');
  assert.equal(buys[0].token, '0xAAA2');
  assert.equal(buys[0].chain, 'robinhood');
  assert.match(notes[0].text, /Auto-Snipe bought/);
});

test('pump.fun is NEVER polled from the pad loop — it has its own poller and cursor', async () => {
  reset();
  USERS.push(armUser('solana'));
  FEEDS.solana = { ok: true, byPad: { letsbonk: feedOk([]) } };
  await T.padSnipeCycle();
  assert.ok(FEEDS.solana._asked.includes('letsbonk'));
  assert.ok(!FEEDS.solana._asked.includes('pumpfun'), 'two pollers, two cursors, one feed — the exact "one repo, two answers" defect');
});

test('nobody armed and nobody following → no feed request at all', async () => {
  reset();
  let asked = 0;
  FEEDS.robinhood = { ok: true, byPad: { pons: feedOk([]) } };
  const realNL = lpStub.newLaunches;
  lpStub.newLaunches = async (...a) => { asked++; return realNL(...a); };
  try { await T.padSnipeCycle(); } finally { lpStub.newLaunches = realNL; }
  assert.equal(asked, 0, 'an idle bot polls launchpad hosts for nobody');
});

test('a launch that already GRADUATED is not sniped from a pad feed', async () => {
  reset();
  USERS.push(armUser('bsc'));
  const t0 = Date.now() - 5000;
  FEEDS.bsc = { ok: true, byPad: { fourmeme: feedOk([item('0xB1', { createdAt: t0, pad: 'fourmeme' })]) } };
  await T.padSnipeCycle();   // seed
  FEEDS.bsc = { ok: true, byPad: { fourmeme: feedOk([item('0xB2', { createdAt: t0 + 1000, graduated: true, pad: 'fourmeme' })]) } };
  await T.padSnipeCycle();
  assert.equal(buys.length, 0, 'a migrated token is the DEX scan\'s job, not a launch');
});

test('one pad\'s bad clock cannot silence another pad — cursors are per pad', async () => {
  reset();
  USERS.push(armUser('robinhood'));
  const t0 = Date.now() - 60000;
  // Seed both pads; `other` reports a timestamp far in the future of `pons`.
  FEEDS.robinhood = { ok: true, byPad: {
    pons: feedOk([item('0xC1', { createdAt: t0 })]),
    other: feedOk([item('0xC2', { createdAt: t0 + 50000, pad: 'other' })]),
  } };
  await T.padSnipeCycle();
  // pons launches something newer than ITS cursor but older than other's.
  FEEDS.robinhood = { ok: true, byPad: {
    pons: feedOk([item('0xC3', { createdAt: t0 + 2000 })]),
    other: feedOk([item('0xC2', { createdAt: t0 + 50000, pad: 'other' })]),
  } };
  await T.padSnipeCycle();
  assert.equal(buys.length, 1, 'the shared-cursor defect is back: a pad with a fast clock silenced its neighbour');
  assert.equal(buys[0].token, '0xC3');
});

test('a feed that answered and a feed that did not stay different facts', async () => {
  reset();
  USERS.push(armUser('robinhood'));
  FEEDS.robinhood = { ok: true, byPad: {
    pons: feedOk([]),
    other: { ok: false, why: 'other: answered 500', items: [] },
  } };
  await T.padSnipeCycle();
  const stats = T._padSnipeStats;
  assert.ok(stats.pads['robinhood:pons'].ok >= 1, 'an answered-empty feed must count as OK');
  assert.equal(stats.pads['robinhood:pons'].why, null);
  assert.ok(stats.pads['robinhood:other'].fail >= 1);
  assert.match(stats.pads['robinhood:other'].why, /500/);
});

test('a feed path that keeps erroring is backed off, and the reason is kept', async () => {
  reset();
  USERS.push(armUser('bsc'));
  FEEDS.bsc = { ok: true, byPad: { fourmeme: { ok: false, why: 'four.meme: answered 404', items: [] } } };
  for (let i = 0; i < 3; i++) await T.padSnipeCycle();
  // Benched now: the next cycle must not ask for it.
  FEEDS.bsc = { ok: true, byPad: { fourmeme: feedOk([]) } };
  await T.padSnipeCycle();
  assert.ok(!FEEDS.bsc._asked || !FEEDS.bsc._asked.includes('fourmeme'), 'a 404ing feed path is re-asked every tick for ever');
  assert.match(T._padSnipeStats.pads['bsc:fourmeme'].why, /404/, 'the bench reason was thrown away');
});

// ── the retry ring: too early is not missed ──────────────────────────────────

test('a launch seen before its market opens is parked, then bought when it opens', async () => {
  reset();
  USERS.push(armUser('robinhood'));
  CAN_TRADE = async () => false;   // pad-discovered launches are gated
  const t0 = Date.now() - 5000;
  FEEDS.robinhood = { ok: true, byPad: { pons: feedOk([item('0xD1', { createdAt: t0 })]), other: feedOk([]) } };
  await T.padSnipeCycle();   // seed
  FEEDS.robinhood = { ok: true, byPad: { pons: feedOk([item('0xD2', { createdAt: t0 + 1000 })]), other: feedOk([]) } };
  await T.padSnipeCycle();
  assert.equal(buys.length, 0, 'a gated launch must not be bought before it is tradeable');
  assert.equal(T._launchRetry.size, 1, 'the too-early launch was dropped instead of parked');
  // Market still closed: the ring probes, buys nothing, keeps the entry.
  await T.launchRetryCycle();
  assert.equal(buys.length, 0);
  assert.equal(T._launchRetry.size, 1);
  // Market opens: the ring fires the buy.
  CAN_TRADE = async () => true;
  await T.launchRetryCycle();
  assert.equal(buys.length, 1, 'the launch was never retried — the "retried while fresh" comment over code that could not');
  assert.equal(buys[0].token, '0xD2');
  assert.equal(T._launchRetry.size, 0, 'a fired entry must leave the ring');
});

test('an event-scan buy that fails with "no route" lands in the ring — not in a DM, not on the floor', async () => {
  reset();
  USERS.push(armUser('robinhood'));
  BUY = async () => { throw new Error('no route / no liquidity for this token on Jupiter'); };
  await T._fireLaunch('robinhood', { token: '0xE1', sym: 'E', creator: '', at: Date.now() }, { armed: USERS, devFollowers: [] });
  assert.equal(T._launchRetry.size, 1, 'a too-early failure was dropped');
  assert.equal(notes.filter((n) => /failed/i.test(n.text)).length, 0, 'the normal first answer for a fresh token was reported as a failure');
  // And a REAL failure is still a real failure.
  BUY = async () => { throw new Error('insufficient output amount'); };
  await T._fireLaunch('robinhood', { token: '0xE2', sym: 'E', creator: '', at: Date.now() }, { armed: USERS, devFollowers: [] });
  assert.equal(notes.filter((n) => /failed/i.test(n.text)).length, 1, 'a real failure must still be told');
});

test('a user who already bought is never re-offered the launch by the ring', async () => {
  reset();
  const u1 = armUser('robinhood'); const u2 = armUser('robinhood');
  USERS.push(u1, u2);
  // u1 fills, u2 is too early.
  BUY = async (chatId) => {
    if (chatId === u2.chatId) throw new Error('no pool');
    return { sym: 'PAD', gotTokens: 100, spentEth: 0.05, native: 'ETH', hash: '0xhash' };
  };
  await T._fireLaunch('robinhood', { token: '0xF1', sym: 'F', creator: '', at: Date.now() }, { armed: USERS, devFollowers: [] });
  assert.equal(buys.filter((b) => b.chatId === u1.chatId).length, 1);
  assert.equal(T._launchRetry.size, 1);
  BUY = async () => ({ sym: 'PAD', gotTokens: 100, spentEth: 0.05, native: 'ETH', hash: '0xhash' });
  await T.launchRetryCycle();
  // u2 got its fill; u1 must NOT have been bought twice.
  assert.equal(buys.filter((b) => b.chatId === u1.chatId).length, 1, 'the ring re-bought for a user who already held — a double spend');
  assert.equal(buys.filter((b) => b.chatId === u2.chatId).length, 1);
});

test('an expired entry leaves the ring unbought', async () => {
  reset();
  USERS.push(armUser('robinhood'));
  T._launchRetry.set('robinhood:0xg1', { chainKey: 'robinhood', L: { token: '0xG1', at: Date.now() - 10 * 60 * 1000 }, done: new Set(), tries: 0 });
  await T.launchRetryCycle();
  assert.equal(T._launchRetry.size, 0, 'a stale launch polls for ever');
  assert.equal(buys.length, 0, 'an expired launch was bought anyway');
});

test('an entry whose audience disarmed is dropped without a probe', async () => {
  reset();   // no users at all
  let probed = 0;
  CAN_TRADE = async () => { probed++; return true; };
  T._launchRetry.set('robinhood:0xh1', { chainKey: 'robinhood', L: { token: '0xH1', at: Date.now() }, done: new Set(), tries: 0 });
  await T.launchRetryCycle();
  assert.equal(T._launchRetry.size, 0);
  assert.equal(probed, 0, 'a launch with no audience still spends probes');
});

// ── the dev-wallet snipe actually buys ───────────────────────────────────────

test('a dev launch from a PAD FEED is bought for the follower — pads carry the creator', async () => {
  reset();
  const dev = '0xDEADDEV';
  USERS.push(devUser('robinhood', dev));
  const t0 = Date.now() - 5000;
  FEEDS.robinhood = { ok: true, byPad: { pons: feedOk([item('0xI0', { createdAt: t0 })]), other: feedOk([]) } };
  await T.padSnipeCycle();   // seed
  FEEDS.robinhood = { ok: true, byPad: { pons: feedOk([item('0xI1', { createdAt: t0 + 1000, creator: dev })]), other: feedOk([]) } };
  await T.padSnipeCycle();
  assert.equal(buys.length, 1, 'the followed dev\'s pad launch was not bought');
  assert.equal(buys[0].token, '0xI1');
  assert.match(notes[0].text, /Dev snipe/);
});

test('a dev snipe that arrives before the pool opens is retried, and FILLS', async () => {
  reset();
  const dev = '0xDEADDEV';
  USERS.push(devUser('robinhood', dev));
  // The dev's launch is seen instantly — before the pool. The buy says so.
  BUY = async () => { throw new Error('no liquidity / zero quote for this token on robinhood'); };
  await T._fireLaunch('robinhood', { token: '0xJ1', sym: 'J', creator: dev, at: Date.now() }, { armed: [], devFollowers: USERS });
  assert.equal(T._launchRetry.size, 1, 'THE dev-snipe case: seen too early must mean parked, not dropped');
  assert.equal(notes.filter((n) => /Dev-snipe .* failed/i.test(n.text)).length, 0, 'too-early reported as a failed snipe');
  // The dev opens the pool; the ring fires and the follower is filled.
  BUY = async () => ({ sym: 'J', gotTokens: 50, spentEth: 0.02, native: 'ETH', hash: '0xhash', gotRaw: '50' });
  await T.launchRetryCycle();
  assert.equal(buys.length, 1, 'the dev snipe never bought — the feature reported working while unable to fill');
  assert.match(notes.at(-1).text, /Dev snipe/);
  // Idempotent: the target's own dedup refuses a second buy of the same launch.
  await T._fireLaunch('robinhood', { token: '0xJ1', sym: 'J', creator: dev, at: Date.now() }, { armed: [], devFollowers: USERS });
  assert.equal(buys.length, 1, 'a re-offered launch was bought twice');
});

test('a dev-sniped launch is not ALSO snipe-all bought for the same user', async () => {
  reset();
  const dev = '0xDEADDEV';
  const u = devUser('robinhood', dev);
  u.snipe = { chains: { robinhood: true }, ethAmount: 0.05 };   // both features armed
  USERS.push(u);
  await T._fireLaunch('robinhood', { token: '0xK1', sym: 'K', creator: dev, at: Date.now() }, { armed: [u], devFollowers: [u] });
  assert.equal(buys.length, 1, 'one launch, one user, two buys');
});

// ── dedup is chain-aware ─────────────────────────────────────────────────────

test('Solana mints are deduped case-SENSITIVELY — base58 is not EVM', () => {
  const a = 'So1anaMintAAAA';
  const b = 'so1anamintaaaa';   // a DIFFERENT mint on Solana
  assert.equal(T._snipeMark('solana', a), true);
  assert.equal(T._snipeMark('solana', b), true, 'two different mints folded onto one key — the second launch is silently dropped');
  assert.equal(T._snipeMark('solana', a), false);
  // EVM stays case-insensitive: 0xAbc and 0xABC are the same contract.
  assert.equal(T._snipeMark('bsc', '0xAbCd'), true);
  assert.equal(T._snipeMark('bsc', '0xABCD'), false);
});

test('a BROADCAST buy is never re-offered by the ring — it may still land', async () => {
  reset();
  const u1 = armUser('robinhood'); const u2 = armUser('robinhood');
  USERS.push(u1, u2);
  // u1's buy broadcasts and dies unconfirmed; u2 is too early. The launch
  // requeues for u2 — and u1 must be in the ring's done-set, because their
  // transaction may still confirm and a second buy is a double spend.
  BUY = async (chatId) => {
    if (chatId === u1.chatId) { const e = new Error('broadcast, not confirmed'); e.broadcast = true; throw e; }
    throw new Error('no pool');
  };
  await T._fireLaunch('robinhood', { token: '0xL1', sym: 'L', creator: '', at: Date.now() }, { armed: USERS, devFollowers: [] });
  assert.equal(T._launchRetry.size, 1, 'u2 was dropped instead of parked');
  BUY = async () => ({ sym: 'L', gotTokens: 10, spentEth: 0.05, native: 'ETH', hash: '0xhash' });
  await T.launchRetryCycle();
  assert.equal(buys.filter((b) => b.chatId === u1.chatId).length, 0, 'a broadcast buy was re-offered — a double spend if the first tx lands');
  assert.equal(buys.filter((b) => b.chatId === u2.chatId).length, 1, 'the waiting user never got their fill');
});

test('a launch past the per-cycle budget is queued for the ring, never silently dropped', async () => {
  reset();
  USERS.push(armUser('solana'));
  CAN_TRADE = async () => true;
  const t0 = Date.now() - 5000;
  FEEDS.solana = { ok: true, byPad: { letsbonk: feedOk([item('SeedMint111', { createdAt: t0, pad: 'letsbonk' })]) } };
  await T.padSnipeCycle();   // seed
  // Ten fresh launches against the Solana per-tick budget of 5: the pad cursor
  // advances past ALL of them, so anything not fired now must be in the ring or
  // it is gone for ever.
  const many = Array.from({ length: 10 }, (_, i) => item('FreshMint' + i, { createdAt: t0 + 1000 + i, pad: 'letsbonk' }));
  FEEDS.solana = { ok: true, byPad: { letsbonk: feedOk(many) } };
  await T.padSnipeCycle();
  assert.equal(buys.length + T._launchRetry.size, 10, `${buys.length} bought + ${T._launchRetry.size} queued — the rest vanished past an advanced cursor`);
  assert.ok(buys.length <= 5, 'the Solana per-tick budget is not being applied');
  // …and the queued ones fill from the ring.
  await T.launchRetryCycle(); await T.launchRetryCycle();
  assert.ok(buys.length > 5, 'the queued overflow was never fired');
});

test('a pad replaying stale history after a bench does not buy ten-minute-old launches', async () => {
  reset();
  USERS.push(armUser('bsc'));
  const t0 = Date.now() - 30 * 60 * 1000;   // half an hour ago
  FEEDS.bsc = { ok: true, byPad: { fourmeme: feedOk([item('0xOld0', { createdAt: t0, pad: 'fourmeme' })]) } };
  await T.padSnipeCycle();   // seed at the stale head
  FEEDS.bsc = { ok: true, byPad: { fourmeme: feedOk([
    item('0xOld1', { createdAt: t0 + 60000, pad: 'fourmeme' }),          // newer than the cursor, still 29 min old
    item('0xNew1', { createdAt: Date.now() - 5000, pad: 'fourmeme' }),   // actually fresh
  ]) } };
  await T.padSnipeCycle();
  assert.equal(buys.length, 1, 'a stale launch was sniped — that is buying somebody\'s exit');
  assert.equal(buys[0].token, '0xNew1');
});

// ── the audit round: five defects the first cut of this feature shipped ──────

test('a launch the ring gave up on unblocks its own graduation buy', async () => {
  reset();
  USERS.push(armUser('bsc'));
  // A four.meme curve token: seen by the pad feed, gated (no market), parked.
  CAN_TRADE = async () => false;
  const t0 = Date.now() - 5000;
  FEEDS.bsc = { ok: true, byPad: { fourmeme: feedOk([item('0xM0', { createdAt: t0, pad: 'fourmeme' })]) } };
  await T.padSnipeCycle();   // seed
  FEEDS.bsc = { ok: true, byPad: { fourmeme: feedOk([item('0xM1', { createdAt: t0 + 1000, pad: 'fourmeme' })]) } };
  await T.padSnipeCycle();
  assert.equal(T._launchRetry.size, 1);
  // The ring expires it — a curve lives minutes-to-days, far past the window.
  const k = [...T._launchRetry.keys()][0];
  T._launchRetry.get(k).L.at = Date.now() - 10 * 60 * 1000;
  await T.launchRetryCycle();
  assert.equal(T._launchRetry.size, 0);
  // NOBODY was served, so the mark must be gone: the graduation PairCreated
  // event — where these tokens were ALWAYS bought before the pad loop existed —
  // has to be able to offer it. A mark left behind here made the launchpad
  // integration silently disable the one path that already worked.
  assert.equal(T._snipeMark('bsc', '0xM1'), true, 'the expired launch stayed marked — the graduation snipe is permanently suppressed');
});

test('…but a launch SOMEBODY holds stays marked — their graduation re-buy is the double spend', async () => {
  reset();
  const u1 = armUser('robinhood'); const u2 = armUser('robinhood');
  USERS.push(u1, u2);
  // u1 fills; u2 is too early → the launch requeues carrying u1 in done.
  BUY = async (chatId) => {
    if (chatId === u1.chatId) return { sym: 'N', gotTokens: 10, spentEth: 0.05, native: 'ETH', hash: '0xhash' };
    throw new Error('no pool');
  };
  await T._fireLaunch('robinhood', { token: '0xN1', sym: 'N', creator: '', at: Date.now() }, { armed: USERS, devFollowers: [] });
  assert.equal(T._launchRetry.size, 1);
  // Expire it with u2 still unfilled: u1 HOLDS the token, so the mark must stay.
  const k = [...T._launchRetry.keys()][0];
  T._launchRetry.get(k).L.at = Date.now() - 10 * 60 * 1000;
  T._snipeMark('robinhood', '0xN1');   // the discoverer marked it (as the scans do)
  await T.launchRetryCycle();
  assert.equal(T._snipeMark('robinhood', '0xN1'), false, 'a launch somebody holds was unmarked — its graduation event now buys it twice for them');
});

test('the dev-target budget cannot be spent past its cap by two concurrent launches', async () => {
  reset();
  const dev = '0xDEADDEV';
  const u = devUser('robinhood', dev);
  // Budget 0.05: room for exactly ONE 0.02 buy plus change — never two.
  u.copy.targets[0].maxEth = '0.05';
  u.copy.targets[0].buyEth = '0.02';
  u.copy.targets[0].spentEth = 0.02;
  USERS.push(u);
  // The safety gate is a NETWORK await; hold the first call open until the
  // second has read the (stale) spentEth — the exact interleave the retry
  // ring made possible by firing concurrently with the discovery loop.
  let release; const gate = new Promise((r) => { release = r; });
  let calls = 0;
  SAFETY = async () => { calls++; if (calls === 1) await gate; return null; };
  const t = u.copy.targets[0];
  const a = T._followerBuy(u, t, '0xP1', 'robinhood', {});
  const b = T._followerBuy(u, t, '0xP2', 'robinhood', {});
  release();
  await Promise.all([a, b]);
  assert.ok(Number(t.spentEth) <= Number(t.maxEth) + 1e-12, `spent ${t.spentEth} past the cap ${t.maxEth} — the check-then-claim spans the safety await`);
  assert.equal(buys.length, 1, 'both launches bought — the budget re-check after the await is gone');
});

test('a user who arms AFTER a launch is queued is not bought into it', async () => {
  reset();
  const u1 = armUser('robinhood');
  USERS.push(u1);
  BUY = async () => { throw new Error('no pool'); };
  await T._fireLaunch('robinhood', { token: '0xQ1', sym: 'Q', creator: '', at: Date.now() }, { armed: [u1], devFollowers: [] });
  assert.equal(T._launchRetry.size, 1);
  // u2 arms a minute later — the launch predates their consent to spend.
  const u2 = armUser('robinhood');
  USERS.push(u2);
  BUY = async () => ({ sym: 'Q', gotTokens: 10, spentEth: 0.05, native: 'ETH', hash: '0xhash' });
  await T.launchRetryCycle();
  assert.equal(buys.filter((b) => b.chatId === u1.chatId).length, 1, 'the user who was armed at queue time never got their fill');
  assert.equal(buys.filter((b) => b.chatId === u2.chatId).length, 0, 'the ring retro-sniped for a user who armed after the launch');
});

test('a re-scan requeue remembers the users served in the FIRST pass', async () => {
  reset();
  const dev = '0xDEADDEV';
  const uA = armUser('robinhood');
  const uD = devUser('robinhood', dev);
  USERS.push(uA, uD);
  // First pass: uA fills through snipe-all.
  await T._fireLaunch('robinhood', { token: '0xR1', sym: 'R', creator: '', at: Date.now() }, { armed: [uA], devFollowers: [] });
  assert.equal(buys.filter((b) => b.chatId === uA.chatId).length, 1);
  // Re-scan (cursor regression): armed is emptied AND rides as skip — the
  // dev buy is too early, so the launch requeues. Without the skip, `done`
  // is built only from THIS invocation and uA is exposed to a ring re-buy.
  BUY = async () => { throw new Error('no pool'); };
  await T._fireLaunch('robinhood', { token: '0xR1', sym: 'R', creator: dev, at: Date.now() },
    { armed: [], devFollowers: [uD], skip: new Set([uA.chatId]) });
  assert.equal(T._launchRetry.size, 1);
  BUY = async () => ({ sym: 'R', gotTokens: 10, spentEth: 0.05, native: 'ETH', hash: '0xhash', gotRaw: '10' });
  await T.launchRetryCycle();
  assert.equal(buys.filter((b) => b.chatId === uA.chatId).length, 1, 'the ring re-bought a launch for a user who filled it in the first pass — a double spend');
  assert.equal(buys.filter((b) => b.chatId === uD.chatId).length, 1, 'the waiting dev follower never filled');
});

test('a registry-breaker SKIP is "we did not ask", never a feed failure', async () => {
  reset();
  USERS.push(armUser('bsc'));
  FEEDS.bsc = { ok: true, byPad: { fourmeme: { ok: false, skipped: true, why: 'four.meme: skipped, 3 failures in a row (unreachable) — retrying in 240s', items: [] } } };
  for (let i = 0; i < 4; i++) await T.padSnipeCycle();
  const stat = T._padSnipeStats.pads['bsc:fourmeme'];
  assert.equal(stat.fail, 0, 'a skip we issued ourselves was counted as the host failing');
  assert.equal(T._padFeedFail.size, 0, 'the local bench fed on the registry bench — a double-bench that outlives the outage');
  assert.match(stat.why, /skipped/, 'the reason must still be visible');
});

test('a feed whose items carry no createdAt says so, instead of seeding for ever', async () => {
  reset();
  USERS.push(armUser('bsc'));
  const rows = [item('0xS1', { createdAt: null, pad: 'fourmeme' }), item('0xS2', { createdAt: null, pad: 'fourmeme' })];
  FEEDS.bsc = { ok: true, byPad: { fourmeme: feedOk(rows) } };
  await T.padSnipeCycle();
  await T.padSnipeCycle();
  assert.equal(buys.length, 0);
  const stat = T._padSnipeStats.pads['bsc:fourmeme'];
  assert.ok(stat.lastOkAt, 'the host answered — that fact stays recorded');
  assert.match(String(stat.why), /createdAt|cursor/, 'a pad that can never fire reads as a healthy quiet one');
});

test('an unreadable balance is a silent skip, never a "wallet has 0.00000" notice', async () => {
  reset();
  USERS.push(armUser('robinhood'));
  BAL_OR_NULL = async () => null;   // dead RPC — the read FAILED, the wallet is fine
  await T._fireLaunch('robinhood', { token: '0xT1', sym: 'T', creator: '', at: Date.now() }, { armed: USERS, devFollowers: [] });
  assert.equal(buys.length, 0);
  assert.equal(notes.length, 0, 'a dead RPC was reported to a funded user as an empty wallet — and the told-once flag latched on it');
});

test('pump.fun overflow past the per-cycle budget queues for the ring', async () => {
  reset();
  USERS.push(armUser('solana'));
  const t0 = Date.now() - 5000;
  const coin = (i) => ({ mint: 'PumpMint' + i, symbol: 'P' + i, creator: '', createdTs: t0 + i * 10 });
  solanaStub.pumpfunNewX = async () => ({ ok: true, coins: [coin(0)] });
  await T.solSnipeCycle();   // seeds the pump cursor
  solanaStub.pumpfunNewX = async () => ({ ok: true, coins: Array.from({ length: 6 }, (_, i) => coin(i + 1)) });
  await T.solSnipeCycle();
  assert.equal(buys.length + T._launchRetry.size, 6, `${buys.length} bought + ${T._launchRetry.size} queued — the overflow vanished past the cursor`);
  assert.ok(T._launchRetry.size > 0, 'nothing was queued — the budget cap is not being exercised (raise the launch count)');
  await T.launchRetryCycle();
  assert.equal(buys.length, 6, 'the queued pump.fun overflow was never fired');
});

test('_notYetTradeable separates "no market yet" from every real failure', () => {
  const yes = ['no route / no liquidity for this token on Jupiter', 'no V3 liquidity / zero quote for this token on Ethereum', 'could not quote this buy on Base (no pool? try again): CALL_EXCEPTION', 'not tradable'];
  const no = ['insufficient ETH — need ~0.016, have 0.0149', 'transaction reverted', "this token's liquidity is on ston.fi, which Dexvra can't route through yet — no swap to sign", 'rate limited (429)'];
  for (const m of yes) assert.equal(T._notYetTradeable(new Error(m)), true, `should retry: ${m}`);
  for (const m of no) assert.equal(T._notYetTradeable(new Error(m)), false, `must not retry: ${m}`);
});

// ── Pons: the second Robinhood launchpad, read from the chain itself ─────────
//
// The HTTP pad for Pons cannot answer from anywhere this repo runs (the box
// times out, the sandbox is egress-blocked), so discovery is the factory's own
// TokenLaunched log. These tests drive _ponsScan with a stub provider serving
// REAL encoded logs — the decode path is the part a guessed ABI gets wrong.
const PONS_SIG = 'TokenLaunched(address,address,address,address,address,uint256,uint256,uint256,uint256,uint256)';
const PONS_FACTORY = '0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB';
function ponsLog(token, deployer, blockNumber) {
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const pad32 = (a) => ethers.zeroPadValue(ethers.getAddress(a), 32);
  return {
    address: PONS_FACTORY,
    topics: [ethers.id(PONS_SIG), pad32(token), pad32(deployer), pad32('0x' + '3'.repeat(40))],
    data: coder.encode(['address', 'address', 'uint256', 'uint256', 'uint256', 'uint256', 'uint256'],
      ['0x' + '4'.repeat(40), '0x' + '5'.repeat(40), 1n, 1n, 7n, 0n, 0n]),
    blockNumber, blockHash: '0x' + 'b'.repeat(64), transactionHash: '0x' + 'c'.repeat(64),
    index: 0, transactionIndex: 0, removed: false,
  };
}
function ponsProvider(ctl) {
  const p = {
    getCode: async () => ctl.code ?? '0xdeadbeef',
    getLogs: async (f) => {
      // queryFilter passes topics; the raw-mismatch probe does not. Serving
      // them apart is what lets a test present "the factory emits logs our
      // filter does not match".
      if (f && f.topics && f.topics.length) return (ctl.logs || []).filter((l) => l.topics[0] === f.topics[0]);
      return (ctl.raw || ctl.logs || []);
    },
    getNetwork: async () => new ethers.Network('robinhood', 4663),
    _detectNetwork: async () => new ethers.Network('robinhood', 4663),
    call: async () => '0x', resolveName: async (n) => n,
  };
  p.provider = p;
  return p;
}
const { ethers } = require('ethers');

test('a Pons TokenLaunched log is sniped, and its deployer IS the dev wallet', async () => {
  reset();
  const dev = '0x' + 'd'.repeat(40);
  const uA = armUser('robinhood');
  const uD = devUser('robinhood', dev);
  USERS.push(uA, uD);
  const ctl = { logs: [] };
  const prov = ponsProvider(ctl);
  await T._ponsScan(prov, 10000, [uA], [uD]);   // first look seeds only
  assert.equal(buys.length, 0, 'the seeding pass bought');
  ctl.logs = [ponsLog('0x' + 'a1'.repeat(20), dev, 10050)];
  await T._ponsScan(prov, 10100, [uA], [uD]);
  assert.equal(buys.filter((b) => b.chatId === uA.chatId).length, 1, 'the armed user missed a Pons launch');
  assert.equal(buys.filter((b) => b.chatId === uD.chatId).length, 1, 'the dev follower missed their dev\'s Pons launch');
  assert.match(notes.map((n) => n.text).join('\n'), /Dev snipe/);
  assert.ok(T._snipeStats.ponsSeen >= 1);
  assert.equal(T._snipeStats.ponsErr, null);
});

test('a Pons launch is never double-served on a re-scan, and dev followers still pass', async () => {
  reset();
  const uA = armUser('robinhood');
  USERS.push(uA);
  const ctl = { logs: [ponsLog('0x' + 'a2'.repeat(20), '0x' + 'e'.repeat(40), 10150)] };
  const prov = ponsProvider(ctl);
  await T._ponsScan(prov, 10200, [uA], []);
  assert.equal(buys.length, 1);
  // The same log range replayed (a lagging RPC head): marked → snipe-all skipped.
  await T._ponsScan(prov, 10200, [uA], []);   // head < cursor pins, no re-buy
  await T._ponsScan(prov, 10250, [uA], []);
  assert.equal(buys.length, 1, 'a re-scan re-bought a Pons launch');
});

test('a factory that emits logs our filter does not match names the SIGNATURE as the problem', async () => {
  reset();
  USERS.push(armUser('robinhood'));
  const alien = ponsLog('0x' + 'a3'.repeat(20), '0x' + 'e'.repeat(40), 10350);
  alien.topics[0] = ethers.id('SomethingElse(address)');   // rotated ABI
  const ctl = { logs: [alien] };
  const prov = ponsProvider(ctl);
  await T._ponsScan(prov, 10400, USERS, []);
  assert.equal(buys.length, 0);
  assert.match(String(T._snipeStats.ponsErr), /PONS_EVENT/, 'a stale signature reads as a quiet launchpad');
});

test('LAUNCHPAD_PONS=0 kills the chain scan too — one feature, one switch', async () => {
  reset();
  USERS.push(armUser('robinhood'));
  process.env.LAUNCHPAD_PONS = '0';
  try {
    const ctl = { logs: [ponsLog('0x' + 'a4'.repeat(20), '0x' + 'e'.repeat(40), 10450)] };
    await T._ponsScan(ponsProvider(ctl), 10500, USERS, []);
    assert.equal(buys.length, 0, 'the kill switch does not reach the on-chain scan');
  } finally { delete process.env.LAUNCHPAD_PONS; }
  assert.equal(T._ponsCfg().on, true, 'blank must mean ON — the pads-table rule');
});

test('a PONS_FACTORY with no contract behind it is a sentence, not an eternal empty scan', async () => {
  reset();
  USERS.push(armUser('robinhood'));
  // The code verdict is cached per FACTORY for an hour — a different address
  // (the operator's .env override) gets a fresh look, which is also what lets
  // this test run after the ones that proved the default factory good.
  process.env.PONS_FACTORY = '0x' + 'f'.repeat(40);
  try {
    const prov = ponsProvider({ code: '0x', logs: [ponsLog('0x' + 'a5'.repeat(20), '0x' + 'e'.repeat(40), 10550)] });
    await T._ponsScan(prov, 10600, USERS, []);
    assert.equal(buys.length, 0);
    assert.match(String(T._snipeStats.ponsErr), /no contract/, 'a wrong factory address reads as a quiet chain');
  } finally { delete process.env.PONS_FACTORY; }
});
