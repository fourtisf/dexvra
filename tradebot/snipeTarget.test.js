'use strict';
/*
 * snipeTarget.test.js — "buy THIS contract the moment it can be bought", and
 * dev-wallet snipe on chains that previously refused it.
 *
 * WHAT WAS MISSING
 * The bot had two snipes and neither could express the most common request
 * there is. Auto-Snipe buys EVERY new launch on a chain. Dev snipe buys
 * whatever a followed wallet launches — and only on Robinhood and Solana,
 * because `canDevSnipe` refused every EVM chain on the grounds that there is no
 * cheap deployer signal there. Somebody who simply HAS the contract address
 * before the pool opens had nothing to use, on any chain.
 *
 * The money rules this file exists to hold, each one a way to spend twice:
 *   • a target is CLAIMED before the buy, and the claim is persisted
 *     synchronously — the poll runs every few seconds, so a target left armed
 *     while its buy is in flight is bought again by the next tick;
 *   • a buy that was BROADCAST is never re-armed, because it may still land;
 *   • a restart never resurrects a target that was mid-flight.
 *
 * Offline: no RPC, no Telegram. `core.canTradeNow` and `core.buy` are stubbed.
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const test = require('node:test');
const assert = require('node:assert');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'snipetarget-'));
process.env.WALLET_SECRET = 'w'.repeat(48);
process.env.TRADEBOT_TOKEN = 'x:y';
process.env.ENABLED_CHAINS = 'robinhood,solana';

const core = require('./core');
const watchers = require('./watchers');

const CA = '0x39dBED3a2bd333467115dE45665cC57F813C4571';
const MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const CHAT = 21;

function user() {
  core.DB.users = {};
  const u = core.ensureUser(CHAT);
  u.wallets = [{ id: 'w1', name: 'robin1', address: '0x' + '1'.repeat(40), positions: {}, orders: [], history: [] }];
  u.activeWalletId = 'w1';
  return u;
}

/** Run one caSnipe tick with `canTradeNow` and `buy` stubbed. */
async function tick({ tradeable = true, buy, notify = [] } = {}) {
  const real = { can: core.canTradeNow, buy: core.buy, sec: core.tokenSnapshot };
  core.canTradeNow = async () => tradeable;
  core.buy = buy || (async (cid, ca, amt, chain) => ({ chain, native: 'ETH', ca, hash: '0x' + 'a'.repeat(64), spentEth: Number(amt), gotTokens: 100, sym: 'PONS' }));
  watchers.setNotifier((chatId, text) => { notify.push(text); });
  try { await watchers._test.caSnipeCycle(); } finally {
    core.canTradeNow = real.can; core.buy = real.buy; core.tokenSnapshot = real.sec;
    watchers.setNotifier(() => {});
  }
  return notify;
}

// ── arming ───────────────────────────────────────────────────────────────────

test('a contract can be armed with its own amount and slippage', () => {
  user();
  const t = core.addSnipeTarget(CHAT, { ca: CA, chain: 'robinhood', amount: 0.05, slipBps: 2500 });
  assert.equal(t.status, 'armed');
  assert.equal(t.amount, '0.05');
  assert.equal(t.slipBps, 2500);
  assert.equal(t.walletId, 'w1');
  assert.ok(t.expiresAt > Date.now(), 'an armed target with no expiry polls forever');
});

test('slippage 0 means "whatever my setting is then", not "whatever it is now"', () => {
  user();
  const t = core.addSnipeTarget(CHAT, { ca: CA, chain: 'robinhood', amount: 0.05 });
  // Storing a COPY of the current global would silently freeze the target at
  // today's value, and a user who later widens their slippage would never see
  // it reach the snipe.
  assert.equal(t.slipBps, 0);
});

test('a Solana mint arms on Solana and a 0x address does not', () => {
  user();
  assert.ok(core.addSnipeTarget(CHAT, { ca: MINT, chain: 'solana', amount: 0.1 }));
  assert.throws(() => core.addSnipeTarget(CHAT, { ca: CA, chain: 'solana', amount: 0.1 }), /invalid Solana token mint/);
  assert.throws(() => core.addSnipeTarget(CHAT, { ca: MINT, chain: 'robinhood', amount: 0.1 }), /invalid contract address/);
});

test('the same contract cannot be armed twice on one chain', () => {
  user();
  core.addSnipeTarget(CHAT, { ca: CA, chain: 'robinhood', amount: 0.05 });
  assert.throws(() => core.addSnipeTarget(CHAT, { ca: CA.toLowerCase(), chain: 'robinhood', amount: 0.05 }), /already armed/);
});

test('finished targets do not count against the limit', () => {
  const u = user();
  const t = core.addSnipeTarget(CHAT, { ca: CA, chain: 'robinhood', amount: 0.05 });
  core.settleSnipeTarget(u, t.id, { ok: true, hash: '0x1' });
  // Making somebody delete their own receipts to arm the next snipe is the kind
  // of limit that reads as a bug.
  assert.equal(core.armedSnipeTargets(u).length, 0);
  assert.ok(core.addSnipeTarget(CHAT, { ca: CA, chain: 'robinhood', amount: 0.05 }));
});

// ── firing ───────────────────────────────────────────────────────────────────

test('an armed target buys the moment the contract is tradeable', async () => {
  const u = user();
  const t = core.addSnipeTarget(CHAT, { ca: CA, chain: 'robinhood', amount: 0.05, slipBps: 2500 });
  const seen = [];
  await tick({ buy: async (cid, ca, amt, chain, wid, opts) => { seen.push({ ca, amt, chain, wid, opts }); return { chain, native: 'ETH', ca, hash: '0xdead', spentEth: 0.05, gotTokens: 7, sym: 'PONS' }; } });
  assert.equal(seen.length, 1, 'a tradeable target did not fire');
  assert.equal(seen[0].amt, '0.05');
  assert.equal(seen[0].wid, 'w1', 'the snipe did not use the wallet it was armed on');
  // The per-target bound REPLACES the global one — that is the whole reason it
  // is stored per target.
  assert.equal(seen[0].opts.slipBps, 2500);
  assert.equal(core.snipeTargetById(u, t.id).status, 'done');
});

test('a target that is not tradeable yet is left alone', async () => {
  const u = user();
  const t = core.addSnipeTarget(CHAT, { ca: CA, chain: 'robinhood', amount: 0.05 });
  let bought = 0;
  await tick({ tradeable: false, buy: async () => { bought++; return {}; } });
  assert.equal(bought, 0, 'it bought a token that cannot be swapped');
  assert.equal(core.snipeTargetById(u, t.id).status, 'armed');
});

test('a target is claimed BEFORE the buy, so a second tick cannot buy it again', async () => {
  const u = user();
  core.addSnipeTarget(CHAT, { ca: CA, chain: 'robinhood', amount: 0.05 });
  let inFlight = null, buys = 0;
  const slowBuy = async (cid, ca, amt, chain) => {
    buys++;
    await new Promise((r) => setTimeout(r, 60));
    return { chain, native: 'ETH', ca, hash: '0x' + buys, spentEth: 0.05, gotTokens: 1, sym: 'P' };
  };
  const real = { can: core.canTradeNow, buy: core.buy };
  core.canTradeNow = async () => true;
  core.buy = slowBuy;
  watchers.setNotifier(() => {});
  try {
    inFlight = watchers._test.caSnipeCycle();     // first tick claims and starts buying
    await new Promise((r) => setTimeout(r, 10));
    await watchers._test.caSnipeCycle();          // second tick, while the buy is still in flight
    await inFlight;
  } finally { core.canTradeNow = real.can; core.buy = real.buy; watchers.setNotifier(() => {}); }
  // A missed snipe is a shrug; spending twice is not.
  assert.equal(buys, 1, `the same target was bought ${buys} times`);
});

test('a buy that was BROADCAST is never re-armed', async () => {
  const u = user();
  const t = core.addSnipeTarget(CHAT, { ca: CA, chain: 'robinhood', amount: 0.05 });
  await tick({ buy: async () => { const e = new Error('broadcast but not confirmed yet'); e.broadcast = true; e.sig = '0xbeef'; throw e; } });
  // It may still land. Re-arming would risk a second one for the same launch.
  assert.notEqual(core.snipeTargetById(u, t.id).status, 'armed');
});

test('a buy that clearly did not spend goes back on the shelf', async () => {
  const u = user();
  const t = core.addSnipeTarget(CHAT, { ca: CA, chain: 'robinhood', amount: 0.05 });
  await tick({ buy: async () => { throw new Error('the buy reverted on-chain — try again'); } });
  // A launch that reverted in its first block is exactly the one worth trying
  // again a second later.
  assert.equal(core.snipeTargetById(u, t.id).status, 'armed');
  assert.match(core.snipeTargetById(u, t.id).lastErr, /reverted/);
});

test('an empty wallet disarms instead of retrying forever', async () => {
  const u = user();
  const t = core.addSnipeTarget(CHAT, { ca: CA, chain: 'robinhood', amount: 0.05 });
  await tick({ buy: async () => { throw new Error('insufficient funds for gas'); } });
  assert.equal(core.snipeTargetById(u, t.id).status, 'failed');
});

test('an expired target stops polling and says so', async () => {
  const u = user();
  const t = core.addSnipeTarget(CHAT, { ca: CA, chain: 'robinhood', amount: 0.05 });
  core.snipeTargetById(u, t.id).expiresAt = Date.now() - 1;
  const notes = await tick({ tradeable: true });
  assert.equal(core.snipeTargetById(u, t.id).status, 'expired');
  assert.ok(notes.some((n) => /expired/i.test(n)), 'it expired silently');
});

test('a restart never resurrects a target that was mid-flight', () => {
  const u = user();
  const t = core.addSnipeTarget(CHAT, { ca: CA, chain: 'robinhood', amount: 0.05 });
  core.claimSnipeTarget(u, t.id);
  assert.equal(core.snipeTargetById(u, t.id).status, 'firing');
  // ensureUser runs the migration every load; a 'firing' target is one whose buy
  // may have been broadcast before the process died, and we cannot tell from
  // here.
  core.ensureUser(CHAT);
  assert.equal(core.snipeTargetById(u, t.id).status, 'failed');
});

// ── dev-wallet snipe, on every chain ─────────────────────────────────────────

test('dev-wallet snipe is no longer refused on EVM chains', () => {
  // It used to be Robinhood and Solana only. The reason given was that EVM has
  // no cheap deployer signal — true of the DEPLOYER, false of the wallet that
  // opens the pool, which the PairCreated scan already has in hand.
  for (const k of core.chains.enabledChains().map((c) => c.key)) {
    assert.ok(core.canDevSnipe(k), `${k} still refuses a dev-wallet follow`);
  }
  assert.ok(!core.canDevSnipe('not-a-chain'));
});

test('the EVM scan resolves who opened the pool, and only when someone is watching', () => {
  const SRC = fs.readFileSync(path.join(__dirname, 'watchers.js'), 'utf8');
  // Bounded by the NEXT top-level function, not by a named one: `snipeCycle` is
  // declared above this in the file, so slicing to it yields nothing and every
  // assertion below would pass against an empty string.
  const start = SRC.indexOf('async function _dexSnipeChain(');
  assert.ok(start > 0, '_dexSnipeChain is gone');
  const after = SRC.slice(start + 10);
  const end = after.indexOf('\nasync function ');
  const fn = SRC.slice(start, end > 0 ? start + 10 + end : SRC.length);
  // Gating the dev pass on `armed` is what kept it off every EVM chain even
  // after the chain check was relaxed: following one developer does not mean
  // wanting every launch on the chain.
  assert.match(fn, /if \(!armed\.length && !devFollowers\.length\) return;/, 'dev followers are still gated on auto-snipe being on');
  assert.match(fn, /if \(devFollowers\.length\) \{\s*\n\s*const dev = await _devFromPair\(prov, e\);/, 'the pool opener is resolved unconditionally');
  // The same _followerBuy the Robinhood and Solana paths call, so the three
  // chains cannot drift into three ideas of what a dev snipe does.
  assert.match(fn, /_followerBuy\(u, t, token, ch\.key\)/, 'the EVM path grew its own buy');
  assert.match(fn, /if \(devBoughtBy\.has\(u\.chatId\)\) return;/, 'a dev-sniped launch is also snipe-all bought');
});

test('an unreadable transaction cannot stop the snipe', async () => {
  const boom = { getTransaction: async () => { throw new Error('rpc down'); } };
  assert.equal(await watchers._test._devFromPair(boom, { transactionHash: '0x1' }), null);
  assert.equal(await watchers._test._devFromPair(boom, {}), null);
  const ok = { getTransaction: async () => ({ from: '0xAbCd' + '0'.repeat(36) }) };
  assert.equal(await watchers._test._devFromPair(ok, { transactionHash: '0x1' }), '0xabcd' + '0'.repeat(36));
});

// ── the probe ────────────────────────────────────────────────────────────────

test('a pair that exists but holds nothing is not tradeable', () => {
  // A deployed pair with no reserve is a contract waiting for liquidity, and
  // buying into it is how a snipe fills at an arbitrary price.
  const SRC = fs.readFileSync(path.join(__dirname, 'core.js'), 'utf8');
  const fn = SRC.slice(SRC.indexOf('async function canTradeNow('), SRC.indexOf('// Live token snapshot on a given chain'));
  assert.match(fn, /pick\.wethBal != null && pick\.wethBal > 0n/, 'an empty pair counts as tradeable');
  assert.match(fn, /return false;\s*\}\s*$/m, 'the probe can throw into the watcher');
});
