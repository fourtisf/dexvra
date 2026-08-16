'use strict';
/*
 * stalePeak.test.js — a rug alert on a token that had not rugged.
 *
 * A live report, 2026-08-16. Five wallets bought $Ge87…pump at 22:41 — 0.01312
 * SOL each, entry $0.00724, MC $7.25M. One minute later, at 22:42, the bot sent
 * this four times over:
 *
 *     ⚠️ Possible rug / dump: $Ge87…pump
 *     Value fell to ≈ 0.0131 SOL from a peak of ≈ 0.1004. Check the chart /
 *     your safety.
 *
 * NOTHING HAD DUMPED. 0.0131 is one wallet's brand-new bag, priced at the price
 * it was just bought at. 0.1004 was a holding in the SAME wallet that had
 * already been sold — the position record survives being sold to zero, because
 * it is what carries the lifetime ethIn/ethOut, and `peakValueEth` rode along
 * with it.
 *
 * The threshold makes it inevitable rather than unlucky: POS_RUG_DROP is 0.15,
 * and 0.0131 ≤ 0.1004 × 0.15 = 0.01506. It fires on the first tick after the
 * buy, every time, for anyone buying back into a token they once held bigger.
 *
 * THE RESET EXISTED — in `_buyEvm` only. `_buySol` never had it, so the bug was
 * Solana-only, which is where the memecoins are. It is one function now, called
 * from both, because the next chain would have made it three.
 *
 * The second defect is in the same screenshot: FOUR copies. A position record is
 * per wallet, so a five-wallet bag sent five identical warnings, each quoting a
 * fifth of the holding as if it were the holding.
 *
 * No network, no RPC.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const CORE = fs.readFileSync(path.join(__dirname, 'core.js'), 'utf8');
const WATCH = fs.readFileSync(path.join(__dirname, 'watchers.js'), 'utf8');

// ── The arithmetic that made it certain ──────────────────────────────────────

test('the reported alert could not have failed to fire', () => {
  const RUG_DROP = 0.15;          // POS_RUG_DROP default
  const RUG_MIN_PEAK = 0.02;      // a "meaningful" peak; the stale one clears it
  const value = 0.0131, peak = 0.1004;
  assert.ok(peak >= RUG_MIN_PEAK, 'the stale peak was too small to arm the alert');
  assert.ok(value <= peak * RUG_DROP, `${value} > ${(peak * RUG_DROP).toFixed(5)} — the numbers do not reproduce`);
  // And with the peak reset, the same buy is nowhere near it: a fresh bag's peak
  // IS its own value, so the ratio is 1.0.
  assert.ok(!(value <= value * RUG_DROP), 'a freshly reset peak still trips the alert');
});

// ── The reset ────────────────────────────────────────────────────────────────

test('one owner of the reset, called by every buy path', () => {
  assert.match(CORE, /function _resetRiskIfFresh\(p\) \{/);
  const calls = CORE.match(/_resetRiskIfFresh\(p\);/g) || [];
  assert.strictEqual(calls.length, 2, `${calls.length} call site(s) — a buy path is not resetting the peak`);
  // Specifically: BOTH of them, named, so a future refactor cannot quietly drop
  // the Solana one again — which is the exact way this bug existed.
  const sol = CORE.slice(CORE.indexOf('async function _buySol('), CORE.indexOf('async function _sellSol('));
  const evm = CORE.slice(CORE.indexOf('async function buy(chatId,'), CORE.indexOf('async function sell(chatId,'));
  assert.match(sol, /_resetRiskIfFresh\(p\);/, 'the Solana buy does not reset the peak — this is the reported bug');
  assert.match(evm, /_resetRiskIfFresh\(p\);/, 'the EVM buy stopped resetting the peak');
});

test('it resets only a bag that is genuinely fresh', () => {
  const fn = CORE.slice(CORE.indexOf('function _resetRiskIfFresh(p)'), CORE.indexOf('function _resetRiskIfFresh(p)') + 900);
  // Adding to a LIVE position must keep its history: a bag that really did peak
  // and is on its way down is exactly what the alert is for, and averaging down
  // into it must not silence the warning.
  assert.match(fn, /if \(!\(p\.closed \|\| prevHeld <= 0n\)\) return;/);
  assert.match(fn, /p\.peakValueEth = 0;/);
  assert.match(fn, /delete p\.notified\.rug;/);
  // The auto-protect cooldown too. A stale `protectAt` SUPPRESSES a real rescue
  // on the new position — the same defect with the loss reversed.
  assert.match(fn, /delete p\.notified\.protectAt;/);
  assert.match(fn, /delete p\.notified\.protectCheckAt;/);
});

test('the reset runs before anything reads the position', () => {
  // After `p.tokens = after.toString()` it would see the NEW bag and never fire,
  // which is the same as not having it.
  for (const [name, from, to] of [
    ['sol', 'async function _buySol(', 'async function _sellSol('],
    ['evm', 'async function buy(chatId,', 'async function sell(chatId,'],
  ]) {
    const body = CORE.slice(CORE.indexOf(from), CORE.indexOf(to));
    const iReset = body.indexOf('_resetRiskIfFresh(p);');
    const iWrite = body.indexOf('p.tokens =');
    assert.ok(iReset > -1 && iWrite > -1, `${name}: markers missing`);
    assert.ok(iReset < iWrite, `${name}: the reset reads the bag it was meant to test`);
  }
});

// ── One token, one alert ─────────────────────────────────────────────────────

// Anchored FORWARD from the rug comment: `snapOf.report()` appears in an earlier
// cycle too, and a bare indexOf found that one and sliced backwards to nothing.
const _RUG0 = WATCH.indexOf('// rug/dump: value fell to');
const RUG = WATCH.slice(_RUG0, WATCH.indexOf('snapOf.report();', _RUG0));

test('five wallets holding one token send ONE warning', () => {
  assert.ok(RUG.length > 300, 'the rug block moved — this test is asserting nothing');
  assert.match(RUG, /for \(const wx of core\.walletList\(u\)\)/);
  // Marked on EVERY wallet, not just skipped once: left unmarked, the next
  // wallet in this very cycle trips the same condition and sends it again.
  assert.match(RUG, /q\.notified\.rug = true;/);
});

test('the numbers describe the whole holding, not one fifth of it', () => {
  // Each of the four copies quoted 0.0131 — one wallet's bag — as if it were the
  // position. The totals cost no extra request: the other bags are in memory and
  // the price is the snapshot already read.
  assert.match(RUG, /totVal \+= Number\(ethers\.formatUnits\(hr, q\.dec \|\| 18\)\) \* snap\.priceEth;/);
  assert.match(RUG, /totPeak \+= Number\(q\.peakValueEth\) \|\| 0;/);
  assert.match(RUG, /Value fell to ≈ <b>\$\{totVal\.toFixed\(4\)\}/);
  assert.match(RUG, /from a peak of ≈ \$\{totPeak\.toFixed\(4\)\}/);
  // A total that came out empty falls back to the position that tripped it —
  // a warning with a blank in it is worse than a warning about one wallet.
  assert.match(RUG, /if \(!\(totVal > 0\) \|\| !\(totPeak > 0\)\) \{ totVal = valueEth; totPeak = p\.peakValueEth; nWal = 1; \}/);
  // And it says how many wallets it is talking about, or the reader cannot tell
  // this total from a single-wallet one.
  assert.match(RUG, /across \$\{nWal\} wallets/);
});
