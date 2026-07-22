'use strict';
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
const coreStub = {
  CFG: { gasBufferEth: '0.001', solGasBuffer: '0.01' },
  chains: { isSvm: (k) => k === 'solana', isEnabled: () => true },
  chainOf: (k) => ({ key: k, name: k, emoji: '◆', native: k === 'solana' ? 'SOL' : 'ETH', explorer: 'https://x' }),
  allUsers: () => USERS,
  saveStoreNow: () => saved.push(Date.now ? 1 : 1),
  saveStore: () => {},
  buy: async (chatId, token, amt) => {
    if (BUY_BEHAVIOR.throw) { const e = new Error(BUY_BEHAVIOR.msg || 'boom'); if (BUY_BEHAVIOR.broadcast) e.broadcast = true; throw e; }
    return { sym: 'DEV', gotTokens: 123, spentEth: amt, native: 'ETH', hash: '0xhash', chain: 'robinhood' };
  },
};
const safetyStub = { supported: () => false, tokenSecurity: async () => null, verdict: () => ({ level: 'ok' }) };
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
  A('rollback: returns true (was committed)', ret === true);
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

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('test crashed:', e); process.exit(1); });
