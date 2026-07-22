'use strict';
/*
 * v3-discover — find the Uniswap V3 addresses for a chain from a KNOWN V3 pool.
 *
 * Usage (run on the VPS, inside tradebot/):
 *   node scripts/v3-discover.js <v3-pool-address> [chainKey]
 *
 * Where do I get a pool address? Open the token on DexScreener — the /robinhood/0x…
 * part of the URL IS the pool address of the pair you're looking at (make sure the
 * pair is labeled "v3").
 *
 * What it does (read-only, spends nothing):
 *   1. reads pool.factory()  → the V3 FACTORY address (authoritative, on-chain)
 *   2. reads pool.fee(), token0/token1 → sanity info
 *   3. probes the CANONICAL Uniswap SwapRouter02 + QuoterV2 addresses for
 *      deployed code on this chain → suggests router/quoter candidates.
 *      ⚠️ A code-presence probe is a HINT, not proof — confirm the router +
 *      quoter against Uniswap's official deployments page for the chain
 *      (https://docs.uniswap.org/contracts/v3/reference/deployments) before
 *      putting them in .env. Wrong router = failed trades.
 *
 * Then add to .env (example for Robinhood Chain):
 *   ROBINHOOD_V3_FACTORY=0x…
 *   ROBINHOOD_V3_ROUTER=0x…
 *   ROBINHOOD_V3_QUOTER=0x…
 * and: pm2 restart dexvra-tradebot --update-env
 */
const { ethers } = require('ethers');
const chains = require('../chains');

const POOL_ABI = [
  'function factory() view returns (address)',
  'function fee() view returns (uint24)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function liquidity() view returns (uint128)',
];
// Canonical Uniswap periphery addresses seen across chains — probed for code only.
const ROUTER_CANDIDATES = [
  ['SwapRouter02 (mainnet/arbitrum/polygon…)', '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45'],
  ['SwapRouter02 (base)', '0x2626664c2603336E57B271c5C0b26F421741e481'],
  ['SwapRouter02 (bsc)', '0xB971eF87ede563556b2ED4b1C0b0019111Dd85d2'],
];
const QUOTER_CANDIDATES = [
  ['QuoterV2 (mainnet/arbitrum/polygon…)', '0x61fFE014bA17989E743c5F6cB21bF9697530B21e'],
  ['QuoterV2 (base)', '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a'],
  ['QuoterV2 (bsc)', '0x78D78E420Da98ad378D7799bE8f4AF69033EB077'],
];

(async () => {
  const pool = String(process.argv[2] || '').trim();
  const chainKey = String(process.argv[3] || 'robinhood').trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(pool)) {
    console.error('Usage: node scripts/v3-discover.js <v3-pool-address> [chainKey]\nGet the pool address from the token\'s DexScreener URL (a pair labeled "v3").');
    process.exit(1);
  }
  const ch = chains.chainOf(chainKey);
  if (!ch) { console.error('unknown chain key: ' + chainKey); process.exit(1); }
  const prov = new ethers.JsonRpcProvider(ch.rpc);
  const pc = new ethers.Contract(pool, POOL_ABI, prov);

  console.log(`\nV3 discovery on ${ch.name} (${ch.rpc})\npool: ${pool}\n`);
  const factory = await pc.factory();
  const [fee, t0, t1, liq] = await Promise.all([
    pc.fee().catch(() => null), pc.token0().catch(() => null), pc.token1().catch(() => null), pc.liquidity().catch(() => null),
  ]);
  console.log('✅ FACTORY (authoritative, read from the pool itself):');
  console.log(`   ${chainKey.toUpperCase()}_V3_FACTORY=${factory}`);
  console.log(`   fee tier: ${fee != null ? fee : '?'} · token0: ${t0} · token1: ${t1} · in-range liquidity: ${liq != null ? liq : '?'}\n`);

  const probe = async (list, label) => {
    console.log(`${label} candidates with code deployed on ${ch.name}:`);
    let any = false;
    for (const [name, addr] of list) {
      try { const code = await prov.getCode(addr); if (code && code !== '0x') { console.log(`   ✓ ${addr}  (${name})`); any = true; } } catch (_) {}
    }
    if (!any) console.log('   (none of the canonical addresses have code here — get the address from Uniswap\'s deployments docs)');
    console.log('');
  };
  await probe(ROUTER_CANDIDATES, 'ROUTER (SwapRouter02)');
  await probe(QUOTER_CANDIDATES, 'QUOTER (QuoterV2)');
  console.log('⚠️ Confirm router+quoter against https://docs.uniswap.org/contracts/v3/reference/deployments before saving to .env.');
})().catch((e) => { console.error('discover failed:', (e && e.message) || e); process.exit(1); });
