'use strict';
/*
 * walletRender.test.js — renders /wallet and /tokens for real.
 *
 * walletScreen.test.js reads the SOURCE and asserts on its shape, which is
 * useful for pinning layout rules but cannot catch a runtime fault. It did not:
 * `walletTokenUsd` early-returns when a user holds no tokens at all, and that
 * branch still returned a per-wallet NUMBER after the main path had been
 * changed to return a per-wallet ARRAY of bags. Every source assertion passed
 * while the screen threw `wb.reduce is not a function` for the single most
 * common user there is — a new one, who has bought nothing yet.
 *
 * So these tests drive the real functions against a fake chain/core.
 */
const test = require('node:test');
const assert = require('node:assert');
const M = require('node:module');

const CH = [
  { key: 'robinhood', name: 'Robinhood Chain', native: 'ETH', emoji: '🚀', explorer: 'https://e' },
  { key: 'ethereum', name: 'Ethereum', native: 'ETH', emoji: '♦', explorer: 'https://e' },
  { key: 'bsc', name: 'BNB Chain', native: 'BNB', emoji: '🟡', explorer: 'https://e' },
  { key: 'solana', name: 'Solana', native: 'SOL', emoji: '🟣', explorer: 'https://e' },
];
const idx = (k) => CH.findIndex((c) => c.key === k);
const E = (n) => BigInt(Math.round(n * 1e18));
const pos = (chain, ca, sym, tok, dec) =>
  ({ chain, ca, sym, dec, tokens: BigInt(Math.round(tok * 10 ** dec)).toString(), closed: false });

// Rebuilt per test so one test's wallets cannot leak into the next.
let WALLETS = [];
let BAL = [];
let PRICE = {};

const core = {
  CFG: { tgToken: 'test' },
  ensureUser: () => ({ activeWalletId: WALLETS[0] && WALLETS[0].id, wallets: WALLETS }),
  chainOf: (k) => CH[idx(k)] || CH[0],
  userChain: () => 'robinhood',
  walletList: () => WALLETS,
  walletLabel: (w, i) => w.name || 'Wallet ' + i,
  WALLET_CAP: 10,
  getLang: () => 'en',
  walletAddress: (w, k) => (k === 'solana' ? w.sol : w.address),
  chains: { enabledChains: () => CH, isSvm: (k) => k === 'solana' },
  providerFor: (k) => ({ getBalance: async (a) => bal(a, k) }),
  ethBalance: async (a, k) => bal(a, k),
  tokenSnapshot: async (ca) => ({ priceEth: PRICE[ca] || 0 }),
};
function bal(addr, k) {
  // Indexed by wallet POSITION, not id: ids are made unique per test (see W).
  const wi = WALLETS.findIndex((x) => x.address === addr || x.sol === addr);
  const row = BAL[wi] || [];
  const v = row[idx(k)];
  if (v === 'fail') throw new Error('RPC down');
  return v == null ? 0n : v;
}

const orig = M.prototype.require;
M.prototype.require = function (p) { return p === './core' ? core : orig.apply(this, arguments); };
const tgm = require('./telegram.js');
M.prototype.require = orig;
const t = tgm._test;
t.PRICES.ETH = 2000; t.PRICES.BNB = 600; t.PRICES.SOL = 200;

// Unique per test. telegram.js keeps a module-level last-known-good balance
// cache (10 min) so a chain whose RPC blips does not silently drop out of the
// totals — which is correct, and means a wallet id reused across tests carries
// the previous test's balances into this one. That leak masked a genuine
// failure here: an unreadable chain read back as a cached 0, i.e. "empty".
let _uid = 0;
const W = (id, name) => { const u = id + '_' + (++_uid); return { id: u, name: name || '', orders: [], positions: {},
  address: '0x' + u.padEnd(40, '0'), sol: 'So' + u.padEnd(42, '1') }; };
const plain = (s) => s.replace(/<[^>]+>/g, '');

test.beforeEach(() => { WALLETS = []; BAL = []; PRICE = {}; });

// ── The path the source tests could not see ──────────────────────────────────

test('a brand-new user with nothing at all gets a screen, not a crash', async () => {
  WALLETS = [W('w1')];
  const r = await t.walletScreen(1);
  assert.ok(r.text.length > 0);
  assert.match(plain(r.text), /Three steps to your first trade/);
});

test('a user with coins but no tokens renders', async () => {
  WALLETS = [W('w1')];
  BAL = [[E(0.5), 0n, 0n, 0n]];
  const r = await t.walletScreen(1);
  assert.match(plain(r.text), /0\.5000 ETH/);
  assert.match(plain(r.text), /\$1,000\.00/);
});

// ── Layout ───────────────────────────────────────────────────────────────────

test('each wallet appears exactly once', async () => {
  WALLETS = [W('w1'), W('w2'), W('w3')];
  BAL = [[E(1), 0n, 0n, 0n], [E(2), 0n, 0n, 0n], [E(3), 0n, 0n, 0n]];
  const txt = plain((await t.walletScreen(1)).text);
  for (const name of ['Wallet 1', 'Wallet 2', 'Wallet 3']) {
    const hits = txt.split(name).length - 1;
    assert.strictEqual(hits, 1, `${name} appears ${hits} times`);
  }
});

test('one wallet, one dollar figure — no two roundings of the same number', async () => {
  // The original complaint: "≈ $1.01K" above "native $999.62 · tokens $8.18".
  WALLETS = [W('w1')];
  BAL = [[E(0.5046), E(0.0149), 0n, 0n]];
  const txt = plain((await t.walletScreen(1)).text);
  assert.ok(!/\$[\d.]+K/.test(txt), `a K-rounded figure is back: ${txt.match(/\$[\d.]+K/)}`);
});

test('chains with nothing on them take one line between them', async () => {
  WALLETS = [W('w1')];
  BAL = [[E(1), 0n, 0n, 0n]];
  const txt = plain((await t.walletScreen(1)).text);
  assert.match(txt, /Nothing yet on Ethereum · BNB Chain · Solana/);
  assert.ok(!/Ethereum — 0/.test(txt), 'a zero row is back');
});

test('an RPC that did not answer is reported separately from a real zero', async () => {
  WALLETS = [W('w1')];
  BAL = [[E(1), 'fail', 0n, 0n]];
  const txt = plain((await t.walletScreen(1)).text);
  assert.match(txt, /Couldn't reach Ethereum/);
  assert.ok(!/Nothing yet on[^\n]*Ethereum/.test(txt), 'an unreadable chain was counted as empty');
});

test('no gas on the chain you are trading on is a warning, not a row', async () => {
  WALLETS = [W('w1')];
  BAL = [[0n, E(1), 0n, 0n]];
  const txt = plain((await t.walletScreen(1)).text);
  assert.match(txt, /⚠️ 0 ETH on Robinhood Chain/);
});

test('only the active wallet prints its addresses', async () => {
  WALLETS = [W('w1'), W('w2'), W('w3')];
  BAL = [[E(1), 0n, 0n, 0n], [E(1), 0n, 0n, 0n], [E(1), 0n, 0n, 0n]];
  const r = await t.walletScreen(1);
  assert.strictEqual((r.text.match(/<code>/g) || []).length, 2, 'expected exactly the active wallet EVM + Solana address');
  assert.ok(r.text.includes(WALLETS[0].address));
  assert.ok(!r.text.includes(WALLETS[1].address), "an inactive wallet's address is on screen");
  // …but it still has a button to get it.
  assert.ok(JSON.stringify(r.kb).includes('qrw:' + WALLETS[1].id));
});

test('the screen fits in a Telegram message at the wallet cap', async () => {
  WALLETS = Array.from({ length: 10 }, (_, i) => W('w' + (i + 1), 'W'.repeat(24)));
  BAL = WALLETS.map(() => [E(1234.5678), E(1), E(1), 0n]);
  const r = await t.walletScreen(1);
  assert.ok(r.text.length < 4096, `${r.text.length} chars — sendMessage would 400 and the user would see nothing`);
});

// ── The tokens screen ────────────────────────────────────────────────────────

test('tokens are grouped by chain, and every chain is covered', async () => {
  WALLETS = [W('w1'), W('w2')];
  WALLETS[0].positions = { a: pos('robinhood', '0xA', 'HOPPY', 100000, 18) };
  WALLETS[1].positions = { b: pos('bsc', '0xB', 'CAKE', 4, 18), c: pos('solana', 'SoC', 'BONK', 1e6, 5) };
  PRICE = { '0xA': 0.000005, '0xB': 0.003, SoC: 0.0000001 };
  const txt = plain((await t.tokensScreen(1)).text);
  assert.match(txt, /🚀 Robinhood Chain[\s\S]*\$HOPPY/);
  assert.match(txt, /🟡 BNB Chain[\s\S]*\$CAKE/);
  assert.match(txt, /🟣 Solana[\s\S]*\$BONK/);
  // …and it says WHICH wallet holds each.
  assert.match(txt, /\$CAKE[^\n]*Wallet 2/);
});

test('the tokens total equals the wallet screen total', async () => {
  // Two screens computing "how much in tokens" separately is how they drift.
  WALLETS = [W('w1')];
  WALLETS[0].positions = { a: pos('robinhood', '0xA', 'HOPPY', 100000, 18), b: pos('bsc', '0xB', 'CAKE', 4, 18) };
  PRICE = { '0xA': 0.000005, '0xB': 0.003 };
  const wal = plain((await t.walletScreen(1)).text);
  const tok = plain((await t.tokensScreen(1)).text);
  const from = (s, re) => (re.exec(s) || [])[1];
  assert.strictEqual(from(wal, /🪙 Tokens — (\$[\d,.]+)/), from(tok, /(\$[\d,.]+) in tokens/));
});

test('a token we could not price is never shown as $0.00', async () => {
  WALLETS = [W('w1')];
  WALLETS[0].positions = { a: pos('ethereum', '0xDEAD', 'GHOST', 900000, 18) };
  PRICE = {}; // no price for anything
  const r = await t.tokensScreen(1);
  const txt = plain(r.text);
  assert.match(txt, /\$GHOST · price unavailable/);
  assert.match(txt, /♦ Ethereum · price unavailable/, 'the chain subtotal claimed $0.00');
  assert.ok(!/\$GHOST · \$0\.00/.test(JSON.stringify(r.kb)), 'the button claimed $0.00');
});

test('holding nothing says so instead of rendering an empty list', async () => {
  WALLETS = [W('w1')];
  const txt = plain((await t.tokensScreen(1)).text);
  assert.match(txt, /No tokens yet/);
});

test('the same token in two wallets is one row naming both', async () => {
  WALLETS = [W('w1'), W('w2')];
  WALLETS[0].positions = { a: pos('robinhood', '0xA', 'HOPPY', 100000, 18) };
  WALLETS[1].positions = { b: pos('robinhood', '0xA', 'HOPPY', 40000, 18) };
  PRICE = { '0xA': 0.000005 };
  const txt = plain((await t.tokensScreen(1)).text);
  assert.strictEqual(txt.split('$HOPPY').length - 1, 1, 'the token is listed twice instead of merged');
  assert.match(txt, /Wallet 1, Wallet 2/);
  assert.match(txt, /140\.00K \$HOPPY/, 'the merged amount is wrong');
});
