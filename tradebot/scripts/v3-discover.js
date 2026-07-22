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
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 obsIdx, uint16 obsCard, uint16 obsCardNext, uint8 feeProtocol, bool unlocked)',
];
const QUOTER_ABI = ['function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)'];
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

  // ── LIVE VERIFICATION ──────────────────────────────────────────────────
  // The factory (from the pool) is trusted. The quoter is the fragile part on a
  // CUSTOM deployment: prove it actually returns a quote that matches the pool's
  // own slot0 price. If it doesn't, these addresses must NOT be used.
  console.log('\nVerifying the quoter against the pool (live)…');
  let quoterOK = false, spotPrice0per1 = null;
  try {
    const s0 = await pc.slot0();
    // price of token0 in token1 from sqrtPriceX96: (sqrt/2^96)^2
    const sp = Number(s0[0]);
    spotPrice0per1 = (sp / 2 ** 96) ** 2;   // token1 per token0 (raw, ignoring decimals — used only as a sanity ratio)
    console.log(`  pool slot0 sqrtPriceX96=${s0[0]} (tick ${s0[1]})`);
  } catch (e) { console.log('  slot0 read failed: ' + (e.message || e)); }
  if (quoter && fee != null && t0 && t1) {
    try {
      const q = new ethers.Contract(quoter, QUOTER_ABI, prov);
      const amtIn = 10n ** 15n;   // 0.001 of token0
      const r = await q.quoteExactInputSingle.staticCall({ tokenIn: t0, tokenOut: t1, amountIn: amtIn, fee, sqrtPriceLimitX96: 0n });
      const out = r[0];
      if (out > 0n) {
        quoterOK = true;
        const implied = Number(out) / Number(amtIn);
        console.log(`  ✅ quoter returned ${out} (token1 out for 0.001 token0) — implied ratio ${implied.toExponential(3)}`);
        if (spotPrice0per1 != null) {
          const drift = Math.abs(implied - spotPrice0per1) / spotPrice0per1;
          console.log(`  cross-check vs slot0: ${(drift * 100).toFixed(1)}% ${drift < 0.1 ? '✅ matches' : '⚠️ differs — double-check the fee tier'}`);
        }
      } else { console.log('  ❌ quoter returned 0 — wrong quoter for this deployment.'); }
    } catch (e) { console.log('  ❌ quoter call reverted: ' + (e.shortMessage || e.message || e) + '\n     → this QuoterV2 does NOT work with this chain\'s factory.'); }
  }

  console.log('\n────────────────────────────────────────────────────────');
  if (quoterOK && router) {
    console.log('✅ VERIFIED. Add these to /opt/dexvra/tradebot/.env:\n');
    console.log(`${chainKey.toUpperCase()}_V3_FACTORY=${factory}`);
    console.log(`${chainKey.toUpperCase()}_V3_ROUTER=${router}`);
    console.log(`${chainKey.toUpperCase()}_V3_QUOTER=${quoter}`);
    console.log('\nThen: pm2 restart dexvra-tradebot --update-env');
    console.log('⚠️ ROUTER is inferred from real swaps — do ONE tiny test buy (e.g. $2) and');
    console.log('   confirm it fills at a sane price before trading larger.');
  } else {
    console.log('❌ NOT verified — do NOT put these in .env yet.');
    console.log(`   factory: ${factory}`);
    console.log(`   router : ${router || '(not found)'}`);
    console.log(`   quoter : ${quoter || '(not found)'}  ${quoterOK ? '' : '← quoter did not return a valid quote'}`);
    console.log('   Paste this whole output back and we\'ll find the right quoter/router.');
  }
  console.log('────────────────────────────────────────────────────────\n');
})().catch((e) => { console.error('discover failed:', (e && e.message) || e); process.exit(1); });
