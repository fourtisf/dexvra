'use strict';
// Elysium (Kinetiq's Hyperliquid L2, chain 99901). Its gas coin is HYPE, and
// every address is Uniswap's own published deployment for the chain
// (github.com/Uniswap/contracts, deployments/json/99901.json). No network.
process.env.SKIP_DOTENV = '1';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');
const chains = require('./chains');
const v4 = require('./v4');

const E = chains.CHAINS.elysium;

test('Elysium is registered as an EVM chain whose native coin is HYPE', () => {
  assert.ok(E, 'the chain exists');
  assert.strictEqual(E.chainId, 99901);
  assert.strictEqual(E.native, 'HYPE');
  assert.strictEqual(chains.kindOf('elysium'), 'evm');
  assert.strictEqual(E.curve, false);
  assert.match(E.rpc, /^https:\/\/rpc\.elysium\.kinetiq\.xyz$/);
  assert.ok(!/\/$/.test(E.explorer), 'the explorer base has no trailing slash — tx links append /tx/<hash>');
});

test('it is OPT-IN: the default ENABLED_CHAINS does not grow', () => {
  const src = fs.readFileSync(path.join(__dirname, 'chains.js'), 'utf8');
  const m = /env\('ENABLED_CHAINS', '([^']+)'\)/.exec(src);
  assert.ok(m, 'found the default list');
  assert.ok(!m[1].split(',').includes('elysium'), 'an existing install must not start trading a new chain on deploy');
});

test('every address is a valid checksum and matches Uniswap\'s published deployment', () => {
  const want = {
    factory: '0xbbbcc62853a5fa27b93d6bab3e6f7ce841e25df2',      // UniswapV2Factory
    router: '0xe783de89a7f0408687f051e3e6d0beb62719ebad',       // UniswapV2Router02
    weth: '0xba876237b0f021a6c6d852d6c26e107997cc5e81',         // WHYPE (every router's constructor)
  };
  for (const [k, v] of Object.entries(want)) {
    assert.strictEqual(ethers.getAddress(E[k]), E[k], `${k} is checksummed`);
    assert.strictEqual(E[k].toLowerCase(), v, k);
  }
  assert.strictEqual(E.v3.factory.toLowerCase(), '0x1707327f626496a7b5b3872e7e4d2879df7d7a9f');
  assert.strictEqual(E.v3.router.toLowerCase(), '0x2d01411773c8c24805306e89a41f7855c3c4fe65');
  assert.strictEqual(E.v3.quoter.toLowerCase(), '0x204faca1764b154221e35c0d20abb3c525710498');
  for (const a of Object.values(E.v3)) assert.strictEqual(ethers.getAddress(a), a);
});

test('the v4 money path trusts Uniswap\'s PoolManager and Universal Routers for the chain', () => {
  const c = v4.CANONICAL_V4.elysium;
  assert.ok(c, 'a canonical entry exists — without one no v4 router is ever offered');
  assert.strictEqual(c.poolManager.toLowerCase(), '0xe2e105d3f7209a9da11f83ccf3e7398a753823f1');
  assert.deepStrictEqual(c.routers.map((r) => r.toLowerCase()), [
    '0xa13f7611115752deb2b13813bdde16a5073e4b45',
    '0x1b341fdd55d56f8e08409a2c25ddfad93eb03c1a',
  ]);
  for (const a of [c.poolManager, ...c.routers]) assert.strictEqual(ethers.getAddress(a), a);
  assert.strictEqual(v4.cfg('elysium').poolManager, c.poolManager);
});

test('HYPE is priced as HYPE, never at ETH\'s price', async () => {
  const core = require('./core');
  const asked = [];
  const real = global.fetch;
  global.fetch = async (url) => {
    asked.push(String(url));
    return { ok: true, json: async () => ({ data: { amount: /HYPE-USD/.test(String(url)) ? '40' : '2500' } }) };
  };
  try {
    const px = await core.ethUsd('elysium');
    assert.strictEqual(px, 40);
    assert.ok(asked.some((u) => /\/HYPE-USD\/spot/.test(u)), 'asked for HYPE');
    assert.ok(!asked.some((u) => /\/ETH-USD\/spot/.test(u)), 'did not ask for ETH');
  } finally { global.fetch = real; }
});

test('the indexer maps carry the chain, in every module that has one', () => {
  const read = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8');
  for (const [file, name] of [['core.js', 'DS_CHAIN_KEY'], ['core.js', 'GT_NET'], ['telegram.js', 'DS_SLUG'],
    ['tokeninfo.js', 'DS_CHAIN'], ['tokeninfo.js', 'DS_SOCIAL_CHAIN'], ['scripts/venue-check.js', 'DS_SLUG']]) {
    const m = new RegExp(`const ${name} = \\{([^}]*)\\}`).exec(read(file));
    assert.ok(m, `${file} ${name}`);
    assert.match(m[1], /elysium: 'elysium'/, `${file} ${name} has elysium`);
  }
});
