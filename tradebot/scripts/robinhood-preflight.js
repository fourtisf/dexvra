'use strict';
/*
 * Robinhood Chain preflight — a READ-ONLY check of every address and interface the
 * launchpad (snipe + curve trading) path depends on. Spends nothing, signs nothing.
 *
 *   cd tradebot && node scripts/robinhood-preflight.js
 *   cd tradebot && node scripts/robinhood-preflight.js --token 0x<a pools.trade token>
 *   cd tradebot && node scripts/robinhood-preflight.js --discover
 *   cd tradebot && node scripts/robinhood-preflight.js --tx 0xTHE_REAL_HASH
 *
 * NOTE the placeholder style: `0x<hash>` pasted into bash is a REDIRECT, and the
 * shell dies with "syntax error near unexpected token" before node ever runs.
 *
 * WHY THIS EXISTS
 * The bot discovers launches exactly one way: it filters the launchpad factory for a
 * TokenCreated event whose 12-field signature is a compile-time constant (core.js
 * FACTORY_ABI), decoded against one hard-coded address (chains.js `factory`). Both were
 * inherited from the robinfun.io launchpad this bot was originally built against.
 *
 * If pools.trade — which is built on Uniswap's launchpad contracts — emits a different
 * event, or lives at a different address, then `queryFilter` matches nothing. eth_getLogs
 * returns an EMPTY ARRAY for a topic nothing emits; it does not error. So the snipe loop
 * runs forever, reports healthy, and never fires. That failure is invisible from inside
 * the process, which is exactly why it needs a script that looks from the outside.
 *
 * THE DECISIVE QUESTION is `--tx`: take one real pools.trade launch transaction, and this
 * prints the topic0 of every log it emitted next to the topic0 the bot filters for. If
 * they differ, no environment variable can fix the snipe and the launchpad interface has
 * to be taught the new event. If only the ADDRESS differs, FACTORY_ADDR alone fixes it.
 *
 * Exits non-zero if any check fails, so it can gate a deploy.
 */
const path = require('path');
const { ethers } = require('ethers');

// Load .env the way the bot does, so this checks the REAL configuration and not the
// defaults — a preflight that tests something other than what runs is worse than none.
try { require('dotenv').config({ path: path.join(__dirname, '..', '.env') }); } catch (_) { /* dotenv optional */ }

const core = require(path.join(__dirname, '..', 'core'));

const CHAIN = 'robinhood';
const argv = process.argv.slice(2);
const argOf = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? (argv[i + 1] || '') : ''; };
const TOKEN = argOf('--token').trim();
const TX = argOf('--tx').trim();
const SPAN = Math.max(100, Number(argOf('--blocks') || 5000));
const DISCOVER = argv.includes('--discover');

let failures = 0;
let warnings = 0;
const ok = (name, info) => console.log(`  ✅ ${name}${info ? '  · ' + info : ''}`);
const bad = (name, info) => { failures++; console.log(`  ❌ ${name}${info ? '  · ' + info : ''}`); };
const warn = (name, info) => { warnings++; console.log(`  ⚠️  ${name}${info ? '  · ' + info : ''}`); };
const note = (s) => console.log(`     ${s}`);

async function main() {
  const chain = core.chainOf(CHAIN);
  if (!chain) { console.error('No `robinhood` entry in chains.js'); process.exit(1); }

  // The exact topic the snipe loop filters for, derived from the ABI the bot actually
  // ships rather than a hash pasted into a comment — if someone edits FACTORY_ABI, this
  // number moves with it.
  const iface = new ethers.Interface(core.FACTORY_ABI);
  const ev = iface.getEvent('TokenCreated');
  const TOPIC0 = ev.topicHash;

  console.log('\nRobinhood Chain preflight');
  console.log('═'.repeat(72));
  console.log(`  rpc        ${chain.rpc}`);
  console.log(`  chainId    ${chain.chainId} (expected)`);
  console.log(`  factory    ${chain.factory}      ← launchpad: snipe + curveOf`);
  console.log(`  router     ${chain.router}      ← V2-style DEX`);
  console.log(`  weth       ${chain.weth}`);
  console.log(`  v3         ${chain.v3 && chain.v3.router ? chain.v3.router : '(unset — V3 routing OFF)'}`);
  console.log(`  explorer   ${chain.explorer}`);
  console.log('─'.repeat(72));
  console.log(`  TokenCreated topic0 the bot filters for:`);
  console.log(`  ${TOPIC0}`);
  console.log(`  ${ev.format('full')}`);
  console.log('═'.repeat(72));

  const prov = core.providerFor(CHAIN);

  // ── 1. the node ───────────────────────────────────────────────────────────
  console.log('\n1. Node');
  let head = null;
  try {
    // eth_chainId over the wire, NOT provider.getNetwork(): chains.js builds the
    // provider with `staticNetwork`, so getNetwork() returns the CONFIGURED chainId
    // without ever asking the node — it would print a green check for a claim it
    // never tested, which is the exact failure mode this script exists to catch.
    const raw = await prov.send('eth_chainId', []);
    const nodeId = Number(BigInt(raw));
    if (nodeId === Number(chain.chainId)) ok(`chainId ${nodeId}`, 'confirmed by the node');
    else bad('chainId MISMATCH', `node says ${nodeId}, chains.js says ${chain.chainId} — set CHAIN_ID or RPC`);
    head = await prov.getBlockNumber();
    ok(`head block ${head}`);
  } catch (e) {
    bad('RPC unreachable', (e && e.message) || String(e));
    console.log('\nCannot continue without the node. Fix RPC first.\n');
    process.exit(1);
  }

  // ── 2. the addresses are contracts ────────────────────────────────────────
  // A dead address is the cheapest possible explanation for "nothing ever works",
  // and nothing in the running bot ever checks it.
  console.log('\n2. Addresses have code');
  const codeOf = async (label, addr, fatal) => {
    if (!addr || !/^0x[a-fA-F0-9]{40}$/.test(addr)) { warn(`${label} not set`, String(addr || '(empty)')); return false; }
    try {
      const code = await prov.getCode(addr);
      if (!code || code === '0x') {
        const msg = `${addr} has NO CODE on chain ${chain.chainId} — this address is dead here`;
        if (fatal) bad(label, msg); else warn(label, msg);
        return false;
      }
      ok(label, `${addr} (${(code.length - 2) / 2} bytes)`);
      return true;
    } catch (e) { bad(label, (e && e.message) || String(e)); return false; }
  };
  const factoryLive = await codeOf('factory', chain.factory, true);
  await codeOf('router', chain.router, true);
  await codeOf('weth', chain.weth, true);
  if (chain.v3 && chain.v3.router) await codeOf('v3 router', chain.v3.router, false);

  // ── 3. does the factory speak the launchpad interface? ────────────────────
  // curveOf() is the single function the whole curve path hangs on: resolveCurve()
  // calls it, and a revert there is collapsed into '' — the same value that means
  // "this token genuinely has no curve" — so the bot routes to the DEX instead.
  console.log('\n3. Launchpad interface (curveOf)');
  if (!factoryLive) {
    warn('skipped', 'factory has no code');
  } else if (!TOKEN) {
    note('Pass --token 0x<a known pools.trade token> to probe curveOf().');
  } else if (!/^0x[a-fA-F0-9]{40}$/.test(TOKEN)) {
    bad('--token is not an address', TOKEN);
  } else {
    const fc = new ethers.Contract(chain.factory, core.FACTORY_ABI, prov);
    try {
      const curve = await fc.curveOf(TOKEN);
      if (!curve || curve === ethers.ZeroAddress) {
        warn('curveOf returned the ZERO address', 'the factory knows this interface but not this token');
        note('→ Either the token did not launch on THIS launchpad, or it already graduated.');
        note('  The bot reads this as "no curve" and trades it on the DEX.');
      } else {
        ok('curveOf', `${TOKEN} → curve ${curve}`);
        const cc = new ethers.Contract(curve, core.CURVE_ABI, prov);
        try { ok('curve.graduated()', String(await cc.graduated())); }
        catch (e) { bad('curve.graduated() REVERTED', 'the curve does not expose the ABI the bot encodes buys against'); note(`  ${(e && e.shortMessage) || (e && e.message) || e}`); }
        try { const [c, t] = await cc.graduationProgress(); ok('curve.graduationProgress()', `${ethers.formatEther(c)} / ${ethers.formatEther(t)}`); }
        catch (_) { warn('curve.graduationProgress() reverted', 'progress % will not render'); }
      }
    } catch (e) {
      bad('curveOf REVERTED / not present', `the contract at ${chain.factory} is not this launchpad`);
      note(`  ${(e && e.shortMessage) || (e && e.message) || e}`);
      note('→ This is the decisive symptom: every curve buy/sell on this chain silently');
      note('  falls through to DEX routing, and the token card says "no pool/curve found".');
    }
  }

  // ── 4. is anything emitting the event the snipe waits for? ────────────────
  // The whole point: an empty result here is NOT an error, and inside the bot it is
  // indistinguishable from a quiet market.
  console.log(`\n4. Launch feed — scanning the last ${SPAN} blocks for TokenCreated`);
  if (!factoryLive) {
    warn('skipped', 'factory has no code');
  } else {
    const from = Math.max(0, head - SPAN);
    try {
      const logs = await prov.getLogs({ address: chain.factory, topics: [TOPIC0], fromBlock: from, toBlock: head });
      if (logs.length) {
        ok(`${logs.length} launch event(s)`, `blocks ${from}–${head}`);
        for (const l of logs.slice(-3)) {
          try { const p = iface.parseLog(l); note(`latest: ${p.args.symbol || '?'} — ${p.args.token} (block ${l.blockNumber})`); }
          catch (_) { note(`log at block ${l.blockNumber} did not decode against FACTORY_ABI`); }
        }
        note('→ The snipe trigger is alive for THIS launchpad.');
      } else {
        bad('ZERO launch events', `nothing emitted ${TOPIC0.slice(0, 18)}… from ${chain.factory} in ${SPAN} blocks`);
        note('→ This is what a dead sniper looks like. Either this launchpad is idle, or');
        note('  (far more likely) pools.trade launches emit a DIFFERENT event, from a');
        note('  DIFFERENT address. Run this again with --tx <a real launch tx> to find out.');
      }
    } catch (e) {
      bad('getLogs failed', (e && e.message) || String(e));
      note('→ If this says the block range is too wide, retry with --blocks 500.');
    }

    // Same window, ignoring the topic: is the factory doing ANYTHING at all? This
    // separates "wrong event signature" from "wrong address entirely".
    try {
      const any = await prov.getLogs({ address: chain.factory, fromBlock: from, toBlock: head });
      if (any.length) {
        const topics = [...new Set(any.map((l) => (l.topics && l.topics[0]) || '(none)'))];
        note(`factory emitted ${any.length} log(s) of ${topics.length} distinct type(s) in this window:`);
        for (const t of topics.slice(0, 8)) note(`   ${t}${t === TOPIC0 ? '   ← the one the bot filters for' : ''}`);
        if (!topics.includes(TOPIC0)) note('→ The address is live but emits none of the events the bot understands.');
      } else {
        note('factory emitted NO logs of any kind in this window — it looks idle or unused.');
      }
    } catch (_) { /* best-effort */ }
  }

  // ── 4b. find the launchpad without needing a tx hash ──────────────────────
  // `--tx` settles it, but it asks the operator to go and find a launch
  // transaction by hand first. This asks the chain instead: scan recent blocks
  // for EVERY log, tally by (address, event), and print the busiest. On a chain
  // this size the launchpad is near the top, so the address the bot SHOULD be
  // watching usually falls out of the list.
  if (DISCOVER) {
    console.log(`\n4b. Who is actually emitting events  (--discover, last ${SPAN} blocks)`);
    const tally = new Map();   // `${address}|${topic0}` → count
    let scanned = 0, refused = 0;
    const STEP = 200;          // small window: an unfiltered getLogs is what most RPCs cap
    try {
      const head = await prov.getBlockNumber();
      for (let to = head; to > head - SPAN; to -= STEP) {
        const from = Math.max(head - SPAN + 1, to - STEP + 1);
        try {
          for (const lg of await prov.getLogs({ fromBlock: from, toBlock: to })) {
            const k = `${(lg.address || '').toLowerCase()}|${(lg.topics && lg.topics[0]) || ''}`;
            tally.set(k, (tally.get(k) || 0) + 1);
          }
          scanned += to - from + 1;
        } catch (_) { refused++; }   // rate limit / range cap — keep going, report at the end
      }
    } catch (e) { bad('could not read the head block', (e && e.message) || String(e)); }

    if (refused) note(`${refused} block range(s) refused by the RPC — the counts below are a sample, not a census`);
    if (!tally.size) {
      bad('no logs at all in that window', `${scanned} block(s) scanned`);
      note('Either the chain is idle, or this RPC will not serve unfiltered getLogs.');
    } else {
      const rows = [...tally.entries()].map(([k, n]) => { const [addr, t0] = k.split('|'); return { addr, t0, n }; })
        .sort((a, b) => b.n - a.n).slice(0, 10);
      const cfg = String(chain.factory || '').toLowerCase();

      // A topic0 is a keccak hash: unreadable, and not reversible. But a
      // VERIFIED contract publishes its ABI, so the explorer can name the event
      // for us. Without this the operator is handed ten rows of hex and asked
      // to recognise a launchpad in it — which is the manual step this mode
      // exists to remove. Best-effort throughout: an unverified contract, a
      // rate limit or an explorer that speaks a different API just leaves the
      // hash unnamed.
      const names = new Map();   // topic0 → "EventName"
      for (const addr of [...new Set(rows.map((r) => r.addr))]) {
        try {
          const base = String(chain.explorer || '').replace(/\/+$/, '');
          if (!base) break;
          const res = await fetch(`${base}/api?module=contract&action=getabi&address=${addr}`,
            { signal: AbortSignal.timeout(8000) });
          const j = await res.json();
          if (!j || j.status !== '1' || typeof j.result !== 'string') continue;
          const abi = JSON.parse(j.result);
          const iface = new ethers.Interface(abi);
          iface.forEachEvent((ev) => names.set(ev.topicHash.toLowerCase(), ev.name));
        } catch (_) { /* unverified / unreachable / different API — leave it unnamed */ }
      }

      console.log('');
      for (const r of rows) {
        const mine = r.addr === cfg ? '  ← the factory the bot watches' : '';
        const nm = names.get(r.t0.toLowerCase());
        console.log(`     ${String(r.n).padStart(5)}×  ${r.addr}  ${nm ? nm.padEnd(20) : r.t0.slice(0, 18) + '…'}${mine}`);
      }
      if (!names.size) note('(no event names — none of these contracts are verified on the explorer, or its API differs)');
      console.log('');
      if (!rows.some((r) => r.addr === cfg)) {
        note(`FACTORY_ADDR (${chain.factory}) emitted nothing in this window.`);
        note('If a launchpad is in that list, that address is what FACTORY_ADDR should be —');
        note('confirm with --tx on one of its transactions before changing anything.');
      }
    }
  } else {
    console.log('\n4b. Who is actually emitting events');
    note('Re-run with --discover to scan recent blocks and see which contracts are live.');
  }

  // ── 5. the decisive check ─────────────────────────────────────────────────
  // Everything above can only say "the thing we look for is not there". Only a real
  // launch transaction can say what IS there.
  console.log('\n5. What a real launch actually emits  (--tx)');
  if (!TX) {
    note('Pass --tx followed by the hash of a real pools.trade launch to settle this.');
    note('Find one: open a new token on pools.trade → its creation tx on the explorer.');
  } else if (!/^0x[a-fA-F0-9]{64}$/.test(TX)) {
    bad('--tx is not a transaction hash', TX);
  } else {
    try {
      const rc = await prov.getTransactionReceipt(TX);
      if (!rc) { bad('transaction not found', TX); }
      else {
        ok('receipt', `block ${rc.blockNumber}, ${rc.logs.length} log(s)`);
        console.log('');
        const byAddr = new Map();
        for (const l of rc.logs) {
          const a = String(l.address).toLowerCase();
          if (!byAddr.has(a)) byAddr.set(a, []);
          byAddr.get(a).push(l);
        }
        for (const [addr, logs] of byAddr) {
          const isCfg = addr === String(chain.factory).toLowerCase();
          console.log(`     ${addr}${isCfg ? '   ← chains.js factory' : ''}`);
          for (const l of logs) {
            const t0 = (l.topics && l.topics[0]) || '(anonymous)';
            const match = t0 === TOPIC0;
            console.log(`       topic0 ${t0}${match ? '   ✅ MATCHES the bot' : ''}`);
            console.log(`              ${l.topics.length - 1} indexed arg(s), ${(l.data.length - 2) / 2} bytes of data`);
          }
        }
        console.log('');
        const anyMatch = rc.logs.some((l) => l.topics && l.topics[0] === TOPIC0);
        const fromCfg = rc.logs.some((l) => String(l.address).toLowerCase() === String(chain.factory).toLowerCase());
        if (anyMatch && fromCfg) {
          ok('VERDICT: this launch is fully compatible', 'the bot can snipe it as configured');
        } else if (anyMatch && !fromCfg) {
          const emitter = rc.logs.find((l) => l.topics && l.topics[0] === TOPIC0).address;
          warn('VERDICT: right event, WRONG ADDRESS', 'config-only fix');
          note(`→ Set FACTORY_ADDR=${emitter} in tradebot/.env and restart.`);
        } else {
          bad('VERDICT: this launch emits nothing the bot understands', 'code change required');
          note('→ No environment variable fixes this. The launchpad interface (core.js');
          note('  FACTORY_ABI / CURVE_ABI) is hard-wired to a different launchpad, and must');
          note('  learn this event signature before a snipe can ever fire.');
          note('  Give the topic0 above, plus the launch contract\'s verified ABI, to whoever');
          note('  implements it — those two facts are the whole blocker.');
        }
      }
    } catch (e) { bad('receipt lookup failed', (e && e.message) || String(e)); }
  }

  // ── 6. DEX side, for graduated tokens ─────────────────────────────────────
  console.log('\n6. DEX routing (graduated tokens)');
  try {
    const r = new ethers.Contract(chain.router, ['function factory() view returns (address)'], prov);
    const f = await r.factory();
    if (!f || f === ethers.ZeroAddress) bad('router.factory()', 'returned the zero address');
    else {
      ok('router.factory()', f);
      if (TOKEN && /^0x[a-fA-F0-9]{40}$/.test(TOKEN)) {
        try {
          const fc = new ethers.Contract(f, ['function getPair(address,address) view returns (address)'], prov);
          const pair = await fc.getPair(TOKEN, chain.weth);
          if (!pair || pair === ethers.ZeroAddress) warn('getPair', 'no V2 pair for this token/WETH — it is pre-graduation, or it lives in a V3 pool');
          else ok('getPair', pair);
        } catch (e) { warn('getPair failed', (e && e.shortMessage) || (e && e.message) || e); }
      }
    }
  } catch (e) {
    bad('router does not expose factory()', `${chain.router} is not a V2-style router here`);
    note(`  ${(e && e.shortMessage) || (e && e.message) || e}`);
  }
  if (!(chain.v3 && chain.v3.factory && chain.v3.router)) {
    note('V3 routing is OFF (ROBINHOOD_V3_FACTORY / ROBINHOOD_V3_ROUTER unset).');
    note('If graduated pools.trade tokens live in V3 pools, they are untradeable until');
    note('these are set — use scripts/v3-discover.js <poolAddress> robinhood.');
  }

  // ── summary ───────────────────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(72));
  if (failures) {
    console.log(`  ${failures} check(s) FAILED, ${warnings} warning(s).`);
    console.log('  The launchpad path is not working as configured. Read the → notes above.');
  } else if (warnings) {
    console.log(`  All checks passed with ${warnings} warning(s).`);
  } else {
    console.log('  All checks passed.');
  }
  console.log('═'.repeat(72) + '\n');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error('\npreflight crashed:', (e && e.stack) || e); process.exit(1); });
