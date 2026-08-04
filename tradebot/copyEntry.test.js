'use strict';
/*
 * Does copy-trading actually SEE a followed wallet buy?
 *
 * The exit half has been audited three times and reads balances, so it is route
 * agnostic. The entry half was not:
 *
 *     const pair = await pairOf(t.chain, token);      // getPair(token, WETH)
 *     if (!pair || pair !== fromAddr) continue;
 *
 * That recognised a Uniswap V2 pool and nothing else. A target buying through
 * V3, V4, Aerodrome, 1inch, 0x, CoW or another Telegram bot's router was
 * invisible — which on Ethereum and Base is most of the volume. The bot could
 * already ROUTE through V3; it just could not SEE anyone else do it.
 *
 * On Solana the gate was a SOL balance drop of more than ~0.005, so every
 * stablecoin-funded buy was invisible too.
 *
 * Both are now keyed on the MONEY: the target signed a transaction, tokens
 * arrived, and value left them. That is a buy however it was routed. These
 * tests drive the real cycle against each of those routes.
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const test = require('node:test');
const assert = require('node:assert');
const { ethers } = require('ethers');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'copyentry-'));
process.env.WALLET_SECRET = 'w'.repeat(48);
process.env.TRADEBOT_TOKEN = 'x:y';
process.env.ENABLED_CHAINS = 'ethereum,solana';

const core = require('./core');
const watchers = require('./watchers');
const solana = require('./solana');

const TARGET = '0x' + 'ab'.repeat(20);
const TOKEN = '0x' + 'de'.repeat(20);
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const V2_PAIR = '0x' + '22'.repeat(20);
const V3_POOL = '0x' + '33'.repeat(20);
const AGGREGATOR = '0x' + '44'.repeat(20);
const TRANSFER = ethers.id('Transfer(address,address,uint256)');
const pad = (a) => ethers.zeroPadValue(String(a).toLowerCase(), 32);
const CHAT = 900;

function seed(chain = 'ethereum') {
  core.DB.users = {};
  const u = core.ensureUser(CHAT);
  u.wallets = [{ id: 'w1', name: 'Wallet 1', address: '0x' + '11'.repeat(20), positions: {}, orders: [], history: [] }];
  u.activeWalletId = 'w1';
  u.copy = { on: true, targets: [{ id: 'cp1', address: TARGET, chain, mode: 'trades',
    buyEth: '0.01', maxEth: '1', spentEth: 0, bought: {}, holding: {}, copySell: true, cursor: 100 }] };
  return u;
}

/** Drive one EVM copy cycle where the target received TOKEN in a transaction
 *  routed through `sender`, funded as described. Returns the buys it mirrored. */
async function evmCycle({ sender, txFrom = TARGET, value = 10n ** 17n, paysWith = null } = {}) {
  const u = seed('ethereum');
  const hash = '0x' + 'fe'.repeat(32);
  const buys = [];
  const realProv = core.providerFor, realBuy = core.buy, realBal = core.tokenBalanceOrNull;
  core.providerFor = () => ({
    getBlockNumber: async () => 200,
    getLogs: async () => [{ address: TOKEN, topics: [TRANSFER, pad(sender), pad(TARGET)], transactionHash: hash }],
    getTransaction: async () => ({ from: txFrom, value, hash }),
    getTransactionReceipt: async () => ({ logs: paysWith
      ? [{ address: paysWith, topics: [TRANSFER, pad(TARGET), pad(sender)] }]
      : [{ address: TOKEN, topics: [TRANSFER, pad(sender), pad(TARGET)] }] }),
  });
  core.buy = async (chatId, ca, amt, chain, wid) => {
    buys.push({ ca, amt, chain });
    return { sym: 'DEAD', gotTokens: 1, spentEth: Number(amt), native: 'ETH', hash: '0x' + '1'.repeat(64), chain };
  };
  core.tokenBalanceOrNull = async () => 1000n;
  try { await watchers._test.copyCycle(); }
  finally { core.providerFor = realProv; core.buy = realBuy; core.tokenBalanceOrNull = realBal; }
  return buys;
}

// ---------------------------------------------------------------- EVM routes
test('a Uniswap V2 buy is mirrored — the one route that always worked', async () => {
  assert.equal((await evmCycle({ sender: V2_PAIR })).length, 1, 'the V2 route stopped working');
});

test('a Uniswap V3 buy is mirrored', async () => {
  // The pool is not getPair(token, WETH), so the old detector never saw it.
  const buys = await evmCycle({ sender: V3_POOL });
  assert.equal(buys.length, 1, 'a V3 buy is still invisible');
  assert.equal(buys[0].ca, TOKEN);
});

test('an aggregator buy is mirrored — 1inch, 0x, CoW, another bot\'s router', async () => {
  // The tokens arrive from a settlement contract that is nobody\'s pool.
  assert.equal((await evmCycle({ sender: AGGREGATOR })).length, 1, 'an aggregator buy is still invisible');
});

test('a buy funded with WETH rather than ETH is mirrored', async () => {
  // tx.value is 0; the money leaves as an ERC-20 Transfer of WETH.
  const buys = await evmCycle({ sender: V3_POOL, value: 0n, paysWith: WETH });
  assert.equal(buys.length, 1, 'a WETH-funded buy is still invisible');
});

test('a buy funded with USDC is mirrored', async () => {
  const buys = await evmCycle({ sender: AGGREGATOR, value: 0n, paysWith: USDC });
  assert.equal(buys.length, 1, 'a stablecoin-funded buy is still invisible');
});

// ---------------------------------------------------------------- not a buy
test('an airdrop is NOT mirrored — nothing left the target', async () => {
  // The failure that costs money: mirroring tokens somebody was simply sent
  // spends real funds on a token nobody bought.
  assert.deepEqual(await evmCycle({ sender: AGGREGATOR, value: 0n }), [],
    'an airdrop was mirrored as a buy');
});

test('a transfer the target did not sign is NOT mirrored', async () => {
  // Tokens arrive, value moved, but somebody else sent the transaction.
  assert.deepEqual(await evmCycle({ sender: V2_PAIR, txFrom: '0x' + '99'.repeat(20) }), [],
    'somebody else\'s transaction was mirrored');
});

test('an unreadable transaction is NOT mirrored', async () => {
  const u = seed('ethereum');
  const buys = [];
  const realProv = core.providerFor, realBuy = core.buy;
  core.providerFor = () => ({
    getBlockNumber: async () => 200,
    getLogs: async () => [{ address: TOKEN, topics: [TRANSFER, pad(V2_PAIR), pad(TARGET)], transactionHash: '0x' + 'fe'.repeat(32) }],
    getTransaction: async () => { throw new Error('rpc down'); },
    getTransactionReceipt: async () => { throw new Error('rpc down'); },
  });
  core.buy = async () => { buys.push(1); return {}; };
  try { await watchers._test.copyCycle(); }
  finally { core.providerFor = realProv; core.buy = realBuy; }
  assert.deepEqual(buys, [], 'a buy fired on a transaction that could not be read');
});

test('the V2-only pair lookup is gone, not merely bypassed', async () => {
  const SRC = fs.readFileSync(path.join(__dirname, 'watchers.js'), 'utf8');
  assert.ok(!/pairOf/.test(SRC), 'pairOf survives — dead code that invites the old gate back');
  assert.ok(!/GET_PAIR_ABI/.test(SRC), 'the getPair ABI is still here');
  assert.match(SRC, /_targetPaid\(t\.chain, t\.address, log\.transactionHash\)/, 'the payment check is not wired in');
});

// ---------------------------------------------------------------- Solana
/** One parsed Solana transaction: the target ends up with `mint`, having given
 *  up either SOL or a token. */
function solTx({ solSpent = 20_000_000n, gave = null } = {}) {
  const pre = [], post = [];
  if (gave) {
    pre.push({ owner: TARGET_SOL, mint: gave.mint, uiTokenAmount: { amount: String(gave.before), decimals: 6 } });
    post.push({ owner: TARGET_SOL, mint: gave.mint, uiTokenAmount: { amount: String(gave.after), decimals: 6 } });
  }
  post.push({ owner: TARGET_SOL, mint: MINT, uiTokenAmount: { amount: '1000000000', decimals: 6 } });
  return {
    meta: { preTokenBalances: pre, postTokenBalances: post, preBalances: [1_000_000_000], postBalances: [1_000_000_000n - solSpent].map(Number) },
    transaction: { message: { accountKeys: [{ pubkey: { toString: () => TARGET_SOL } }] } },
  };
}
const TARGET_SOL = 'TargetWa11etAddressBase58xxxxxxxxxxxxxxxxxxxx';
const MINT = 'M1ntAddressBase58xxxxxxxxxxxxxxxxxxxxxxxxxxxx';

async function solBought(tx) {
  const conn = { getParsedTransaction: async () => tx };
  return watchers._test._solBuyMintFromTx(conn, 'sig1', TARGET_SOL);
}

test('Solana: a SOL-funded buy is seen — the route that always worked', async () => {
  assert.equal(await solBought(solTx({ solSpent: 20_000_000n })), MINT);
});

test('Solana: a buy funded with USDC is seen', async () => {
  // The gate was "SOL balance fell by > 0.005", so every stablecoin-funded buy
  // on the chain was invisible.
  const tx = solTx({ solSpent: 5000n, gave: { mint: 'USDCxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', before: 50_000_000, after: 10_000_000 } });
  assert.equal(await solBought(tx), MINT, 'a USDC-funded Solana buy is still invisible');
});

test('Solana: an airdrop is NOT seen — nothing left the target', async () => {
  // Only fees moved, and no token of theirs fell.
  assert.equal(await solBought(solTx({ solSpent: 5000n })), null, 'a Solana airdrop was mirrored as a buy');
});

test('Solana: a token that only GREW is not treated as payment', async () => {
  // Receiving two tokens at once must not make one of them look like the price
  // of the other.
  const tx = solTx({ solSpent: 5000n, gave: { mint: 'OtherMintxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', before: 10, after: 99 } });
  assert.equal(await solBought(tx), null, 'a rising balance was read as payment');
});
