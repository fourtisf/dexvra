'use strict';
/* Offline render check for the token card, sell menu and monitor — stubs the
 * data layer so we can eyeball the exact text + keyboards a user would see,
 * with no network / no live chain. Run: node scripts/render-test.js */
const path = require('path');
const Module = require('module');

// ---- Stub the data-layer modules BEFORE telegram.js requires them ----
const CH = { key: 'robinhood', name: 'Robinhood Chain', emoji: '🔗', native: 'ETH', curve: false };
const CA = '0x0bd7d308f8e1639fab988df18a8011f41eacad73';
const WALLET = { id: 'w1', address: '0xAbc0000000000000000000000000000000000001', positions: {}, active: true };
WALLET.positions['robinhood:' + CA.toLowerCase()] = { sym: 'PEPE', dec: 18, tokens: '5000000000000000000000000', costEth: 0.12 };

const coreStub = {
  CFG: { tgToken: 'TEST:TOKEN', feeWallet: '0xFee', solFeeWallet: 'SoL' },
  chains: { isSvm: () => false, enabledChains: () => [CH], isSol: () => false },
  ensureUser: () => ({ id: 1, wallets: [WALLET], activeWallet: 'w1' }),
  getUser: () => ({ id: 1 }),
  allUsers: () => [{}],
  chainOf: (k) => (k === 'robinhood' ? CH : CH),
  userChain: () => 'robinhood',
  walletList: () => [WALLET],
  walletById: (u, id) => (id === 'w1' ? WALLET : null),
  walletAddress: (w) => w.address,
  activeWallet: () => WALLET,
  walletLabel: (w, i) => `Wallet ${i}`,
  posKey: (chain, ca) => `${chain}:${String(ca).toLowerCase()}`,
  tokenMeta: async () => ({ name: 'Pepe Coin', sym: 'PEPE', decimals: 18 }),
  tokenBalance: async () => 5000000000000000000000000n, // 5,000,000 tokens
  tokenSnapshot: async () => ({ sym: 'PEPE', priceEth: 0.0000000123, mcapEth: 12.3, mcapUsd: 45000 }),
  tokenAcrossWallets: async () => ({ rows: [{ id: 'w1', label: 'Wallet 1', tokens: 5000000, raw: 5000000000000000000000000n, eth: 0.42, active: true, pctSupply: 0.5 }], holderId: 'w1' }),
  buyPresets: () => ['0.05', '0.1', '0.5'],
  tradeSelection: () => ({ all: false }),
  tradeWalletIds: () => [],
  ethBalance: async () => 0n,
};
const tokeninfoStub = {
  enrich: async () => ({
    dex: true, dexVenue: 'v3', graduated: true, priceEth: 0.0000000123,
    mcapEth: 12.3, liquidityNative: 12.5,
    api: { name: 'Pepe Coin', symbol: 'PEPE', marketCapUsd: 45000, volume: { h24Usd: 250000, totalUsd: 900000 }, createdAt: Date.now() - 3 * 86400000, links: { website: 'https://x.io', twitter: 'https://x.com/p', telegram: 'https://t.me/p' } },
    security: { holders: 340, lpLockedPct: 100, buyTaxPct: 0, sellTaxPct: 0, honeypot: false, openSource: true },
    market: { liqUsd: 40000, volH24Usd: 250000, chgH1: 2.1, chgH24: 12.3, buysH24: 120, sellsH24: 80, createdAt: Date.now() - 3 * 86400000 },
  }),
};
const safetyStub = { verdict: () => ({ level: 'ok', red: [], warn: [] }), supported: () => true };
const watchersStub = {};
const reportStub = { onWallet: () => {}, onTrade: () => {}, enabled: () => false };
const goplusStub = {};
const solanaStub = { isBase58: () => false };

const dir = path.resolve(__dirname, '..');
const inject = (rel, exp) => { const p = require.resolve(path.join(dir, rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports: exp }; };
inject('core', coreStub);
inject('tokeninfo', tokeninfoStub);
inject('safety', safetyStub);
inject('watchers', watchersStub);
inject('report', reportStub);
inject('goplus', goplusStub);
inject('solana', solanaStub);

const tg = require(path.join(dir, 'telegram'));
const T = tg._test;

const dump = (title, p) => {
  console.log('\n\n===== ' + title + ' =====');
  console.log(p.text);
  console.log('--- keyboard ---');
  (p.kb.inline_keyboard || []).forEach((row) => console.log('[ ' + row.map((b) => b.text).join(' | ') + ' ]'));
};

(async () => {
  dump('TOKEN CARD (drop CA)', await T.tokenCard(1, CA, 'robinhood', 'w1'));
  dump('SELL MENU (Sell other %)', await T.sellMenu(1, CA, 'robinhood', 'w1'));
  dump('MONITOR (live position)', await T.monitorPayload(1, CA, 'robinhood', 'w1'));
  process.exit(0);
})().catch((e) => { console.error('render test failed:', e); process.exit(1); });
