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

// ── the way a person actually arms one ───────────────────────────────────────

/** Drive the real Telegram text handler, not core directly. */
async function typed(text, chain = 'robinhood') {
  const tg = require('./telegram');
  const sent = [];
  const realFetch = global.fetch;
  global.fetch = async (url, opt) => {
    try { const b = JSON.parse(opt.body); if (/sendMessage/.test(String(url))) sent.push(b.text); } catch (_) {}
    return { json: async () => ({ ok: true, result: { message_id: 1 } }) };
  };
  try { await tg._test.resolvePending(CHAT, { action: 'ca_snipe', chain }, text, {}); }
  finally { global.fetch = realFetch; }
  return sent.join('\n').replace(/<[^>]+>/g, '');
}

test('typing a contract and an amount actually arms it', async () => {
  // EVERY TEST ABOVE CALLS core.addSnipeTarget DIRECTLY, and that is how the
  // handler shipped with its arguments reversed — `isAddrFor(chainKey, ca)`
  // instead of `isAddrFor(ca, chainKey)`. It type-checks, it is always false,
  // and it rejected every arm attempt with "not a valid contract address"
  // while the store underneath worked perfectly.
  const u = user();
  const out = await typed(`${CA} 0.05 25`);
  assert.match(out, /Armed/, `arming failed:\n${out}`);
  const armed = core.armedSnipeTargets(u);
  assert.equal(armed.length, 1);
  assert.equal(armed[0].amount, '0.05');
  assert.equal(armed[0].slipBps, 2500);
});

test('the slippage is optional and defaults to the user setting', async () => {
  const u = user();
  await typed(`${CA} 0.05`);
  assert.equal(core.armedSnipeTargets(u)[0].slipBps, 0);
});

test('a Solana mint arms through the handler on Solana', async () => {
  const u = user();
  const out = await typed(`${MINT} 0.5`, 'solana');
  assert.match(out, /Armed/, `arming a mint failed:\n${out}`);
  assert.equal(core.armedSnipeTargets(u)[0].chain, 'solana');
});

test('bad input is refused with a reason, and arms nothing', async () => {
  const u = user();
  assert.match(await typed('not-an-address 0.05'), /not a valid/i);
  assert.match(await typed(`${CA} 0`), /amount/i);
  assert.match(await typed(`${CA} 0.05 90`), /Slippage/i);
  assert.match(await typed(`${MINT} 0.05`), /not a valid/i);   // Solana mint, EVM chain
  assert.equal(core.armedSnipeTargets(u).length, 0, 'a rejected input still armed something');
});

// ── the probe budget ─────────────────────────────────────────────────────────

test('one contract is probed ONCE however many people are sniping it', async () => {
  // "Is this tradeable yet" is a fact about the chain, not about the user.
  // Probing per target made the busiest case — everyone armed on the same hot
  // address — the most expensive one, which is backwards; and on Solana it
  // multiplies a rate-limited aggregator call by the number of subscribers.
  core.DB.users = {};
  for (const id of [31, 32, 33, 34]) {
    const u = core.ensureUser(id);
    u.wallets = [{ id: 'w1', name: 'w', address: '0x' + '2'.repeat(40), positions: {}, orders: [], history: [] }];
    u.activeWalletId = 'w1';
    core.addSnipeTarget(id, { ca: CA, chain: 'robinhood', amount: 0.01 });
  }
  let probes = 0, buys = 0;
  const real = { can: core.canTradeNow, buy: core.buy };
  core.canTradeNow = async () => { probes++; return true; };
  core.buy = async (cid, ca, amt, chain) => { buys++; return { chain, native: 'ETH', ca, hash: '0x' + buys, spentEth: 0.01, gotTokens: 1, sym: 'P' }; };
  watchers.setNotifier(() => {});
  try { await watchers._test.caSnipeCycle(); } finally { core.canTradeNow = real.can; core.buy = real.buy; }
  assert.equal(probes, 1, `the same contract was probed ${probes} times for 4 users`);
  // …and every one of them still buys. They are separate wallets making
  // separate trades.
  assert.equal(buys, 4, `${buys} of 4 users were filled`);
});

test('Solana probes draw from their own, much tighter budget', () => {
  // Every other chain's probe is an RPC read against a node this bot already
  // hammers. Solana's is an aggregator quote against the SAME keyless host that
  // prices and builds every real buy — so the loop rate-limiting itself would
  // break ordinary trading, and do it invisibly, because canTradeNow returns a
  // boolean and a throttled probe is indistinguishable from "no pool yet".
  const SRC = fs.readFileSync(path.join(__dirname, 'watchers.js'), 'utf8');
  assert.match(SRC, /CA_SNIPE_SVM_PER_TICK/, 'Solana probes share the general budget');
  assert.match(SRC, /if \(g\.svm\) \{ if \(svmLeft <= 0\) continue; svmLeft--; \}/, 'the SVM budget is not enforced');
  // Skipping an over-budget group must still advance the cursor past it, or the
  // same groups are reconsidered first every tick and the ones behind them
  // never come up at all.
  assert.match(SRC, /_caSnipeCursor = groups\.length \? \(_caSnipeCursor \+ Math\.min\(groups\.length, CA_SNIPE_MAX_PROBES\)\) % groups\.length : 0;/,
    'the ring advances by what was taken, which starves the tail');
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

// ── "setingan sama kaya sol trading bot": TP/SL + expiry per target ──────────
//
// The reference panel arms a snipe with Snipe amount, Expiry time and TP/SL in
// one place. Ours is the same set on one LINE — <ca> <amount> [slip%] [tp/sl]
// [expiry h] — because a snipe's whole point is being ready before the pool
// opens, and five taps of config is five chances to still be typing.

test('a target carries its own TP/SL and expiry', () => {
  const u = user();
  const t = core.addSnipeTarget(u.chatId, { ca: MINT, chain: 'solana', amount: 0.05, tpPct: 100, slPct: 50, ttlMs: 12 * 3600000 });
  assert.strictEqual(t.tpPct, 100);
  assert.strictEqual(t.slPct, 50);
  assert.ok(Math.abs((t.expiresAt - t.createdAt) - 12 * 3600000) < 2000, 'the per-target expiry was ignored');
});

test('an impossible stop-loss is refused at ARM time, not discovered at fill', () => {
  const u = user();
  // SL is a percentage of a price: ≥100 can never fire.
  assert.throws(() => core.addSnipeTarget(u.chatId, { ca: MINT, chain: 'solana', amount: 0.05, slPct: 100 }), /below 100/);
  assert.throws(() => core.addSnipeTarget(u.chatId, { ca: MINT, chain: 'solana', amount: 0.05, tpPct: 200000 }), /0–100000/);
  // Omitted entirely → stored as undefined, not 0-that-looks-set.
  const t = core.addSnipeTarget(u.chatId, { ca: MINT, chain: 'solana', amount: 0.05 });
  assert.strictEqual(t.tpPct, undefined);
  assert.strictEqual(t.slPct, undefined);
});

test('the fill turns TP/SL into real orders at the REALISED entry', () => {
  const W = fs.readFileSync(path.join(__dirname, 'watchers.js'), 'utf8');
  const fill = W.slice(W.indexOf('CA snipe filled') - 1600, W.indexOf('CA snipe filled') + 400);
  // Entry from the trade itself — spent ÷ received — never the card price; a
  // snipe exists precisely because those differ at launch.
  assert.match(fill, /const entry = Number\(r\.spentEth\) \/ \(Number\(r\.gotTokens\) \|\| 1\);/);
  assert.match(fill, /targetPriceEth: entry \* \(1 \+ t\.tpPct \/ 100\)/);
  assert.match(fill, /targetPriceEth: entry \* \(1 - t\.slPct \/ 100\)/);
  // The BUY succeeded even if the exits could not be placed (order cap): that
  // must be SAID, or the user believes a stop-loss exists that does not.
  assert.match(fill, /Couldn't place the auto-exit/);
  // And both orders bind to the wallet that sniped, not whatever is active now.
  assert.strictEqual((fill.match(/, t\.walletId\)/g) || []).length, 2);
});

test('arming asks WHICH CHAIN first, and the answer travels with the pending step', () => {
  // "snipenya dari awal salah aturan, disuruh pilih chain mana dulu". The old
  // flow bound the target to whatever chain happened to be active — a Solana
  // mint pasted while Ethereum was active bounced as "not a valid contract
  // address", with the fix two screens away on 🌐.
  const TGs = fs.readFileSync(path.join(__dirname, 'telegram.js'), 'utf8');
  const add = TGs.slice(TGs.indexOf("if (data === 'csnadd')"), TGs.indexOf("if (data.startsWith('csnx:'))"));
  // ➕ renders a picker; the pending step is set only AFTER a chain is tapped.
  assert.match(add, /csnch:\$\{c\.key\}/);
  const pick = add.slice(add.indexOf("if (k === 'csnch')"));
  assert.match(pick, /setPending\(chatId, \{ action: 'ca_snipe', chain: ch\.key \}\)/);
  assert.ok(!add.slice(0, add.indexOf("if (k === 'csnch')")).includes('setPending'), 'csnadd still binds the target to the active chain before any chain was picked');
  // The example address in the prompt is chain-shaped — a Solana user shown
  // `0xabc…` copies the shape they were shown.
  assert.match(pick, /isSvm\(ch\.key\) \? 'Ge87Etsj…' : '0xabc…'/);
  // Dev snipe follows the same rule, offering ONLY the launchpad chains — so
  // the "switch chain with 🌐, then try again" dead end cannot come back.
  const dev = TGs.slice(TGs.indexOf("if (data === 'cpaddd')"), TGs.indexOf("if (k === 'cprm')"));
  assert.match(dev, /filter\(\(c\) => core\.canDevSnipe\(c\.key\)\)/);
  assert.match(dev, /setPending\(chatId, \{ action: 'copy_add', mode: 'launches', chain: ch\.key \}\)/);
  // And the parse step spends the PICKED chain, not whatever is active by the
  // time the user finishes typing.
  const parse = TGs.slice(TGs.indexOf("if (p.action === 'copy_add')"), TGs.indexOf("if (p.action === 'alert_price')"));
  assert.match(parse, /const ch = \(p\.chain && core\.chainOf\(p\.chain\)\) \|\| activeChain\(chatId\)/);
});

test('the copy screen links THROUGH to the CA snipe', () => {
  // Three features answer to the word "snipe" and two of them live on the Copy
  // screen's buttons. A user sent there by that word found no way to the CA
  // snipe and reported the feature as missing ("cuman seperti ini") — the
  // change WAS deployed; the path to it was not on the screen they were on.
  const TGs = fs.readFileSync(path.join(__dirname, 'telegram.js'), 'utf8');
  const scr = TGs.slice(TGs.indexOf('function copyScreen('), TGs.indexOf('function referralScreen('));
  assert.match(scr, /btn\('📍 Snipe one contract', 'csn'\)/);
  // And it must sit OUTSIDE the target-cap gate — navigation that vanishes
  // when the follow list is full is the same dead end one state later.
  const gated = scr.slice(scr.indexOf('list.length < core.MAX_COPY_TARGETS'), scr.indexOf('kbRows.push([btn(\'« Menu\''));
  const gateBlockEnd = gated.indexOf('}');
  assert.ok(!gated.slice(0, gateBlockEnd).includes("'csn'"), 'the CA-snipe cross-link is inside the copy-target cap gate');
});

test('the one-line parser accepts the panel fields and rejects the ambiguous', () => {
  const TGs = fs.readFileSync(path.join(__dirname, 'telegram.js'), 'utf8');
  const branch = TGs.slice(TGs.indexOf("if (p.action === 'ca_snipe')"), TGs.indexOf("if (p.action === 'ae_val')"));
  // tp/sl is ONE token with a slash — two bare numbers after the slippage would
  // be ambiguous with a fat-fingered second amount.
  assert.match(branch, /\^\(\\d\+\(\?:\\\.\\d\+\)\?\)\\\/\(\\d\+\(\?:\\\.\\d\+\)\?\)\$/);
  assert.match(branch, /slPct >= 100\) return send\(chatId, T\(chatId, 'snipe\.ca\.bad_tpsl'\)\)/);
  assert.match(branch, /ttlH < 1 \|\| ttlH > 168/);
  // The confirmation names the exits it armed — a config the bot accepted
  // silently is the auto-snipe lesson over again.
  assert.match(branch, /snipe\.ca\.exits/);
});
