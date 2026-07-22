'use strict';
/*
 * v3-discover — find the Uniswap V3 addresses for a chain from a KNOWN V3 pool.
 *
 * Usage (run on the VPS, inside tradebot/):
 *   node scripts/v3-discover.js <v3-pool-address> [chainKey]
 *
 * Get the pool address from the token's DexScreener URL — the /robinhood/0x… part
 * IS the pool address of the pair shown (make sure the pair is labeled "v3").
 *
 * Read-only, spends nothing. It:
 *   1. reads pool.factory()                        → the V3 FACTORY (authoritative)
 *   2. reads fee()/token0/token1/liquidity         → sanity info
 *   3. scans recent Swap events and reports the most common `sender`
 *      → the ROUTER real users trade through (authoritative from real swaps)
 *   4. probes canonical QuoterV2 addresses for code → QUOTER candidate
 *
 * A clean ENV block is printed at the very BOTTOM so nothing scrolls away.
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
const SWAP_TOPIC = ethers.id('Swap(address,address,int256,int256,uint160,uint128,int24)');
const QUOTER_CANDIDATES = [
  '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',   // QuoterV2 — mainnet/arbitrum/…
  '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a',   // QuoterV2 — base
  '0x78D78E420Da98ad378D7799bE8f4AF69033EB077',   // QuoterV2 — bsc
];
const short = (a) => a ? a.slice(0, 8) + '…' + a.slice(-6) : '?';

// Most-common Swap `sender` over recent blocks = the router users actually use.
async function findRouter(prov, pool) {
  const latest = await prov.getBlockNumber();
  const spans = [3000, 20000, 120000];   // widen if a narrow window is empty
  for (const span of spans) {
    const from = Math.max(0, latest - span);
    let logs = null;
    try { logs = await prov.getLogs({ address: pool, topics: [SWAP_TOPIC], fromBlock: from, toBlock: latest }); }
    catch (_) {
      // RPC capped the range — try in ~1000-block chunks, newest first.
      logs = [];
      for (let hi = latest; hi > from; hi -= 1000) {
        try { const part = await prov.getLogs({ address: pool, topics: [SWAP_TOPIC], fromBlock: Math.max(from, hi - 1000), toBlock: hi }); logs.push(...part); if (logs.length > 50) break; } catch (_) { break; }
      }
    }
    if (logs && logs.length) {
      const tally = new Map();
      for (const l of logs) { const sender = '0x' + l.topics[1].slice(26); tally.set(sender, (tally.get(sender) || 0) + 1); }
      const ranked = [...tally.entries()].sort((a, b) => b[1] - a[1]);
      return { ranked, sampled: logs.length, span };
    }
  }
  return { ranked: [], sampled: 0, span: spans[spans.length - 1] };
}

(async () => {
  const pool = String(process.argv[2] || '').trim();
  const chainKey = String(process.argv[3] || 'robinhood').trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(pool)) {
    console.error('Usage: node scripts/v3-discover.js <v3-pool-address> [chainKey]');
    process.exit(1);
  }
  const ch = chains.chainOf(chainKey);
  if (!ch) { console.error('unknown chain key: ' + chainKey); process.exit(1); }
  const prov = new ethers.JsonRpcProvider(ch.rpc);
  const pc = new ethers.Contract(pool, POOL_ABI, prov);

  console.log(`\nV3 discovery on ${ch.name}\npool: ${pool}\n`);
  const factory = await pc.factory();
  const [fee, t0, t1, liq] = await Promise.all([
    pc.fee().catch(() => null), pc.token0().catch(() => null), pc.token1().catch(() => null), pc.liquidity().catch(() => null),
  ]);
  console.log(`fee tier: ${fee} · token0 ${short(t0)} · token1 ${short(t1)} · in-range liq ${liq}`);

  console.log('\nScanning recent Swap events for the router…');
  const { ranked, sampled, span } = await findRouter(prov, pool);
  let router = null;
  if (ranked.length) {
    console.log(`  ${sampled} swaps over ~${span} blocks. Senders (router = the top one):`);
    for (const [addr, n] of ranked.slice(0, 4)) {
      let hasCode = false; try { const c = await prov.getCode(addr); hasCode = c && c !== '0x'; } catch (_) {}
      console.log(`    ${n}×  ${addr}  ${hasCode ? '(has code ✓)' : '(EOA — skip)'}`);
    }
    router = ranked.find(([a]) => a)[0];
    // Prefer the top sender that actually has contract code.
    for (const [addr] of ranked) { try { const c = await prov.getCode(addr); if (c && c !== '0x') { router = addr; break; } } catch (_) {} }
  } else {
    console.log('  no Swap events found in the scanned window — do a real swap on DexScreener, then re-run.');
  }

  console.log('\nQuoterV2 candidates with code on this chain:');
  let quoter = null;
  for (const addr of QUOTER_CANDIDATES) {
    try { const c = await prov.getCode(addr); if (c && c !== '0x') { console.log(`    ✓ ${addr}`); if (!quoter) quoter = addr; } } catch (_) {}
  }
  if (!quoter) console.log('    (none found — get QuoterV2 from Uniswap deployments docs)');

  console.log('\n────────────────────────────────────────────────────────');
  console.log('Add these to /opt/dexvra/tradebot/.env  (verify first!):\n');
  console.log(`${chainKey.toUpperCase()}_V3_FACTORY=${factory}`);
  console.log(`${chainKey.toUpperCase()}_V3_ROUTER=${router || '0x…(not found — see above)'}`);
  console.log(`${chainKey.toUpperCase()}_V3_QUOTER=${quoter || '0x…(not found — see above)'}`);
  console.log('\n⚠️ The ROUTER is inferred from real swaps; confirm it is Uniswap SwapRouter02');
  console.log('   (not an aggregator) before trading. Then: pm2 restart dexvra-tradebot --update-env');
  console.log('────────────────────────────────────────────────────────\n');
})().catch((e) => { console.error('discover failed:', (e && e.message) || e); process.exit(1); });
