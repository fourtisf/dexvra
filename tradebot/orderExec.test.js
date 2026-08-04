'use strict';
/*
 * What a triggered order is allowed to spend to actually LAND.
 *
 * A stop-loss fires at exactly the moment the price is falling and every other
 * holder is trying to leave — the worst conditions for the default gas price and
 * the default slippage there are. The auto-protect guard has escalated since it
 * was written (gasMult 2, slipAddBps 1500). The stop-loss the user set BY HAND,
 * the one they are relying on, went out with no escalation at all:
 *
 *     const r = await core.sell(u.chatId, o.ca, o.sellPct || 100, chain, w.id);
 *
 * A stop-loss that does not fill is not a stop-loss. It is a notification that
 * you lost the money anyway.
 *
 * These tests pin three things: that the escalation reaches the trade, that it
 * is chosen by the order's INTENT rather than one setting for all four types,
 * and that the user is told what it will cost.
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const test = require('node:test');
const assert = require('node:assert');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ordexec-'));
process.env.WALLET_SECRET = 'w'.repeat(48);
process.env.TRADEBOT_TOKEN = 'x:y';
process.env.ENABLED_CHAINS = 'robinhood';

const core = require('./core');
const watchers = require('./watchers');
const tg = require('./telegram');

const CA = '0x' + 'ab'.repeat(20);
const CHAT = 7;

function seed(orders) {
  core.DB.users = {};
  const u = core.ensureUser(CHAT);
  u.wallets = [{ id: 'w1', name: 'Wallet 1', address: '0x' + '11'.repeat(20), positions: {}, orders: [], history: [] }];
  u.activeWalletId = 'w1';
  for (const o of orders) watchers.addOrder(CHAT, { ca: CA, sym: 'PONS', chain: 'robinhood', ...o }, 'w1');
  return u;
}

/** Run one orders cycle at a price that trips everything, and capture the opts
 *  each trade was given. */
async function fire(orders, priceEth = 0.000001) {
  seed(orders);
  const calls = [];
  const realSnap = core.tokenSnapshot, realSell = core.sell, realBuy = core.buy;
  core.tokenSnapshot = async () => ({ sym: 'PONS', priceEth, mcapEth: priceEth * 1e9 });
  core.sell = async (chatId, ca, pct, chain, wid, opts) => {
    calls.push({ side: 'sell', pct, opts });
    return { sym: 'PONS', soldPct: pct, proceedsEth: 0.01, native: 'ETH', hash: '0x' + '1'.repeat(64) };
  };
  core.buy = async (chatId, ca, amt, chain, wid, opts) => {
    calls.push({ side: 'buy', amt, opts });
    return { sym: 'PONS', gotTokens: 1, spentEth: Number(amt), native: 'ETH', hash: '0x' + '1'.repeat(64) };
  };
  try { await watchers._test.ordersCycle(); }
  finally { core.tokenSnapshot = realSnap; core.sell = realSell; core.buy = realBuy; }
  return calls;
}

// ---------------------------------------------------------------- it reaches the trade
test('a stop-loss executes with escalated gas AND slippage', async () => {
  // The whole point. This used to be `core.sell(..., w.id)` with no sixth
  // argument at all.
  const calls = await fire([{ type: 'sl', targetPriceEth: 0.001, sellPct: 100 }]);
  assert.equal(calls.length, 1, 'the stop-loss did not fire');
  const o = calls[0].opts;
  assert.ok(o, 'the sell was given no execution options at all');
  assert.ok(o.gasMult > 1, `a stop-loss went out at ordinary gas (gasMult ${o.gasMult})`);
  assert.ok(o.slipAddBps > 0, `a stop-loss went out at ordinary slippage (slipAddBps ${o.slipAddBps})`);
});

test('a trailing stop is a stop, and is executed like one', async () => {
  const calls = await fire([{ type: 'trail', trailPct: 10, sellPct: 100, peakEth: 1 }]);
  assert.equal(calls.length, 1, 'the trailing stop did not fire');
  assert.deepEqual(calls[0].opts, watchers.ORDER_SPEED.turbo);
});

test('a limit BUY carries its options too — buy() ignored them entirely', async () => {
  // sell() has taken opts.gasMult since the retry work; buy() did not, so a
  // triggered limit buy could not be escalated even if the watcher asked.
  const calls = await fire([{ type: 'limitbuy', targetPriceEth: 0.001, ethAmount: '0.05' }]);
  assert.equal(calls.length, 1, 'the limit buy did not fire');
  assert.ok(calls[0].opts && calls[0].opts.gasMult > 1, 'the limit buy went out at ordinary gas');
  const CORE = fs.readFileSync(path.join(__dirname, 'core.js'), 'utf8');
  assert.match(CORE, /const gasBoost = Math\.max\(userGasBoost\(u\), \(opts && opts\.gasMult\) \|\| 1\);/,
    'core.buy still ignores opts.gasMult');
  assert.match(CORE, /const slipAdd = BigInt\(Math\.max\(0, Math\.round\(\(opts && opts\.slipAddBps\) \|\| 0\)\)\);[\s\S]{0,200}slipBps\(u\) \+ slipAdd/,
    'core.buy still ignores opts.slipAddBps');
});

// ---------------------------------------------------------------- chosen by intent
test('getting OUT is urgent; taking profit is not', async () => {
  // One setting for all four types would either overpay on every take-profit or
  // underpay on every stop. They are different trades.
  assert.equal(watchers.orderSpeed({ type: 'sl' }), 'turbo');
  assert.equal(watchers.orderSpeed({ type: 'trail' }), 'turbo');
  assert.equal(watchers.orderSpeed({ type: 'tp' }), 'fast');
  assert.equal(watchers.orderSpeed({ type: 'limitbuy' }), 'fast');
  assert.ok(watchers.ORDER_SPEED.turbo.gasMult > watchers.ORDER_SPEED.fast.gasMult);
  assert.ok(watchers.ORDER_SPEED.fast.gasMult > watchers.ORDER_SPEED.normal.gasMult);
  assert.equal(watchers.ORDER_SPEED.normal.slipAddBps, 0, 'Normal must mean the user\'s own settings, untouched');
});

test('the user can override the default, and the override is what executes', async () => {
  const calls = await fire([{ type: 'sl', targetPriceEth: 0.001, sellPct: 100, speed: 'normal' }]);
  assert.deepEqual(calls[0].opts, watchers.ORDER_SPEED.normal,
    'an order set to Normal was still escalated — the setting does nothing');
});

test('an unknown speed falls back to the type default, it does not crash or go quiet', async () => {
  assert.equal(watchers.orderSpeed({ type: 'sl', speed: 'ludicrous' }), 'turbo');
  assert.equal(watchers.orderSpeed({ type: 'sl', speed: null }), 'turbo');
  assert.equal(watchers.orderSpeed({}), 'fast', 'an order with no type must still execute');
});

test('escalation only ever RAISES the user\'s own gas priority', async () => {
  // core.sell takes max(userGasBoost, opts.gasMult). Someone who runs Turbo
  // globally must not be quietly slowed down by an order set to Normal.
  const CORE = fs.readFileSync(path.join(__dirname, 'core.js'), 'utf8');
  assert.match(CORE, /Math\.max\(userGasBoost\(u\), \(opts && opts\.gasMult\) \|\| 1\)/g);
  assert.equal((CORE.match(/Math\.max\(userGasBoost\(u\), \(opts && opts\.gasMult\) \|\| 1\)/g) || []).length, 2,
    'both buy and sell must take the user setting as the floor');
});

// ---------------------------------------------------------------- the user is told
test('every order says how hard it will try to land', async () => {
  seed([
    { type: 'sl', targetPriceEth: 0.001, sellPct: 100 },
    { type: 'tp', targetPriceEth: 9, sellPct: 100 },
  ]);
  tg._test.PRICES.ETH = 1870;
  const t = tg._test.ordersScreen(CHAT).text.replace(/<[^>]+>/g, '');
  assert.match(t, /Turbo/, 'the stop-loss never says it will pay 3× gas');
  assert.match(t, /Fast/, 'the take-profit never says what it will pay');
  assert.match(t, /3× gas/, 'the cost of Turbo is not stated');
  assert.match(t, /slippage/, 'the slippage cost is not stated');
});

test('every order has a button to change its speed', async () => {
  seed([{ type: 'sl', targetPriceEth: 0.001, sellPct: 100 }]);
  const kb = tg._test.ordersScreen(CHAT).kb.inline_keyboard.flat();
  const b = kb.find((x) => (x.callback_data || '').startsWith('ospd:'));
  assert.ok(b, 'a default nobody can change is a default nobody can disagree with');
  assert.match(b.text, /Turbo/, 'the button must say where the setting stands now');
  assert.ok(kb.some((x) => (x.callback_data || '').startsWith('oc:')), 'cancel must survive alongside it');
});

// ---------------------------------------------------------------- market vs limit
test('the sell screen offers a limit and a stop, not only market presets', async () => {
  // "🎯 TP" lived on the token card. Someone who has decided to sell is on THIS
  // screen, and it gave them nothing but orders that fill immediately.
  seed([]);
  const realMeta = core.tokenMeta, realBal = core.tokenBalance, realSnap = core.tokenSnapshot;
  core.tokenMeta = async () => ({ sym: 'PONS', decimals: 18, name: 'Pons' });
  core.tokenBalance = async () => 75030000000000000000n;
  core.tokenSnapshot = async () => ({ sym: 'PONS', priceEth: 0.00001 });
  try {
    const s = await tg._test.sellMenu(CHAT, CA, 'robinhood', 'w1');
    const kb = s.kb.inline_keyboard.flat();
    assert.ok(kb.some((b) => (b.callback_data || '').startsWith('tp:')), 'no limit sell on the sell screen');
    assert.ok(kb.some((b) => (b.callback_data || '').startsWith('sl:')), 'no stop-loss on the sell screen');
    assert.ok(kb.some((b) => (b.callback_data || '').startsWith('s:')), 'the market presets must stay');
    // …and the two kinds are named, so a preset is not mistaken for a limit.
    const t = s.text.replace(/<[^>]+>/g, '');
    assert.match(t, /Market/, 'the presets are never identified as market orders');
    assert.match(t, /sell \*{0,2}now\*{0,2}|sell now/i, 'market is not explained as "fills immediately"');
    assert.match(t, /Limit/, 'the limit alternative is not named');
  } finally { core.tokenMeta = realMeta; core.tokenBalance = realBal; core.tokenSnapshot = realSnap; }
});

test('"Limit" on the token card says which side it is', async () => {
  // It set a limit BUY, and was labelled "⏳ Limit" next to four Sell buttons.
  const TG = fs.readFileSync(path.join(__dirname, 'telegram.js'), 'utf8');
  assert.match(TG, /btn\('⏳ Limit buy', `lb:/);
});
