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
function seed({ copySell = true, baseline = 1000n, wid = 'wBUY' } = {}) {
  core.DB.users = {};
  const u = core.ensureUser(CHAT);
  u.wallets = [
    { id: 'wBUY', name: 'Buyer', address: '0x' + '11'.repeat(20), positions: {}, orders: [], history: [] },
    { id: 'wOTHER', name: 'Other', address: '0x' + '22'.repeat(20), positions: {}, orders: [], history: [] },
  ];
  u.activeWalletId = 'wOTHER';        // the user switched AFTER the copy-buy
  u.copy = { on: true, targets: [{
    id: 'cp1', address: TARGET, chain: CHAIN, mode: 'trades',
    buyEth: '0.01', maxEth: '1', spentEth: 0.01,
    bought: { [TOKEN]: true }, holding: {}, copySell,
  }] };
  const t = u.copy.targets[0];
  if (baseline != null) t.holding[core.copyTokenKey(CHAIN, TOKEN)] = { bal: String(baseline), at: Date.now(), wid, tries: 0 };
  return { u, t };
}

/** Drive one exit cycle. `targetBal` is what the followed wallet holds; `holders`
 *  maps our wallet id -> raw balance (null = unreadable). */
async function cycle(targetBal, { holders = { wBUY: 500n, wOTHER: 0n }, sellImpl } = {}) {
  const sells = [];
  const realBal = core.tokenBalanceOrNull;
  const realAcross = core.tokenBalancesAcross;
  const realSell = core.sell;
  core.tokenBalanceOrNull = async () => targetBal;
  core.tokenBalancesAcross = async (chatId) => (core.DB.users[String(chatId)].wallets || [])
    .map((w, i) => ({ id: w.id, index: i + 1, label: w.name, raw: holders[w.id] === undefined ? 0n : holders[w.id] }));
  core.sell = async (chatId, ca, pct, chain, walletId) => {
    sells.push({ chatId, ca, pct, chain, walletId });
    if (sellImpl) return sellImpl();
    return { sym: 'DEAD', proceedsEth: 0.02, native: 'ETH', hash: '0x' + '1'.repeat(64), chain };
  };
  try { await watchers.copyExitCycle(); }
  finally { core.tokenBalanceOrNull = realBal; core.tokenBalancesAcross = realAcross; core.sell = realSell; }
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

test('a position leaves the ledger BEFORE the sell, so a crash cannot sell it twice', async () => {
  const { t } = seed({ baseline: 1000n });
  let heldAtSellTime = null;
  await cycle(0n, { sellImpl: () => { heldAtSellTime = Object.keys(t.holding).length; throw new Error('boom'); } });
  assert.equal(heldAtSellTime, 0, 'the ledger still listed it while the sell was in flight');
});

// ---------------------------------------------------------------- the wallet
test('the exit sells from the wallet that BOUGHT, not from whatever is active', async () => {
  // The bug this pins: copy-buy and copy-sell each used the ACTIVE wallet, so a
  // user who switched wallets in between got "token balance is 0" on a bag they
  // were still holding — and the position was dropped from the ledger silently.
  const { u } = seed({ baseline: 1000n, wid: 'wBUY' });
  assert.equal(u.activeWalletId, 'wOTHER', 'setup: the active wallet is NOT the buyer');
  const sells = await cycle(0n, { holders: { wBUY: 500n, wOTHER: 0n } });
  assert.equal(sells.length, 1);
  assert.equal(sells[0].walletId, 'wBUY', 'the sell went to the wrong wallet');
});

test('if the pinned wallet no longer holds it, the exit finds the one that does', async () => {
  // The user moved the tokens, or removed that wallet. The position is still
  // theirs and still needs closing.
  seed({ baseline: 1000n, wid: 'wBUY' });
  const sells = await cycle(0n, { holders: { wBUY: 0n, wOTHER: 900n } });
  assert.equal(sells.length, 1);
  assert.equal(sells[0].walletId, 'wOTHER');
});

test('nobody holding it means nothing to sell, and no error', async () => {
  seed({ baseline: 1000n });
  assert.deepEqual(await cycle(0n, { holders: { wBUY: 0n, wOTHER: 0n } }), []);
});

// ---------------------------------------------------------------- retry
test('a failed exit is retried, not forgotten', async () => {
  // An exit that vanishes because one sell reverted is the worst outcome here:
  // the user holds a bag the bot promised to close and is told nothing.
  const { t } = seed({ baseline: 1000n });
  await cycle(0n, { sellImpl: () => { throw new Error('execution reverted'); } });
  const rec = t.holding[core.copyTokenKey(CHAIN, TOKEN)];
  assert.ok(rec, 'the position was dropped after a retriable failure');
  assert.equal(rec.tries, 1, 'the attempt was not counted');
  assert.equal(rec.wid, 'wBUY', 'the retry lost the wallet it must sell from');
});

test('a retry does not re-check the trigger — it is already committed to exiting', async () => {
  // Once we have decided to leave, the target's balance no longer matters. A
  // retry that re-ran the drop test would stall forever at a stable balance.
  const { t } = seed({ baseline: 1000n });
  await cycle(0n, { sellImpl: () => { throw new Error('execution reverted'); } });
  t.holding[core.copyTokenKey(CHAIN, TOKEN)].lastTryAt = 0;      // let the backoff pass
  const sells = await cycle(1000n);                              // target's balance back to full
  assert.equal(sells.length, 1, 'the retry did not fire');
});

test('after enough failures it gives up LOUDLY and says the bag is still yours', async () => {
  const { t } = seed({ baseline: 1000n });
  const msgs = [];
  watchers.setNotifier((chatId, text) => msgs.push(String(text)));
  const key = core.copyTokenKey(CHAIN, TOKEN);
  try {
    for (let i = 0; i < 6; i++) {
      if (t.holding[key]) t.holding[key].lastTryAt = 0;
      await cycle(0n, { sellImpl: () => { throw new Error('honeypot: cannot sell') } });
      if (!t.holding[key]) break;
    }
  } finally { watchers.setNotifier(() => {}); }
  assert.ok(!t.holding[key], 'it must stop retrying eventually');
  const gaveUp = msgs.find((m) => /gave up/i.test(m));
  assert.ok(gaveUp, `no give-up message was sent: ${msgs.join(' | ')}`);
  assert.match(gaveUp, /still hold this/i, 'the user must be told the bag is still theirs');
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

test('an unreadable WALLET set leaves the position on the ledger to retry', async () => {
  // The same class of bug as the target-balance read, one step further along:
  // "we could not check your wallets" and "you hold none of it" are different
  // answers, and collapsing them drops the position for good during a blip.
  const { t } = seed({ baseline: 1000n, wid: null });
  const key = core.copyTokenKey(CHAIN, TOKEN);
  const sells = await cycle(0n, { holders: { wBUY: null, wOTHER: null } });
  assert.deepEqual(sells, [], 'it sold on an unreadable wallet set');
  assert.ok(t.holding[key], 'the position was forgotten instead of retried');
});

test('a PARTIAL wallet read that finds nothing is still not proof', async () => {
  // One wallet answered "zero", the other did not answer at all. The holder may
  // be the one we could not reach.
  const { t } = seed({ baseline: 1000n, wid: null });
  const key = core.copyTokenKey(CHAIN, TOKEN);
  await cycle(0n, { holders: { wBUY: 0n, wOTHER: null } });
  assert.ok(t.holding[key], 'a partial read was treated as a confirmed zero');
});

test('a COMPLETE read showing zero everywhere does drop it — that IS proof', async () => {
  const { t } = seed({ baseline: 1000n, wid: null });
  const key = core.copyTokenKey(CHAIN, TOKEN);
  await cycle(0n, { holders: { wBUY: 0n, wOTHER: 0n } });
  assert.ok(!t.holding[key], 'a confirmed empty position must not linger');
});

// ---------------------------------------------------------------- Solana
//
// The exit path branches on chain kind in two places — reading the target's
// balance (splBalance vs balanceOf) and routing the sell (_sellSol vs the EVM
// path) — and the ledger key is CASE-SENSITIVE on Solana and case-insensitive on
// EVM. Each of those is a place the two chains can silently diverge.
const solana = require('./solana');
const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SOL_TARGET = 'So11111111111111111111111111111111111111112';

function seedSol({ baseline = 1000n } = {}) {
  core.DB.users = {};
  const u = core.ensureUser(CHAT);
  u.wallets = [{ id: 'wSOL', name: 'Sol', address: '0x' + '33'.repeat(20), positions: {}, orders: [], history: [] }];
  u.activeWalletId = 'wSOL';
  u.copy = { on: true, targets: [{
    id: 'cps', address: SOL_TARGET, chain: 'solana', mode: 'trades',
    buyEth: '0.5', maxEth: '5', spentEth: 0.5, bought: { [MINT]: true }, holding: {}, copySell: true,
  }] };
  const t = u.copy.targets[0];
  t.holding[core.copyTokenKey('solana', MINT)] = { bal: String(baseline), at: Date.now(), wid: 'wSOL', tries: 0 };
  return { u, t };
}

async function solCycle(targetRaw) {
  const sells = [];
  const realSpl = solana.splBalance;
  const realAcross = core.tokenBalancesAcross;
  const realSell = core.sell;
  solana.splBalance = async (conn, owner, mint) => {
    assert.equal(owner, SOL_TARGET, 'splBalance was called with the wrong owner');
    assert.equal(mint, MINT, 'splBalance was called with the wrong mint — the ledger key was mangled');
    return { raw: targetRaw, decimals: 6 };
  };
  core.tokenBalancesAcross = async () => [{ id: 'wSOL', index: 1, label: 'Sol', raw: 900n }];
  core.sell = async (chatId, ca, pct, chain, walletId) => {
    sells.push({ ca, pct, chain, walletId });
    return { sym: 'USDC', proceedsEth: 0.4, native: 'SOL', hash: 'SIGabc', chain };
  };
  try { await watchers.copyExitCycle(); }
  finally { solana.splBalance = realSpl; core.tokenBalancesAcross = realAcross; core.sell = realSell; }
  return sells;
}

test('Solana: the exit reads the SPL balance and routes the sell to the solana chain', async () => {
  seedSol({ baseline: 1000n });
  const sells = await solCycle(0n);
  assert.equal(sells.length, 1, 'the Solana exit did not fire');
  assert.equal(sells[0].chain, 'solana', 'the sell was routed to the wrong chain');
  assert.equal(sells[0].ca, MINT, 'the mint was mangled on the way to the sell');
  assert.equal(sells[0].pct, 100);
  assert.equal(sells[0].walletId, 'wSOL');
});

test('Solana: the mint keeps its case through the ledger', async () => {
  // base58 is case-SENSITIVE. Lowercasing it — which is correct for EVM — would
  // produce a mint that resolves to nothing, and the exit would read a zero
  // balance for every position and try to sell all of them.
  const { t } = seedSol();
  const key = Object.keys(t.holding)[0];
  assert.equal(key, MINT, 'the Solana ledger key was lowercased');
  assert.notEqual(key, MINT.toLowerCase());
  assert.equal(core.copyTokenKey('solana', MINT), MINT);
  assert.equal(core.copyTokenKey('ethereum', '0xAbCd'), '0xabcd', 'EVM keys must still normalise');
});

test('Solana: dust and unreadable balances behave the same as on EVM', async () => {
  seedSol({ baseline: 1000n });
  assert.deepEqual(await solCycle(980n), [], 'a 2% change tripped the Solana exit');
  seedSol({ baseline: 1000n });
  assert.deepEqual(await solCycle(null), [], 'an unreadable SPL balance was read as a sale');
});
