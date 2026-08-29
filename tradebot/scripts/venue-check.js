#!/usr/bin/env node
'use strict';
/*
 * venue:check — WHAT KIND OF MARKET IS THIS TOKEN'S, AND CAN WE ROUTE IT?
 *
 * WHY THIS EXISTS
 * A token can be indexed, priced, and still unroutable, and the card says only
 * that: "liquidity is on <X>, which Dexvra can't route through yet". Three
 * completely different venues produce that one sentence — a bonding curve whose
 * interface we could not read, a Uniswap-v4-style router, or an AMM whose
 * factory we do not know — and they need three different fixes.
 *
 * `abi:check --curve` answers a NEIGHBOURING question by scanning up to 200,000
 * blocks for the token's own transfers. On the node this matters for that is
 * slow enough to be abandoned, and it was. This asks the shorter question in
 * about five requests, because the indexer already knows the pair address and a
 * pair contract will say what it is if you ask it.
 *
 * ⚠️ NOTHING HERE IS A ROUTING DECISION. It reads and it prints. Every address
 * it reports came from the chain or from the indexer, and the bot still proves
 * a venue for itself before it will sign anything — the rule the whole curve
 * and v4-calldata work is built on.
 */
const { ethers } = require('ethers');
const { chainOf, enabledChains } = require('../chains.js');
const build = require('../build.js');

/*
 * ⚠️ A PORT OF core.js's `DS_CHAIN_KEY`, AND A PORT IS A SECOND OWNER.
 *
 * The real map is a private const in core.js, and requiring core from a script
 * boots the whole trade bot — pollers, monitors and all. So it is copied, and
 * `venueCheck.test.js` asserts the copy EQUALS the original by reading core.js's
 * source: a stale slug here makes this check report "no pair" for a token the
 * bot prices perfectly well, which is a diagnostic lying in the reassuring
 * direction. Same guard `market:check`'s ported chain map carries, for the same
 * reason.
 */
const DS_SLUG = { ethereum: 'ethereum', base: 'base', bsc: 'bsc', arbitrum: 'arbitrum', solana: 'solana', robinhood: 'robinhood' };

module.exports = { DS_SLUG };

const argv = process.argv.slice(2);
const optOf = (n) => { const i = argv.indexOf('--' + n); return i >= 0 ? (argv[i + 1] || '') : ''; };
const token = argv.find((a) => /^0x[a-fA-F0-9]{40}$/.test(a)) || '';

const C = '\x1b[36m', G = '\x1b[32m', R = '\x1b[31m', Y = '\x1b[33m', D = '\x1b[2m', X = '\x1b[0m';
const ok = (m) => console.log(`   ${G}✓${X} ${m}`);
const bad = (m) => console.log(`   ${R}✗${X} ${m}`);
const warn = (m) => console.log(`   ${Y}⚠${X} ${m}`);
const note = (m) => console.log(`     ${D}${m}${X}`);

/*
 * ⚠️ NO PASTEABLE COMMAND WITH A PLACEHOLDER IN IT — this repo's first rule, and
 * one it has now been bitten by four times. Only the operator knows which token
 * they mean, so the argument is DESCRIBED and no command is printed at all.
 * `<...>` in a shell dies as a redirect before the script even runs.
 */
if (require.main === module && !token) {
  console.log(`\n${C}venue:check${X} — what kind of market does a token have, and can Dexvra route it?\n`);
  console.log('Run it with the token contract address as the argument, and');
  console.log('optionally --chain <key> (default: the first enabled chain).');
  console.log(`\nEnabled chains: ${enabledChains().map((c) => c.key).join(', ')}\n`);
  process.exit(2);
}

const IFACE = new ethers.Interface([
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function getReserves() view returns (uint112,uint112,uint32)',
  'function factory() view returns (address)',
  'function fee() view returns (uint24)',
  'function swapFee() view returns (uint256)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
]);

/** One eth_call, decoded, or null. A revert here is an ANSWER: the contract does
 *  not have that function, which is exactly what we are testing for. */
async function callOr(prov, to, fn, args = []) {
  try {
    const data = IFACE.encodeFunctionData(fn, args);
    const raw = await prov.call({ to, data });
    if (!raw || raw === '0x') return null;
    const out = IFACE.decodeFunctionResult(fn, raw);
    return out.length === 1 ? out[0] : out;
  } catch (_) { return null; }
}


/** The indexer's pair for this token on this chain — one HTTP request. */
async function dsPair(chainKey, ca) {
  const slug = DS_SLUG[chainKey] || chainKey;
  const url = `https://api.dexscreener.com/latest/dex/tokens/${ca}`;
  let r;
  try { r = await fetch(url, { signal: AbortSignal.timeout(8000), headers: { accept: 'application/json' } }); }
  catch (e) { return { ok: false, why: `could not reach DexScreener (${(e && e.message) || e})` }; }
  if (!r.ok) return { ok: false, why: `DexScreener answered HTTP ${r.status}` };
  const j = await r.json().catch(() => null);
  const pairs = ((j && j.pairs) || []).filter((p) => String(p.chainId).toLowerCase() === slug);
  if (!pairs.length) return { ok: true, pair: null, why: `DexScreener has no ${slug} pair for this token` };
  // Deepest first — a token seen through a thin pool reads as a different asset.
  pairs.sort((a, b) => Number((b.liquidity || {}).usd || 0) - Number((a.liquidity || {}).usd || 0));
  return { ok: true, pair: pairs[0], why: null };
}

if (require.main === module) (async () => {
  const chainKey = optOf('chain') || (enabledChains()[0] || {}).key;
  const chain = chainOf(chainKey);
  if (!chain) { bad(`unknown chain "${chainKey}"`); process.exit(2); }

  console.log(`\n${C}What kind of market does ${token} have?${X}`);
  console.log(`   ${D}checkout ${build.stamp()} · chain ${chainKey}${X}\n`);

  const prov = new ethers.JsonRpcProvider(chain.rpc, undefined, { staticNetwork: true, batchMaxCount: 1 });

  // ── 1. what does the indexer say? ────────────────────────────────────────
  console.log(`${C}1. What the indexer sees${X}`);
  const ds = await dsPair(chainKey, token);
  if (!ds.ok) { bad(ds.why); note('this run says nothing about the token — it is about reaching DexScreener'); }
  else if (!ds.pair) { warn(ds.why); }
  else {
    const p = ds.pair;
    ok(`${p.baseToken && p.baseToken.symbol} · dex "${p.dexId}" · liquidity $${Number((p.liquidity || {}).usd || 0).toLocaleString()}`);
    note(`pair address ${p.pairAddress}`);
  }

  const pair = ds.ok && ds.pair ? String(ds.pair.pairAddress) : '';
  if (!pair) {
    console.log(`\n${R}No pair address to probe.${X} Without one there is nothing on-chain to ask.\n`);
    process.exit(1);
  }

  // ── 2. is that pair a Uniswap-V2-style contract? ─────────────────────────
  console.log(`\n${C}2. Is that a Uniswap-V2-style pair? ${D}(one eth_call each)${X}`);
  const [t0, t1, res, fac] = await Promise.all([
    callOr(prov, pair, 'token0'),
    callOr(prov, pair, 'token1'),
    callOr(prov, pair, 'getReserves'),
    callOr(prov, pair, 'factory'),
  ]);
  const lc = (s) => String(s || '').toLowerCase();
  const isV2 = !!(t0 && t1 && res);
  if (isV2) {
    const mine = lc(t0) === lc(token) || lc(t1) === lc(token);
    ok(`token0 ${t0}`);
    ok(`token1 ${t1}`);
    ok(`reserves ${res[0]} / ${res[1]}`);
    if (fac) ok(`factory ${fac}`); else warn('no factory() — a fork that does not expose it');
    if (!mine) {
      bad('…but neither side is the token asked about — this pair is somebody else\'s');
    } else {
      const quote = lc(t0) === lc(token) ? t1 : t0;
      const [qs, fee, sfee] = await Promise.all([
        callOr(prov, quote, 'symbol'),
        callOr(prov, pair, 'fee'),
        callOr(prov, pair, 'swapFee'),
      ]);
      console.log(`\n${G}VERDICT: a Uniswap-V2-style pair, quoted in ${qs || quote}.${X}`);
      note(`quote token ${quote}`);
      note(fee != null ? `pool fee() = ${fee}` : (sfee != null ? `pool swapFee() = ${sfee}` : 'no fee()/swapFee() — the fork does not publish it'));
      if (fac && lc(fac) === lc(chain.factory || '')) note('and its factory is the one Dexvra already routes through');
      else note(`Dexvra's configured V2 factory is ${chain.factory || '(none)'} — this pair is from a different one`);
    }
  } else {
    warn('not a V2-style pair — token0()/token1()/getReserves() did not all answer');
    note('so it is a v4-style singleton, a bonding curve, or a custom AMM');
  }

  // ── 3. what does a real trade actually call? ─────────────────────────────
  console.log(`\n${C}3. What does a real trade call? ${D}(the pair's own logs — narrow, not a scan)${X}`);
  let head = 0;
  try { head = Number(await prov.getBlockNumber()); } catch (e) { bad(`could not read the chain head (${(e && e.message) || e})`); }
  let logs = [];
  const SPAN = Math.max(200, Number(optOf('blocks') || 20000));
  if (head) {
    try { logs = await prov.getLogs({ address: pair, fromBlock: Math.max(0, head - SPAN), toBlock: head }) || []; }
    catch (e) { warn(`getLogs refused (${(e && e.shortMessage) || e.message || e})`); }
  }
  if (!logs.length) {
    warn(`no logs from the pair in the last ${SPAN} blocks`);
    note('a quiet pair, or this node caps ranges — rerun with --blocks and a smaller number');
  } else {
    const seen = new Map();
    for (let i = logs.length - 1; i >= 0 && seen.size < 4; i--) {
      const h = logs[i].transactionHash;
      if (h && !seen.has(h)) seen.set(h, true);
    }
    for (const h of seen.keys()) {
      const tx = await prov.getTransaction(h).catch(() => null);
      if (!tx || !tx.data) continue;
      const sel = String(tx.data).slice(0, 10);
      const words = Math.floor((String(tx.data).length - 10) / 64);
      ok(`to ${tx.to}  selector ${sel}  ${words} word(s)  value ${ethers.formatEther(tx.value || 0n)}`);
      note(`tx ${h}`);
    }
    note('the "to" above is the ROUTER a trade goes through; the selector is what identifies it');
  }

  console.log('');
})().catch((e) => { bad(`venue:check failed (${(e && e.stack) || e})`); process.exit(1); });
