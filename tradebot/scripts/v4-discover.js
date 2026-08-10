'use strict';
/*
 * v4-discover — find a chain's Uniswap V4 PoolManager, from a token that trades
 * on one of its pools.
 *
 * Usage (run on the VPS, inside tradebot/):
 *   node scripts/v4-discover.js <token-address> [chainKey] [--blocks 200000]
 *
 * Why this exists: v4 has no factory and no pair contract. Every pool lives
 * inside ONE PoolManager, so there is nothing to look up and no address to
 * derive — it has to be observed. The PoolManager emits Initialize(...) when a
 * pool is created, and that log carries the WHOLE PoolKey: both currencies, the
 * fee, the tick spacing and the hooks. So: scan back for an Initialize whose
 * currency0/currency1 is this token, and whatever contract emitted it IS the
 * PoolManager for this deployment.
 *
 * Read-only. Spends nothing, signs nothing.
 *
 * It prints a ready-to-paste ENV block at the BOTTOM, and verifies the address
 * it found by reading the pool back through the same path the bot will use — so
 * a PASS here means the bot will price the token, not just that a log matched.
 */
const { ethers } = require('ethers');
const chains = require('../chains');
const v4 = require('../v4');

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const flag = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const token = (args[0] || '').trim();
const chainKey = (args[1] || chains.DEFAULT_CHAIN).trim();
const BLOCKS = Math.max(1, Number(flag('blocks', 200000)));
// Public RPCs cap eth_getLogs ranges; 10k is the common ceiling.
const STEP = Math.max(1, Number(flag('step', 9000)));

if (!ethers.isAddress(token)) {
  console.error('usage: node scripts/v4-discover.js <token-address> [chainKey] [--blocks N] [--step N]');
  process.exit(1);
}
const chain = chains.chainOf(chainKey);
if (!chain) { console.error(`unknown chain "${chainKey}" — one of: ${chains.ENABLED.join(', ')}`); process.exit(1); }

// Uniswap v4 PoolManager:
//   event Initialize(PoolId indexed id, Currency indexed currency0,
//                    Currency indexed currency1, uint24 fee, int24 tickSpacing,
//                    IHooks hooks, uint160 sqrtPriceX96, int24 tick)
// The signature is hashed at runtime rather than pasted as a constant, so a
// typo in a 32-byte literal can't send this hunting for an event that does not
// exist and report "no v4 pool" about a chain that has one.
const INIT_SIG = 'Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)';
const INIT_TOPIC = ethers.id(INIT_SIG);
const asTopic = (addr) => ethers.zeroPadValue(ethers.getAddress(addr), 32);

(async function main() {
  const prov = chains.providerFor(chainKey);
  const head = await prov.getBlockNumber();
  const from = Math.max(0, head - BLOCKS);
  console.log(`🔎 ${chain.name} · token ${token}`);
  console.log(`   scanning blocks ${from} → ${head} for a v4 Initialize log (step ${STEP})\n`);

  // The token is currency0 OR currency1 — both indexed, so it takes two filters.
  const found = [];
  for (let lo = head; lo > from && !found.length; lo -= STEP) {
    const hi = lo;
    const start = Math.max(from, lo - STEP + 1);
    for (const topics of [[INIT_TOPIC, null, asTopic(token)], [INIT_TOPIC, null, null, asTopic(token)]]) {
      let logs = [];
      try { logs = await prov.getLogs({ fromBlock: start, toBlock: hi, topics }); }
      catch (e) { console.log(`   … blocks ${start}-${hi}: ${(e && (e.shortMessage || e.message)) || e}`); continue; }
      for (const l of logs) found.push(l);
    }
    if (found.length) console.log(`   ✔ hit in blocks ${start}-${hi}`);
  }

  if (!found.length) {
    console.log('❌ No v4 Initialize log for this token in the scanned range.');
    console.log('   Widen it (--blocks 1000000), or the pool may predate the range / be on another chain.');
    process.exit(2);
  }

  const iface = new ethers.Interface([`event ${INIT_SIG}`]);
  const seen = new Map();   // poolManager → [pool keys]
  for (const l of found) {
    let d; try { d = iface.parseLog(l); } catch (_) { continue; }
    const pm = ethers.getAddress(l.address);
    if (!seen.has(pm)) seen.set(pm, []);
    seen.get(pm).push({
      id: d.args[0], currency0: d.args[1], currency1: d.args[2],
      fee: Number(d.args[3]), tickSpacing: Number(d.args[4]), hooks: d.args[5], block: l.blockNumber,
    });
  }

  let best = null;
  for (const [pm, keys] of seen) {
    console.log(`\n📦 PoolManager candidate: ${pm}   (${keys.length} pool${keys.length === 1 ? '' : 's'})`);
    for (const k of keys) {
      const hooked = k.hooks !== ethers.ZeroAddress;
      console.log(`   · fee ${k.fee} · tickSpacing ${k.tickSpacing} · hooks ${hooked ? k.hooks + ' ⚠️' : 'none'}`);
      console.log(`     currency0 ${k.currency0}${k.currency0 === ethers.ZeroAddress ? '  (native ETH)' : ''}`);
      console.log(`     currency1 ${k.currency1}`);
      console.log(`     poolId ${k.id} · block ${k.block}`);
      // The id in the log is authoritative. If our own poolId() reproduces it,
      // the key encoding matches this deployment — if it does not, the bot would
      // compute the wrong id and find nothing however correct the address is.
      const mine = v4.poolId(String(k.currency0).toLowerCase(), String(k.currency1).toLowerCase(), k.fee, k.tickSpacing, k.hooks);
      console.log(`     poolId check: ${mine.toLowerCase() === String(k.id).toLowerCase() ? '✅ matches' : '❌ MISMATCH — ' + mine}`);
      if (!best && !hooked) best = { pm, k };
      if (hooked) console.log('     ⚠️ hooked pool — this bot only sweeps hookless keys, so it will not find this one');
    }
    if (!best && keys.length) best = { pm, k: keys[0] };
  }

  // Verify end to end: set the env the bot reads, then ask the bot's own reader.
  if (best) {
    const P = chainKey.toUpperCase();
    process.env[`${P}_V4_POOLMANAGER`] = best.pm;
    const dec = await new ethers.Contract(token, ['function decimals() view returns (uint8)'], prov).decimals().catch(() => 18);
    const px = await v4.price(token, chainKey, Number(dec), { chainOf: chains.chainOf, providerFor: chains.providerFor }).catch((e) => ({ err: e }));
    console.log('\n──────── verification (the bot\'s own reader) ────────');
    if (px && px.priceEth > 0) {
      console.log(`✅ priced: ${px.priceEth} ${chain.native} per token · fee ${px.fee} · tickSpacing ${px.tickSpacing}`);
      console.log(`   quote currency: ${px.quote === v4.NATIVE ? 'native ETH' : px.quote}`);
    } else {
      console.log('❌ the reader could not price it with this PoolManager.');
      console.log(`   If the poolId check above MATCHED, the storage slot is the likely culprit — try ${P}_V4_POOLS_SLOT=<n>,`);
      console.log('   or deploy/point at a StateView with ' + P + '_V4_STATEVIEW=<address>.');
      if (px && px.err) console.log('   ' + ((px.err.shortMessage || px.err.message) || px.err));
    }
    console.log('\n──────── paste into tradebot/.env ────────');
    console.log(`${P}_V4_POOLMANAGER=${best.pm}`);
    if (best.k.fee && !v4.DEFAULT_TIERS.some(([f, t]) => f === best.k.fee && t === best.k.tickSpacing)) {
      console.log(`${P}_V4_FEE_TIERS=${v4.DEFAULT_TIERS.map(([f, t]) => `${f}:${t}`).join(',')},${best.k.fee}:${best.k.tickSpacing}`);
      console.log(`# ↑ this pool's fee/tickSpacing is not one of the four the sweep tries by default`);
    }
    console.log('\nThen: pm2 restart dexvra-tradebot --update-env');
  }
})().catch((e) => { console.error('failed:', (e && (e.stack || e.message)) || e); process.exit(1); });
