'use strict';
/*
 * autoSnipeConsent.test.js — "saya belum set target dev atau ca snipe malah buy
 * ngasal".
 *
 * A user turned the COPY-TRADING master switch ON — no wallets followed, no CA
 * targets armed — and two minutes later the bot bought $GFrZ…pump twice, 0.0495
 * SOL each. From their seat: the bot spent money with no target set.
 *
 * What actually fired was AUTO-SNIPE: `u.snipe.chains.solana` armed with
 * `ethAmount = 0.05` (the buys were 0.05 minus the 1% fee — the default is
 * 0.01, so this was set through the UI at some point and forgotten). The copy
 * master switch is a different feature and touches none of it.
 *
 * The report still names a real defect, in three parts:
 *   1. Arming a buy-everything feature was SILENT — one tap on a toggle, no
 *      statement of what it does or what it will spend.
 *   2. The purchase message said "Sniped", which does not say WHICH of three
 *      snipe features fired — so an unexpected buy cannot be traced to its
 *      switch.
 *   3. The message carried no way to stop it — the user had to find the right
 *      screen while the bot kept buying.
 *
 * These tests pin the boundaries between the three features and the consent
 * moments. No network.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const CORE = fs.readFileSync(path.join(__dirname, 'core.js'), 'utf8');
const WATCH = fs.readFileSync(path.join(__dirname, 'watchers.js'), 'utf8');
const TG = fs.readFileSync(path.join(__dirname, 'telegram.js'), 'utf8');

// ── the boundaries: nothing arms auto-snipe but its own toggle ───────────────

test('the copy master switch writes copy.on and nothing else', () => {
  const fn = CORE.slice(CORE.indexOf('function setCopyOn('), CORE.indexOf('function setCopyOn(') + 400);
  assert.match(fn, /u\.copy\.on = !!on; saveStore\(\);/);
  assert.ok(!/snipe/.test(fn), 'the copy switch reaches into the snipe config');
});

test('arming a CA target never arms chain-wide auto-snipe', () => {
  const branch = TG.slice(TG.indexOf("if (p.action === 'ca_snipe')"), TG.indexOf("if (p.action === 'ca_snipe')") + 2400);
  assert.ok(branch.includes('core.addSnipeTarget'), 'the ca_snipe branch moved — this test is asserting nothing');
  assert.ok(!/setSnipeChain/.test(branch), 'arming one CA silently arms the buy-everything feature');
  const add = CORE.slice(CORE.indexOf('function addSnipeTarget('), CORE.indexOf('function addSnipeTarget(') + 1600);
  assert.ok(!/snipe\.chains/.test(add), 'addSnipeTarget writes the auto-snipe chain map');
});

test('auto-snipe fires ONLY on its own explicit per-chain flag', () => {
  // The armed filter is the whole gate. If this line ever weakens — an implicit
  // default, a master switch standing in for it — the reported incident becomes
  // the designed behaviour.
  assert.match(WATCH, /u\.snipe && u\.snipe\.chains && u\.snipe\.chains\.solana && Number\(u\.snipe\.ethAmount\) > 0/);
  // And the only writer of that flag is the explicit toggle.
  const writers = (CORE.match(/u\.snipe\.chains\[key\] = /g) || []).length;
  assert.strictEqual(writers, 1, `${writers} writers of the chain flag — one of them is not the toggle`);
});

// ── consent: arming is announced, with the blast radius ─────────────────────

test('arming always passes through an explicit amount choice, then states the blast radius', () => {
  // The flow was reordered on the owner's report ("intinya pertama disuruh
  // pilih chain dulu"): the chain tap no longer toggles ON — it opens Step 2,
  // the amount screen, and only picking an amount arms. That closes the other
  // half of the "buy ngasal" incident too: arming can no longer silently
  // reuse an amount set weeks earlier on a different screen.
  const h = TG.slice(TG.indexOf("if (k === 'sntog')"), TG.indexOf("if (k === 'snamtq')"));
  // The chain tap itself never arms — OFF stays a one-tap stop (it is the 🛑
  // button on every purchase message), ON routes to the amount step.
  assert.ok(!/setSnipeChain\([^)]*true\)/.test(h), 'the sntog tap arms a chain directly again');
  assert.match(h, /core\.setSnipeChain\(chatId, ca, false\)/);
  assert.match(h, /snipeAmountScreen\(chatId, ca\)/);
  // ONE arming site, and both amount paths (preset tap, ✏️ custom) go
  // through it — two sites would drift into two warnings.
  const arm = TG.slice(TG.indexOf('async function armAutoSnipe('), TG.indexOf('async function armAutoSnipe(') + 1600);
  assert.match(arm, /Auto-Snipe is now ARMED/);
  assert.match(arm, /every new launch/);
  // The SPEND is on the warning — 0.05 SOL per launch is a very different
  // decision from 0.01 — and it is the amount JUST chosen, not a stored one.
  assert.match(arm, /u\.snipe\.ethAmount/);
  // Only on ARM. A warning on disarm too would teach users the message is
  // furniture. And it reads the flag the setter RETURNS, not a stale copy.
  assert.match(arm, /if \(armedNow\)/);
  assert.match(arm, /const chains = core\.setSnipeChain\(chatId, chainKey, true\); armedNow = !!chains\[chainKey\]/);
  const callers = (TG.match(/return armAutoSnipe\(/g) || []).length;
  assert.strictEqual(callers, 2, `${callers} callers of armAutoSnipe — expected the preset tap and the custom-amount reply`);
});

// ── attribution: a message that spends money names its trigger ──────────────

test('every auto-snipe purchase names the feature and its blast radius', () => {
  const sites = (WATCH.match(/Auto-Snipe bought \$/g) || []).length;
  assert.strictEqual(sites, 3, `${sites} auto-snipe notify sites carry the label — expected the pump feed, the EVM scan and the Solana scan`);
  // The line that answers "why did my bot buy this": the feature is chain-wide
  // and target-less, said on the message itself.
  assert.strictEqual((WATCH.match(/buys EVERY new launch on this chain while armed/g) || []).length, 3);
  // No auto-snipe purchase message without it.
  assert.ok(!/<b>Sniped \$\$\{esc\((?:sym|r\.sym)\b/.test(WATCH), 'an auto-snipe site still says just "Sniped"');
});

test('every auto-snipe purchase carries the off switch', () => {
  assert.match(WATCH, /const _autoSnipeKb = \(chainKey\) => \(\{ inline_keyboard: \[\[\{ text: '🛑 Stop auto-snipe on this chain', callback_data: `sntog:\$\{chainKey\}` \}\]\] \}\)/);
  // `_autoSnipeKb\(` does not match the definition (`_autoSnipeKb = (`), so
  // this count is exactly the CALL sites — which is what must not shrink.
  assert.strictEqual((WATCH.match(/_autoSnipeKb\(/g) || []).length, 3, 'a purchase site lost its disarm button');
  // The callback it fires is the same sntog the settings screen uses, so the
  // button and the screen cannot disagree about what "off" means.
  assert.match(TG, /if \(k === 'sntog'\)/);
});

test('a CA-target fill is labelled as the user\'s own target, not as auto-snipe', () => {
  // The three features must be distinguishable from the message alone —
  // mislabelling a targeted fill as auto-snipe sends the user hunting for an
  // armed switch that does not exist.
  assert.match(WATCH, /CA snipe filled: \$/);
  assert.match(WATCH, /This was YOUR armed target\./);
});
