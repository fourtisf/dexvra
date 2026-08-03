'use strict';
/*
 * Mirroring a followed wallet OUT of a position.
 *
 * The bot could follow a wallet in and never out — you took all of the downside
 * with none of its exit signal. This is the other half.
 *
 * Two decisions are load-bearing and both are the operator's, so they are pinned
 * here rather than left to read off the implementation:
 *
 *   • ANY selling by the target exits us COMPLETELY. They trim 10%, we are out.
 *     Never late, at the cost of leaving some runs early.
 *   • Only positions COPY bought are copy's to sell. A bag the user opened
 *     themselves is never touched, no matter what the followed wallet does with
 *     its own.
 *
 * The watcher reads the target's BALANCE rather than swap logs. The copy-BUY
 * detector matches a Transfer from the V2 pair, so it cannot see a sell through
 * a V3 pool, an aggregator, or a plain transfer out. Missing an entry costs an
 * opportunity; missing an exit costs the position.
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const test = require('node:test');
const assert = require('node:assert');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'copyexit-'));
process.env.WALLET_SECRET = 'w'.repeat(48);
process.env.TRADEBOT_TOKEN = 'x:y';
process.env.ENABLED_CHAINS = 'robinhood';

const core = require('./core');
const watchers = require('./watchers');

const CHAIN = 'robinhood';
const TOKEN = '0x' + 'de'.repeat(20);
const TARGET = '0x' + 'ab'.repeat(20);
const CHAT = 4242;

/** A user following TARGET, already copy-holding TOKEN, with the target's
 *  balance at that moment recorded as the baseline. */
function seed({ copySell = true, baseline = 1000n } = {}) {
  core.DB.users = {};
  const u = core.ensureUser(CHAT);
  u.copy = { on: true, targets: [{
    id: 'cp1', address: TARGET, chain: CHAIN, mode: 'trades',
    buyEth: '0.01', maxEth: '1', spentEth: 0.01,
    bought: { [TOKEN]: true }, holding: {}, copySell,
  }] };
  const t = u.copy.targets[0];
  if (baseline != null) t.holding[core.copyTokenKey(CHAIN, TOKEN)] = { bal: String(baseline), at: Date.now() };
  return { u, t };
}

/** Drive one exit cycle with the target's balance stubbed. Returns the sells. */
async function cycle(targetBal) {
  const sells = [];
  const realBal = core.tokenBalanceOrNull;
  const realSell = core.sell;
  core.tokenBalanceOrNull = async () => targetBal;
  core.sell = async (chatId, ca, pct, chain) => {
    sells.push({ chatId, ca, pct, chain });
    return { sym: 'DEAD', proceedsEth: 0.02, native: 'ETH', hash: '0x' + '1'.repeat(64), chain };
  };
  try { await watchers.copyExitCycle(); } finally { core.tokenBalanceOrNull = realBal; core.sell = realSell; }
  return sells;
}

// ---------------------------------------------------------------- the trigger
test('any real selling by the target exits us completely', async () => {
  const { t } = seed({ baseline: 1000n });
  const sells = await cycle(600n);              // they cut 40%
  assert.equal(sells.length, 1, 'the exit did not fire');
  assert.equal(sells[0].pct, 100, 'a partial exit must still take us all the way out');
  assert.equal(sells[0].ca, TOKEN);
  assert.equal(Object.keys(t.holding).length, 0, 'the position must leave the ledger');
});

test('a wallet emptying itself exits us too', async () => {
  seed({ baseline: 1000n });
  const sells = await cycle(0n);
  assert.equal(sells.length, 1);
  assert.equal(sells[0].pct, 100);
});

test('dust movement is not an exit', async () => {
  // Rounding, a fee, a tiny transfer — none of that is someone selling.
  seed({ baseline: 1000n });
  assert.deepEqual(await cycle(999n), [], 'a 0.1% change tripped the exit');
  assert.deepEqual(await cycle(950n), [], 'a 5% change tripped a 10% trigger');
});

test('the target buying MORE raises the bar instead of tripping it', async () => {
  // Otherwise the next comparison is against a stale, lower number and a normal
  // trim looks like a full exit.
  const { t } = seed({ baseline: 1000n });
  assert.deepEqual(await cycle(3000n), [], 'buying more must never sell');
  assert.equal(t.holding[core.copyTokenKey(CHAIN, TOKEN)].bal, '3000', 'the peak did not move');
  assert.deepEqual(await cycle(2800n), [], 'a 7% trim off the NEW peak is still not an exit');
  assert.equal((await cycle(2000n)).length, 1, 'a 33% cut off the new peak is');
});

// ---------------------------------------------------------------- safety
test('an unreadable balance is never mistaken for a sale', async () => {
  // The single most expensive confusion available here: a flaky RPC reading as
  // "they sold everything" would dump the user's whole position.
  seed({ baseline: 1000n });
  assert.deepEqual(await cycle(null), [], 'a failed read triggered a sell');
});

test('the exit mirror off means the bot never sells', async () => {
  const { t } = seed({ copySell: false, baseline: 1000n });
  assert.deepEqual(await cycle(0n), [], 'a disabled mirror still sold');
  assert.equal(Object.keys(t.holding).length, 1, '…and it must not forget the position either');
});

test('the master switch off stops exits as well as entries', async () => {
  const { u } = seed({ baseline: 1000n });
  u.copy.on = false;
  assert.deepEqual(await cycle(0n), []);
});

test('only what copy bought is copy’s to sell', async () => {
  // The user's own bags are not on the ledger, so nothing the followed wallet
  // does with its own can reach them.
  const { t } = seed({ baseline: null });     // nothing recorded as copy-bought
  assert.equal(Object.keys(t.holding).length, 0, 'setup');
  assert.deepEqual(await cycle(0n), [], 'copy sold a position it never opened');
});

test('a position is dropped from the ledger BEFORE the sell, so it cannot sell twice', async () => {
  // A crash between "decide to sell" and "sold" must not leave it eligible again.
  const { t } = seed({ baseline: 1000n });
  const realBal = core.tokenBalanceOrNull, realSell = core.sell;
  core.tokenBalanceOrNull = async () => 0n;
  let heldAtSellTime = null;
  core.sell = async () => { heldAtSellTime = Object.keys(t.holding).length; throw new Error('boom'); };
  try { await watchers.copyExitCycle(); } finally { core.tokenBalanceOrNull = realBal; core.sell = realSell; }
  assert.equal(heldAtSellTime, 0, 'the ledger still listed it while the sell was in flight');
  assert.equal(Object.keys(t.holding).length, 0, 'a failed sell must not re-arm the trigger');
});

// ---------------------------------------------------------------- migration
test('enabling this never reaches back into bags bought under the old rules', async () => {
  // Existing followed wallets get copySell on, but an EMPTY ledger — so the
  // mirror governs only what is copy-bought from here on. Retro-applying it
  // would auto-sell positions the user acquired when copy could only buy.
  core.DB.users = {};
  const u = core.ensureUser(CHAT);
  u.copy = { on: true, targets: [{ id: 'old', address: TARGET, chain: CHAIN, mode: 'trades',
    buyEth: '0.01', maxEth: '1', spentEth: 0.5, bought: { [TOKEN]: true }, cursor: 0 }] };
  delete core.DB.users[String(CHAT)];
  core.DB.users[String(CHAT)] = u;
  const migrated = core.ensureUser(CHAT).copy.targets[0];
  assert.equal(migrated.copySell, true, 'the mirror should be on for a followed wallet');
  assert.deepEqual(migrated.holding, {}, 'but it must start with nothing to sell');
  assert.deepEqual(await cycle(0n), [], 'a pre-existing bag was auto-sold on upgrade');
});
