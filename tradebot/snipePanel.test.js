'use strict';
/*
 * snipePanel.test.js — the 🎛 Snipe Setup panel ("saya ingin fitur snipe sama
 * seperti sol trading bot ada setingan lengkap buat semudah mungkin").
 *
 * The panel is a persisted DRAFT rendered as tappable rows over the SAME
 * target store as the one-line arm. The money rules this file holds:
 *
 *   • a draft never spends and never arms by itself — only ⚡ does, and it
 *     goes THROUGH addSnipeTarget, the single owner of what a valid target is;
 *   • the amount has NO default — the "buy ngasal" incident was an amount set
 *     weeks earlier on another screen, silently reused;
 *   • a REFUSED arm keeps the draft, so the user fixes one row, not seven;
 *   • a chain switch drops a target address that cannot exist on the new
 *     chain — keeping it would be the wrong-chain bounce one screen later.
 *
 * Offline: no RPC, no Telegram. The Telegram driver stubs global.fetch.
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const test = require('node:test');
const assert = require('node:assert');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'snipepanel-'));
process.env.WALLET_SECRET = 'w'.repeat(48);
process.env.TRADEBOT_TOKEN = 'x:y';
process.env.ENABLED_CHAINS = 'robinhood,solana';

const core = require('./core');
const tg = require('./telegram');
const watchers = require('./watchers');

const CA = '0x39dBED3a2bd333467115dE45665cC57F813C4571';
const CA2 = '0x' + 'b'.repeat(40);
const MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const CHAT = 77;

function user() {
  core.DB.users = {};
  const u = core.ensureUser(CHAT);
  u.wallets = [
    { id: 'w1', name: 'utama', address: '0x' + '1'.repeat(40), positions: {}, orders: [], history: [] },
    { id: 'w2', name: '', address: '0x' + '2'.repeat(40), positions: {}, orders: [], history: [] },
  ];
  u.activeWalletId = 'w1';
  u.snipeDraft = null;
  return u;
}

/** Drive the real Telegram text handler with a pending step — a bare action
 *  name, or a full pending object for mid-wizard steps. */
async function typed(action, text) {
  const sent = [];
  const realFetch = global.fetch;
  global.fetch = async (url, opt) => {
    try { const b = JSON.parse(opt.body); if (/sendMessage/.test(String(url))) sent.push(b.text); } catch (_) {}
    return { json: async () => ({ ok: true, result: { message_id: 1 } }) };
  };
  try { await tg._test.resolvePending(CHAT, typeof action === 'string' ? { action } : action, text, {}); }
  finally { global.fetch = realFetch; }
  return sent.join('\n');
}

// ── the draft ────────────────────────────────────────────────────────────────

test('a new draft starts on the user chain and active wallet, with NO amount', () => {
  const u = user();
  const d = core.newSnipeDraft(CHAT);
  assert.equal(d.chain, core.userChain(u));
  assert.equal(d.walletId, 'w1');
  // The "buy ngasal" rule: spending is an explicit choice every time. A draft
  // with a default amount is an amount set by nobody.
  assert.strictEqual(d.amount, null);
  assert.strictEqual(d.ca, null);
  assert.equal(d.slipPct, 0);
  assert.equal(d.tpPct, 0);
  assert.equal(d.slPct, 0);
  assert.equal(d.ttlH, core.SNIPE_DRAFT_TTL_H);
});

test('every row is bounded exactly like addSnipeTarget, and a refused patch changes nothing', () => {
  user();
  core.newSnipeDraft(CHAT);
  assert.throws(() => core.updateSnipeDraft(CHAT, { slipPct: 90 }), /0–50/);
  assert.throws(() => core.updateSnipeDraft(CHAT, { slPct: 100 }), /below 100/);
  assert.throws(() => core.updateSnipeDraft(CHAT, { tpPct: 200000 }), /0–100000/);
  assert.throws(() => core.updateSnipeDraft(CHAT, { ttlH: 0 }), /1–168/);
  assert.throws(() => core.updateSnipeDraft(CHAT, { ttlH: 200 }), /1–168/);
  assert.throws(() => core.updateSnipeDraft(CHAT, { amount: 0 }), /> 0/);
  assert.throws(() => core.updateSnipeDraft(CHAT, { walletId: 'nope' }), /no such wallet/);
  assert.throws(() => core.updateSnipeDraft(CHAT, { chain: 'ethereum' }), /not enabled/);
  const d = core.snipeDraft(core.ensureUser(CHAT));
  assert.strictEqual(d.amount, null);
  assert.equal(d.slipPct, 0);
  assert.equal(d.walletId, 'w1');
});

test('a Solana mint is refused on an EVM chain row, and vice versa', () => {
  user();
  core.newSnipeDraft(CHAT);
  core.updateSnipeDraft(CHAT, { chain: 'robinhood' });
  assert.throws(() => core.updateSnipeDraft(CHAT, { ca: MINT }), /invalid contract address/);
  core.updateSnipeDraft(CHAT, { chain: 'solana' });
  assert.throws(() => core.updateSnipeDraft(CHAT, { ca: CA }), /invalid Solana token mint/);
});

test('switching chains DROPS a target that cannot exist there, keeps one that can', () => {
  user();
  core.newSnipeDraft(CHAT);
  core.updateSnipeDraft(CHAT, { chain: 'robinhood', ca: CA });
  // EVM → Solana: a 0x address cannot be a mint. Keeping it would be the
  // wrong-chain bounce one screen later; silence would read as the bot losing
  // the address (the caller renders the note).
  let d = core.updateSnipeDraft(CHAT, { chain: 'solana' });
  assert.strictEqual(d.ca, null);
  core.updateSnipeDraft(CHAT, { ca: MINT });
  d = core.updateSnipeDraft(CHAT, { chain: 'robinhood' });
  assert.strictEqual(d.ca, null);
  // Same-shape switch keeps the address.
  core.updateSnipeDraft(CHAT, { ca: CA2 });
  d = core.updateSnipeDraft(CHAT, { chain: 'robinhood' });
  assert.equal(d.ca, CA2);
});

// ── arming ───────────────────────────────────────────────────────────────────

test('a draft never arms by itself — filling every row creates no target', () => {
  const u = user();
  core.newSnipeDraft(CHAT);
  core.updateSnipeDraft(CHAT, { chain: 'robinhood', ca: CA, amount: 0.05, slipPct: 25, tpPct: 100, slPct: 50, ttlH: 12 });
  assert.equal(core.armedSnipeTargets(u).length, 0, 'updating the panel armed a snipe');
});

test('⚡ refuses a panel with no target or no amount, and says WHICH row is missing', () => {
  const u = user();
  core.newSnipeDraft(CHAT);
  assert.throws(() => core.armSnipeDraft(CHAT), /no target/i);
  core.updateSnipeDraft(CHAT, { ca: CA });
  assert.throws(() => core.armSnipeDraft(CHAT), /no amount/i);
  // A refused arm keeps the draft — the user fixes one row, not seven.
  const d = core.snipeDraft(u);
  assert.ok(d && d.ca === CA, 'a refused arm discarded the draft');
  assert.equal(core.armedSnipeTargets(u).length, 0);
});

test('⚡ arms THROUGH addSnipeTarget with every panel row mapped, then clears the draft', () => {
  const u = user();
  core.newSnipeDraft(CHAT);
  core.updateSnipeDraft(CHAT, { chain: 'robinhood', ca: CA, walletId: 'w2', amount: 0.05, slipPct: 25, tpPct: 100, slPct: 50, ttlH: 12 });
  const t = core.armSnipeDraft(CHAT);
  assert.equal(t.status, 'armed');
  assert.equal(t.chain, 'robinhood');
  assert.equal(t.ca, CA);
  assert.equal(t.amount, '0.05');
  assert.equal(t.slipBps, 2500);
  assert.equal(t.tpPct, 100);
  assert.equal(t.slPct, 50);
  assert.equal(t.walletId, 'w2', 'the snipe did not bind to the wallet picked on the panel');
  assert.ok(Math.abs((t.expiresAt - t.createdAt) - 12 * 3600000) < 2000, 'the panel expiry was ignored');
  assert.strictEqual(core.snipeDraft(u), null, 'an armed draft must not linger and re-arm');
});

test('an arm addSnipeTarget refuses (already armed) leaves the draft intact', () => {
  const u = user();
  core.addSnipeTarget(CHAT, { ca: CA, chain: 'robinhood', amount: 0.05 });
  core.newSnipeDraft(CHAT);
  core.updateSnipeDraft(CHAT, { chain: 'robinhood', ca: CA, amount: 0.1 });
  assert.throws(() => core.armSnipeDraft(CHAT), /already armed/);
  assert.ok(core.snipeDraft(u), 'the draft was discarded on a refused arm');
  assert.equal(core.armedSnipeTargets(u).length, 1, 'the refused arm still created a target');
});

test('a chain disabled AFTER the draft was written is refused, never silently swapped', () => {
  const u = user();
  core.newSnipeDraft(CHAT);
  core.updateSnipeDraft(CHAT, { chain: 'robinhood', ca: CA, amount: 0.05 });
  // Simulate ENABLED_CHAINS changing under a stored draft. addSnipeTarget
  // would fall back to the ACTIVE chain — right for a typed line, silently
  // wrong-chain for a panel whose chain row is the first thing on screen.
  core.snipeDraft(u).chain = 'ethereum';
  assert.throws(() => core.armSnipeDraft(CHAT), /disabled/);
});

// ── restarts ─────────────────────────────────────────────────────────────────

test('a restart keeps a half-configured panel and normalizes garbage', () => {
  const u = user();
  core.newSnipeDraft(CHAT);
  core.updateSnipeDraft(CHAT, { ca: CA, slipPct: 25 });
  core.ensureUser(CHAT);   // the migration pass every load runs
  assert.equal(core.snipeDraft(u).ca, CA, 'a restart lost the draft');
  u.snipeDraft = 'garbage';
  core.ensureUser(CHAT);
  assert.strictEqual(core.snipeDraft(u), null, 'a corrupt draft survived the migration');
});

// ── the panel screen ─────────────────────────────────────────────────────────

test('required rows read ⏳ until set and ✅ after — the reference STATUS column', () => {
  user();
  core.newSnipeDraft(CHAT);
  const before = tg._test.snipeSetupScreen(CHAT).text;
  assert.ok(before.includes('⏳'), 'an unset required row shows no waiting state');
  core.updateSnipeDraft(CHAT, { chain: 'robinhood', ca: CA, amount: 0.05 });
  const after = tg._test.snipeSetupScreen(CHAT).text.replace(/<[^>]+>/g, '');
  assert.ok(!after.includes('⏳'), 'a fully configured panel still says waiting');
  assert.ok(after.includes(CA), 'the target address is not on the panel');
  assert.ok(after.includes('0.05'), 'the amount is not on the panel');
});

test('the keyboard is label + value per row, and ⚡ is on it', () => {
  user();
  core.newSnipeDraft(CHAT);
  const kb = tg._test.snipeSetupScreen(CHAT).kb.inline_keyboard;
  // Two buttons a row, both opening the same editor — the reference's
  // two-column table, with no wrong half to tap.
  const chainRow = kb[0];
  assert.equal(chainRow.length, 2);
  assert.equal(chainRow[0].callback_data, 'snw:chain');
  assert.equal(chainRow[1].callback_data, 'snw:chain');
  const flat = kb.flat().map((b) => b.callback_data);
  for (const cb of ['snw:ca', 'snw:wal', 'snw:amt', 'snw:slip', 'snw:tpsl', 'snw:ttl', 'snw:arm', 'snw:cancel', 'csnadd']) {
    assert.ok(flat.includes(cb), `the panel keyboard lost ${cb}`);
  }
});

test('the sniper home offers the panel FIRST, the one-line arm second', () => {
  user();
  const kb = tg._test.caSnipeScreen(CHAT).kb.inline_keyboard;
  assert.equal(kb[0][0].callback_data, 'snw:open');
  assert.equal(kb[1][0].callback_data, 'csnadd');
});

test('🎯 Snipe and /snipe open the sniper HOME, not the buy-everything screen', () => {
  // "masih sama aja, setinganya bukan yang saya inginkan": the panel shipped,
  // but the menu's 🎯 Snipe still opened the mass-mode screen — and the user,
  // hunting for the sniper there, armed a 0.1 SOL buy-every-launch instead.
  // The word "snipe" means "snipe THIS token"; mass mode is a labelled choice.
  const SRC = fs.readFileSync(path.join(__dirname, 'telegram.js'), 'utf8');
  assert.match(SRC, /if \(data === 'snipe'\) \{ const s = caSnipeScreen\(chatId\)/, "the menu's 🎯 Snipe reverted to mass mode");
  assert.match(SRC, /if \(data === 'snmass'\) \{ const s = snipeScreen\(chatId\)/, 'mass mode lost its own route');
  assert.match(SRC, /text === '\/snipe' \|\| text === '\/sniper'\) \{ const s = caSnipeScreen/, '/snipe reverted to mass mode');
});

test('the home SAYS when mass mode is armed — money state is never two screens away', () => {
  const u = user();
  u.snipe.chains = { solana: true };
  u.snipe.ethAmount = '0.1';
  const s = tg._test.caSnipeScreen(CHAT);
  assert.match(s.text.replace(/<[^>]+>/g, ''), /0\.1/, 'the per-launch spend is not on the home');
  const buttons = s.kb.inline_keyboard.flat();
  const mass = buttons.find((b) => b.callback_data === 'snmass');
  assert.ok(mass, 'no way from the home to mass mode');
  assert.match(mass.text, /🟢/, 'an armed mass mode looks the same as an idle one');
  assert.match(mass.text, /0\.1/, 'the armed button hides the spend');
  assert.ok(buttons.some((b) => b.callback_data === 'cpaddd'), 'no way from the home into the dev-snipe wizard');
  // …and idle reads idle, or the green dot means nothing.
  u.snipe.chains = {};
  const idle = tg._test.caSnipeScreen(CHAT).kb.inline_keyboard.flat().find((b) => b.callback_data === 'snmass');
  assert.ok(!/🟢/.test(idle.text), 'an idle mass mode still shows the armed dot');
});

test('the amount editor offers the CHAIN\'s presets, not another coin\'s', () => {
  user();
  core.newSnipeDraft(CHAT);
  core.updateSnipeDraft(CHAT, { chain: 'solana' });
  const kb = tg._test.snwAmountScreen(CHAT).kb.inline_keyboard;
  const labels = kb.flat().map((b) => b.text).join(' ');
  // Solana's presets (0.1…2 SOL) — 0.01 of one coin is not 0.01 of another,
  // and the sub-dollar ETH ladder was exactly the dust-trade defect.
  assert.match(labels, /0\.1 SOL/);
  assert.ok(!/0\.01 SOL/.test(labels), 'the ETH-denominated ladder leaked onto Solana');
});

test('the ⚡ handler goes through core.armSnipeDraft and never around it', () => {
  const SRC = fs.readFileSync(path.join(__dirname, 'telegram.js'), 'utf8');
  const block = SRC.slice(SRC.indexOf("if (k === 'snw')"), SRC.indexOf("if (data === 'rstog')"));
  assert.match(block, /core\.armSnipeDraft\(chatId\)/, '⚡ no longer arms through the draft');
  assert.ok(!block.includes('addSnipeTarget'), 'the panel grew a second arming site around armSnipeDraft');
  assert.ok(!block.includes('addCopyTarget'), 'the panel arms dev targets around armSnipeDraft');
  // No toast on failure: the panel re-renders with the reason IN it, where the
  // row to fix is one tap away. A toast disappears; the row stays.
  assert.match(block, /snipeSetupScreen\(chatId, String\(\(e && e\.message\) \|\| e\)\)/);
});

// ── the Target paste ─────────────────────────────────────────────────────────

test('pasting a full one-line arm into the Target step fills EVERY panel row', async () => {
  const u = user();
  core.newSnipeDraft(CHAT);
  core.updateSnipeDraft(CHAT, { chain: 'robinhood' });
  await typed('snw_ca', `${CA} 0.05 25 100/50 12`);
  const d = core.snipeDraft(u);
  assert.equal(d.ca, CA);
  assert.equal(d.amount, '0.05');
  assert.equal(d.slipPct, 25);
  assert.equal(d.tpPct, 100);
  assert.equal(d.slPct, 50);
  assert.equal(d.ttlH, 12);
  assert.equal(core.armedSnipeTargets(u).length, 0, 'a pasted line armed without ⚡');
});

test('a bare address fills only the Target row and leaves the rest alone', async () => {
  const u = user();
  core.newSnipeDraft(CHAT);
  core.updateSnipeDraft(CHAT, { chain: 'robinhood', slipPct: 10 });
  await typed('snw_ca', CA);
  const d = core.snipeDraft(u);
  assert.equal(d.ca, CA);
  assert.strictEqual(d.amount, null, 'a bare address invented an amount');
  assert.equal(d.slipPct, 10, 'a bare address reset a configured row');
});

test('a mint pasted under an EVM row switches the chain when the shape is unambiguous', async () => {
  const u = user();
  core.newSnipeDraft(CHAT);
  core.updateSnipeDraft(CHAT, { chain: 'robinhood' });
  const out = await typed('snw_ca', MINT);
  const d = core.snipeDraft(u);
  assert.equal(d.chain, 'solana', 'the wrong-chain bounce is back');
  assert.equal(d.ca, MINT);
  // …and says so — a chain that moves silently is a setting the user cannot explain.
  assert.match(out.replace(/<[^>]+>/g, ''), /Solana/);
});

test('a bad paste is refused with a reason and the draft is untouched', async () => {
  const u = user();
  core.newSnipeDraft(CHAT);
  core.updateSnipeDraft(CHAT, { chain: 'robinhood' });
  const out = await typed('snw_ca', 'not-an-address 0.05');
  assert.match(out.replace(/<[^>]+>/g, ''), /not a valid/i);
  assert.strictEqual(core.snipeDraft(u).ca, null);
  const out2 = await typed('snw_ca', `${CA} 0.05 90`);
  assert.match(out2.replace(/<[^>]+>/g, ''), /Slippage/i);
  assert.strictEqual(core.snipeDraft(u).ca, null, 'a line refused for slippage still stored its address');
});

test('the panel flows FORWARD: a saved target asks for the amount next', async () => {
  // "jadiin 1 aja, jangan pisah2": after a required row lands, the next
  // missing one is asked immediately — the user is never dumped back at the
  // panel to find the next ⏳ themselves.
  user();
  core.newSnipeDraft(CHAT);
  core.updateSnipeDraft(CHAT, { chain: 'robinhood' });
  const out = await typed('snw_ca', CA);
  assert.match(out.replace(/<[^>]+>/g, ''), /Amount|Jumlah/i, 'after the target the user was dumped back at the panel');
  // …but with the amount already set, the paste returns to the panel, ready to ⚡.
  core.updateSnipeDraft(CHAT, { amount: 0.05 });
  const out2 = await typed('snw_ca', CA2);
  assert.match(out2.replace(/<[^>]+>/g, ''), /Snipe Setup|Setup Snipe/i);
});

test("the panel's Target offers BOTH kinds — token contract and dev wallet", () => {
  // "dmn target dev walletnya": the reference panel's Targeted mode covers a
  // dev wallet as well as a token address; ours hid dev snipe behind another
  // screen. A wallet and a CA share the same address shape on every chain, so
  // the user says which they mean — no paste can be auto-classified.
  const SRC = fs.readFileSync(path.join(__dirname, 'telegram.js'), 'utf8');
  const block = SRC.slice(SRC.indexOf("if (k === 'snw')"), SRC.indexOf("if (data === 'rstog')"));
  assert.match(block, /'snw:cat'/, 'the token-contract choice is gone from the Target step');
  assert.match(block, /'snw:cad'/, 'the dev-wallet choice is gone from the Target step');
  // The dev choice lands ON THE DRAFT (kind 'dev') and the panel takes over.
  assert.match(block, /updateSnipeDraft\(chatId, \{ kind: 'dev' \}\)/);
  assert.match(block, /setPending\(chatId, \{ action: 'snw_dev' \}\)/);
});

test('switching target kind clears the address — a CA is not a dev wallet', () => {
  const u = user();
  core.newSnipeDraft(CHAT);
  core.updateSnipeDraft(CHAT, { chain: 'robinhood', ca: CA });
  // Shape-valid both ways, semantically wrong both ways: keeping it would arm
  // a watch that can never fire — the inert-watch failure mode.
  const d = core.updateSnipeDraft(CHAT, { kind: 'dev' });
  assert.strictEqual(d.ca, null, 'a token CA survived becoming a "dev wallet"');
  core.updateSnipeDraft(CHAT, { ca: CA2 });
  assert.strictEqual(core.updateSnipeDraft(CHAT, { kind: 'ca' }).ca, null);
  assert.ok(core.snipeDraft(u));
});

test('a dev panel hides rows the engine ignores and shows the budget', () => {
  user();
  core.newSnipeDraft(CHAT);
  core.updateSnipeDraft(CHAT, { chain: 'solana', kind: 'dev' });
  const s = tg._test.snipeSetupScreen(CHAT);
  const flat = s.kb.inline_keyboard.flat().map((b) => b.callback_data);
  assert.ok(flat.includes('snw:bud'), 'no budget row on the dev panel');
  // Slippage/TP-SL/expiry/wallet are not honoured on the dev path — a row the
  // backend ignores is the stop-loss-the-user-believes-exists, as a row.
  for (const cb of ['snw:slip', 'snw:tpsl', 'snw:ttl', 'snw:wal']) {
    assert.ok(!flat.includes(cb), `the dev panel shows ${cb}, which the dev path ignores`);
  }
});

// ── the dev-wallet target, on the panel ──────────────────────────────────────

test('the dev target asks ONE question at a time, and nothing arms before ⚡', async () => {
  // "aturan hapus aja, jadiin 1 aja, jangan pisah2: bot minta dev wallet, pas
  // udah dikasih tanyain mau snipe berapa, dll." The old prompt wanted wallet,
  // per-buy AND budget in one typed line.
  const u = user();
  core.newSnipeDraft(CHAT);
  core.updateSnipeDraft(CHAT, { chain: 'solana', kind: 'dev' });
  const out1 = await typed('snw_dev', MINT);
  assert.match(out1.replace(/<[^>]+>/g, ''), /Amount|Jumlah/i, 'the wallet alone did not lead to the amount question');
  const out2 = await typed('snw_amt', '0.05');
  assert.match(out2.replace(/<[^>]+>/g, ''), /Budget/i, 'the amount did not lead to the budget question');
  await typed('snw_bud', '0.5');
  assert.equal(((u.copy && u.copy.targets) || []).length, 0, 'the panel armed before ⚡');
  const tgt = core.armSnipeDraft(CHAT);
  assert.equal(tgt.mode, 'launches');
  assert.equal(tgt.chain, 'solana');
  assert.equal(tgt.address, MINT);
  assert.equal(tgt.buyEth, '0.05');
  assert.equal(tgt.maxEth, '0.5');
  assert.strictEqual(core.snipeDraft(u), null, 'an armed dev draft lingered');
});

test('the old one-line dev arm fills every row in one go', async () => {
  const u = user();
  core.newSnipeDraft(CHAT);
  core.updateSnipeDraft(CHAT, { chain: 'solana', kind: 'dev' });
  await typed('snw_dev', `${MINT} 0.05 0.5`);
  const d = core.snipeDraft(u);
  assert.equal(d.ca, MINT);
  assert.equal(d.amount, '0.05');
  assert.equal(d.budget, '0.5');
  assert.ok(core.armSnipeDraft(CHAT), 'a fully pasted line could not arm');
});

test('a refused dev step keeps the draft where it was', async () => {
  const u = user();
  core.newSnipeDraft(CHAT);
  core.updateSnipeDraft(CHAT, { chain: 'solana', kind: 'dev' });
  assert.match((await typed('snw_dev', 'not-an-address')).replace(/<[^>]+>/g, ''), /not a valid|bukan alamat/i);
  assert.strictEqual(core.snipeDraft(u).ca, null);
  core.updateSnipeDraft(CHAT, { ca: MINT, amount: 0.05 });
  // A budget below the per-launch amount is refused by the SAME rule the store
  // enforces — at the row, instead of being discovered at ⚡.
  assert.match((await typed('snw_bud', '0.01')).replace(/<[^>]+>/g, ''), /budget/i);
  assert.strictEqual(core.snipeDraft(u).budget, null);
  assert.throws(() => core.armSnipeDraft(CHAT), /no budget/i);
});

test('an OFF master switch is said at ⚡, with the one-tap fix', () => {
  // Arming a watch that silently does nothing is the stop-loss-the-user-
  // believes-exists — dev snipe only runs while copy.on is true, so the arm
  // handler says so with the 🟢 button on the same message.
  const SRC = fs.readFileSync(path.join(__dirname, 'telegram.js'), 'utf8');
  const block = SRC.slice(SRC.indexOf("if (k === 'snw')"), SRC.indexOf("if (data === 'rstog')"));
  assert.match(block, /dev\.master_off/, 'an inert dev arm reads as a live one');
  assert.match(block, /dev\.on_btn'\), 'cptog'/, 'the OFF note lost its one-tap fix');
});

// ── all wallets ──────────────────────────────────────────────────────────────

test('the wallet row offers 👥 All, arms as "*", and the total is stated', () => {
  const u = user();
  core.newSnipeDraft(CHAT);
  const kb = tg._test.snwWalletScreen(CHAT).kb.inline_keyboard;
  assert.ok(kb.flat().some((b) => b.callback_data === 'snww:*'), 'no All-wallets choice on the picker');
  core.updateSnipeDraft(CHAT, { chain: 'robinhood', ca: CA, amount: 0.05, walletId: '*' });
  const t = core.armSnipeDraft(CHAT);
  assert.equal(t.walletId, '*');
  // The armed confirmation states the multiplied total — real money must never
  // hide behind a multiplier. user() has 2 wallets: 0.05 × 2 = 0.1.
  const txt = tg._test.snipeArmedText(CHAT, t).replace(/<[^>]+>/g, '');
  assert.match(txt, /0\.1/, 'the multiplied total is not on the confirmation');
  assert.ok(core.snipeTargetById(u, t.id), 'the target was not stored');
});

test('an all-wallet target buys on EVERY wallet from one probe, and settles once', async () => {
  const u = user();
  const t = core.addSnipeTarget(CHAT, { ca: CA, chain: 'robinhood', amount: 0.05, walletId: '*' });
  let probes = 0;
  const wids = [];
  const real = { can: core.canTradeNow, buy: core.buy };
  core.canTradeNow = async () => { probes++; return true; };
  core.buy = async (cid, ca2, amt, chain, wid) => { wids.push(wid); return { chain, native: 'ETH', ca: ca2, hash: '0x' + wids.length, spentEth: 0.05, gotTokens: 10, sym: 'P' }; };
  const notes = [];
  watchers.setNotifier((chatId, text) => { notes.push(text); });
  try { await watchers._test.caSnipeCycle(); } finally { core.canTradeNow = real.can; core.buy = real.buy; watchers.setNotifier(() => {}); }
  assert.deepEqual(wids.sort(), ['w1', 'w2'], 'not every wallet bought');
  assert.equal(probes, 1, 'the contract was probed once per wallet');
  assert.equal(core.snipeTargetById(u, t.id).status, 'done');
  assert.ok(notes.some((n) => /2\/2 wallets/.test(n)), 'the fill does not say how many wallets filled');
});

test('one broke wallet does not stop the others; every wallet empty disarms', async () => {
  const u = user();
  const t = core.addSnipeTarget(CHAT, { ca: CA, chain: 'robinhood', amount: 0.05, walletId: '*' });
  const real = { can: core.canTradeNow, buy: core.buy };
  core.canTradeNow = async () => true;
  const notes = [];
  watchers.setNotifier((chatId, text) => { notes.push(text); });
  core.buy = async (cid, ca2, amt, chain, wid) => {
    if (wid === 'w1') throw new Error('insufficient funds for gas');
    return { chain, native: 'ETH', ca: ca2, hash: '0xok', spentEth: 0.05, gotTokens: 10, sym: 'P' };
  };
  try {
    await watchers._test.caSnipeCycle();
    assert.equal(core.snipeTargetById(u, t.id).status, 'done');
    assert.ok(notes.some((n) => /1\/2 wallets/.test(n)), 'a partial fill reads as a full one');
    // Every wallet empty → disarmed, the same rule the single-wallet path keeps.
    const t2 = core.addSnipeTarget(CHAT, { ca: CA2, chain: 'robinhood', amount: 0.05, walletId: '*' });
    core.buy = async () => { throw new Error('insufficient funds for gas'); };
    await watchers._test.caSnipeCycle();
    assert.equal(core.snipeTargetById(u, t2.id).status, 'failed');
  } finally { core.canTradeNow = real.can; core.buy = real.buy; watchers.setNotifier(() => {}); }
});

test('the typed TP/SL editor accepts 100/50 and off, refuses an impossible SL', async () => {
  const u = user();
  core.newSnipeDraft(CHAT);
  await typed('snw_tpsl', '100/50');
  let d = core.snipeDraft(u);
  assert.equal(d.tpPct, 100);
  assert.equal(d.slPct, 50);
  await typed('snw_tpsl', 'off');
  d = core.snipeDraft(u);
  assert.equal(d.tpPct, 0);
  assert.equal(d.slPct, 0);
  const out = await typed('snw_tpsl', '100/150');
  assert.match(out.replace(/<[^>]+>/g, ''), /TP\/SL/i);
  assert.equal(core.snipeDraft(u).slPct, 0, 'an impossible stop-loss was stored');
});
