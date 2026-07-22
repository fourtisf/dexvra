'use strict';
process.env.SNIPE_SEEN_CAP = '4000';   // pin to the min cap (floor) so eviction is testable without a huge flood
/* Offline unit test for the dev-wallet snipe internals (no network / no chain):
 *   • _snipeMark  — per-launch dedup (audit #1)
 *   • _followerBuy — crash-safe commit / rollback / budget-cap / dedup / broadcast
 *   • launchFollowers — master-switch + mode filter
 * Run: node scripts/devsnipe-test.js */
const path = require('path');

// ---- Stubs injected before watchers.js requires them ----
let BUY_BEHAVIOR = { ok: true };   // toggled per case
const saved = [];                   // records saveStoreNow calls
const notes = [];                   // captured notifications
let SNAP_PRICE = 0;                  // tokenSnapshot priceEth (positions test)
let SELL_BEHAVIOR = { ok: true };   // core.sell behavior (positions test)
const sellCalls = [];               // records core.sell(chatId, ca, pct, chain, wid, opts)
let SAFE = { supported: false, level: 'ok' };   // safety verdict (positions test)
const coreStub = {
  CFG: { gasBufferEth: '0.001', solGasBuffer: '0.01' },
  chains: { isSvm: (k) => k === 'solana', isEnabled: () => true },
  chainOf: (k) => ({ key: k, name: k, emoji: '◆', native: k === 'solana' ? 'SOL' : 'ETH', explorer: 'https://x' }),
  allUsers: () => USERS,
  walletList: (u) => u.wallets || [],
  notifyOn: () => false,   // alerts OFF → only autoProtect can drive positionsCycle
  tokenSnapshot: async () => (SNAP_PRICE > 0 ? { priceEth: SNAP_PRICE, sym: 'DEV' } : null),
  sell: async (chatId, ca, pct, chain, wid, opts) => {
    sellCalls.push({ chatId, ca, pct, chain, wid, opts });
    if (SELL_BEHAVIOR.throw) throw new Error(SELL_BEHAVIOR.msg || 'sell failed');
    return { proceedsEth: 0.05, native: 'ETH', hash: '0xsellhash', soldPct: pct };
  },
  saveStoreNow: () => saved.push(1),
  saveStore: () => {},
  buy: async (chatId, token, amt) => {
    if (BUY_BEHAVIOR.throw) { const e = new Error(BUY_BEHAVIOR.msg || 'boom'); if (BUY_BEHAVIOR.broadcast) e.broadcast = true; throw e; }
    return { sym: 'DEV', gotTokens: 123, spentEth: amt, native: 'ETH', hash: '0xhash', chain: 'robinhood' };
  },
};
const safetyStub = { supported: () => SAFE.supported, tokenSecurity: async () => ({}), verdict: () => ({ level: SAFE.level }) };
const dir = path.resolve(__dirname, '..');
const inject = (rel, exp) => { const p = require.resolve(path.join(dir, rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports: exp }; };
inject('core', coreStub);
inject('safety', safetyStub);
inject('goplus', {});
inject('solana', { isSolAddress: () => true, WSOL_MINT: 'W' });

const USERS = [];
const w = require(path.join(dir, 'watchers'));
w.setNotifier((chatId, text) => notes.push({ chatId, text }));
const T = w._test;

let pass = 0, fail = 0;
const A = (name, cond) => { console.log((cond ? '✅' : '❌') + ' ' + name); cond ? pass++ : fail++; };
const mkT = (over) => Object.assign({ id: 'cp1', address: '0xDEV', chain: 'robinhood', mode: 'launches', buyEth: '0.02', maxEth: '0.06', spentEth: 0, bought: {} }, over);

(async () => {
  // ---- _snipeMark ----
  A('_snipeMark first = true', T._snipeMark('robinhood', '0xAaa') === true);
  A('_snipeMark repeat = false', T._snipeMark('robinhood', '0xAAA') === false);      // case-insensitive
  A('_snipeMark other chain = true', T._snipeMark('base', '0xAaa') === true);
  // Per-chain isolation (audit #1): flooding a busy chain PAST its cap (default floor 4000)
  // must NOT evict a different chain's still-remembered launch. This is the core #1 fix.
  T._snipeMark('slowchain', '0xKEEP');
  for (let i = 0; i < 4200; i++) T._snipeMark('busychain', '0xB' + i);   // exceed the pinned cap 4000
  A('_snipeMark cross-chain isolation (busy chain cannot evict slow chain)', T._snipeMark('slowchain', '0xKEEP') === false);   // still remembered
  A('_snipeMark same-chain eviction works', T._snipeMark('busychain', '0xB0') === true);  // oldest on busychain evicted

  // ---- launchFollowers ----
  USERS.length = 0;
  USERS.push({ chatId: 1, copy: { on: true, targets: [mkT({})] } });
  USERS.push({ chatId: 2, copy: { on: false, targets: [mkT({})] } });                // master OFF → excluded
  USERS.push({ chatId: 3, copy: { on: true, targets: [mkT({ mode: 'trades' })] } });  // trades mode → excluded
  const lf = T.launchFollowers('robinhood');
  A('launchFollowers only ON+launches', lf.length === 1 && lf[0].chatId === 1);
  A('launchFollowers wrong chain empty', T.launchFollowers('solana').length === 0);

  // ---- _followerBuy: success commits + notifies + returns true ----
  BUY_BEHAVIOR = { ok: true }; notes.length = 0;
  let t = mkT({});
  let ret = await T._followerBuy({ chatId: 1 }, t, '0xToken1', 'robinhood');
  A('success: returns true', ret === true);
  A('success: bought marked', t.bought['0xtoken1'] === true);
  A('success: spent += buyEth', Math.abs(Number(t.spentEth) - 0.02) < 1e-9);
  A('success: notified', notes.length === 1 && /Dev snipe/.test(notes[0].text));

  // ---- dedup: second call for same token is a no-op, returns false ----
  notes.length = 0;
  ret = await T._followerBuy({ chatId: 1 }, t, '0xTOKEN1', 'robinhood');   // case-insensitive dup
  A('dedup: returns false', ret === false);
  A('dedup: no second buy', Number(t.spentEth) === 0.02 && notes.length === 0);

  // ---- budget cap: spent at max blocks further buys, returns false ----
  t = mkT({ spentEth: 0.05, maxEth: 0.06 });   // 0.05 + 0.02 = 0.07 > 0.06 → blocked
  ret = await T._followerBuy({ chatId: 1 }, t, '0xToken2', 'robinhood');
  A('budget cap: returns false', ret === false);
  A('budget cap: blocked', t.bought['0xtoken2'] === undefined && Number(t.spentEth) === 0.05);

  // ---- rollback: non-broadcast failure restores spent + dedup (still returns true = committed) ----
  BUY_BEHAVIOR = { throw: true, msg: 'reverted', broadcast: false }; notes.length = 0;
  t = mkT({});
  ret = await T._followerBuy({ chatId: 1 }, t, '0xToken3', 'robinhood');
  A('rollback: returns false (rolled back → snipe-all fallback allowed)', ret === false);
  A('rollback: spent restored to 0', Number(t.spentEth) === 0);
  A('rollback: dedup cleared', t.bought['0xtoken3'] === undefined);
  A('rollback: failure DM sent', notes.length === 1 && /failed/.test(notes[0].text));

  // ---- broadcast failure: keep commit (may still land) ----
  BUY_BEHAVIOR = { throw: true, msg: 'not confirmed', broadcast: true }; notes.length = 0;
  t = mkT({});
  ret = await T._followerBuy({ chatId: 1 }, t, '0xToken4', 'robinhood');
  A('broadcast: returns true', ret === true);
  A('broadcast: spent KEPT', Math.abs(Number(t.spentEth) - 0.02) < 1e-9);
  A('broadcast: dedup KEPT', t.bought['0xtoken4'] === true);

  // ---- Auto-protect (rug guard) in positionsCycle ----
  const TOK = '1000000000000000000';   // 1 token (18 dec)
  const mkPos = (over) => Object.assign({ chain: 'robinhood', ca: '0xtok', sym: 'DEV', dec: 18, ethIn: 0.1, tokens: TOK, peakValueEth: 1.0, notified: {} }, over);
  const mkUser = (autoProtect, pos) => ({ chatId: 1, settings: { autoProtect }, wallets: [{ id: 'w1', positions: { 'robinhood:0xtok': pos } }] });
  const resetPos = () => { sellCalls.length = 0; notes.length = 0; };

  // Crash: value 0.2 vs peak 1.0 = 80% drop ≥ 65% → auto-sell 100%
  resetPos(); SNAP_PRICE = 0.2; SELL_BEHAVIOR = { ok: true }; SAFE = { supported: false, level: 'ok' };
  USERS.length = 0; USERS.push(mkUser(true, mkPos({})));
  await T.positionsCycle();
  A('autoProtect crash → sells 100%', sellCalls.length === 1 && sellCalls[0].pct === 100 && sellCalls[0].wid === 'w1');
  A('autoProtect crash → aggressive slippage/gas opts', !!sellCalls[0] && sellCalls[0].opts && sellCalls[0].opts.slipAddBps >= 1000 && sellCalls[0].opts.gasMult >= 2);
  A('autoProtect crash → DM sent', notes.some((n) => /Auto-protect sold/.test(n.text)));

  // Guard OFF: same crash, autoProtect false → no sell
  resetPos(); USERS.length = 0; USERS.push(mkUser(false, mkPos({})));
  await T.positionsCycle();
  A('guard OFF → no auto-sell', sellCalls.length === 0);

  // Mild dip (30%), safety OK → no sell
  resetPos(); SNAP_PRICE = 0.7; SAFE = { supported: true, level: 'ok' };
  USERS.length = 0; USERS.push(mkUser(true, mkPos({})));
  await T.positionsCycle();
  A('mild dip + safe → no auto-sell', sellCalls.length === 0);

  // Mild dip (30%) but safety flips to DANGER → auto-sell
  resetPos(); SNAP_PRICE = 0.7; SAFE = { supported: true, level: 'danger' };
  USERS.length = 0; USERS.push(mkUser(true, mkPos({})));
  await T.positionsCycle();
  A('mild dip + DANGER → auto-sell 100%', sellCalls.length === 1 && sellCalls[0].pct === 100);

  // Cooldown: crash but protectAt just now → no repeat sell
  resetPos(); SNAP_PRICE = 0.2; SAFE = { supported: false, level: 'ok' };
  const recentPos = mkPos({ notified: { protectAt: Date.now() } });
  USERS.length = 0; USERS.push(mkUser(true, recentPos));
  await T.positionsCycle();
  A('cooldown → no repeat auto-sell', sellCalls.length === 0);

  // Honeypot: crash triggers sell but sell throws → failure DM, no crash
  resetPos(); SNAP_PRICE = 0.2; SELL_BEHAVIOR = { throw: true, msg: 'reverted: cannot sell' };
  USERS.length = 0; USERS.push(mkUser(true, mkPos({})));
  await T.positionsCycle();
  A('honeypot sell fails → failure DM, no throw', sellCalls.length === 1 && notes.some((n) => /couldn't exit/.test(n.text)));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('test crashed:', e); process.exit(1); });
