#!/usr/bin/env node
'use strict';
/*
 * abi:check — CAN THIS BOX READ A CONTRACT'S PUBLISHED ABI, AND WHAT DOES IT SAY?
 *
 * WHY THIS EXISTS AND WHY IT IS NOT A TEST
 * Whether an explorer answers is a property of this server's egress today, not
 * of the code — the rule raid:check, launchpads:check, fonts:check and
 * chart:check all state. This says it about the source that decides whether a
 * launchpad curve can be traded from a PUBLISHED interface or only from an
 * inferred one, which is the difference between knowing an argument is called
 * `minTokensOut` and merely knowing it tracks the amount.
 *
 *   node scripts/abi-check.js 0x<contract>
 *   node scripts/abi-check.js 0x<token> --curve      # find the curve first, then read it
 *   node scripts/abi-check.js 0x<contract> --chain robinhood
 *
 * ⚠️ IT DRIVES abiSource.js, NOT A COPY OF THE REQUEST. Checking this by hand
 * with curl reported `301 Moved Permanently` and looked like a dead end — curl
 * does not follow redirects unless told, and the bot's fetch does. A check that
 * measures something other than what the bot does is how fonts:check printed
 * nine green ticks over a banner drawing boxes.
 */
const path = require('node:path');
const fs = require('node:fs');

// tradebot has no `dotenv` — core.js carries a zero-dependency loader and the
// same rule applies here: a real environment variable always wins, and this
// MUST run before requiring chains.js, which reads env at module-eval time
// (ROBINHOOD_V3_FACTORY and friends). Loading it afterwards silently leaves
// those empty, which is how V3 was once disabled without a word.
(function loadDotEnv() {
  try {
    const file = path.join(__dirname, '..', '.env');
    if (!fs.existsSync(file)) return;
    for (let line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      line = line.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq < 0) continue;
      const k = line.slice(0, eq).trim();
      if (!k || process.env[k] !== undefined) continue;
      let v = line.slice(eq + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      process.env[k] = v;
    }
  } catch (_) { /* a check must not die on a malformed .env */ }
})();

const { chainOf } = require('../chains.js');
const abi = require('../abiSource.js');
const { decodeCurveIface, classifySlots, describeIface } = require('../curveIface.js');

const G = '\x1b[32m', R = '\x1b[31m', Y = '\x1b[33m', C = '\x1b[36m', D = '\x1b[2m', X = '\x1b[0m';
const argv = process.argv.slice(2);
const flag = (n) => argv.includes('--' + n);
const optOf = (n) => { const i = argv.indexOf('--' + n); return i >= 0 ? (argv[i + 1] || '') : ''; };
const target = argv.find((a) => /^0x[a-fA-F0-9]{40}$/.test(a)) || '';
const chainKey = optOf('chain') || 'robinhood';

function stamp() {
  try {
    const { execSync } = require('node:child_process');
    const sha = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    const dirty = execSync('git status --porcelain --untracked-files=no', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    return dirty ? `${sha}+dirty` : sha;
  } catch (_) { return 'unknown'; }
}

async function main() {
  console.log(`\nCan this box read a published ABI?   ${D}checkout ${stamp()} · chain ${chainKey}${X}`);
  const chain = chainOf(chainKey);
  if (!chain) { console.log(`${R}unknown chain ${chainKey}${X}\n`); process.exit(1); }
  if (!target) {
    console.log(`\n${Y}usage:${X} node scripts/abi-check.js 0x<contract>   ${D}(add --curve to resolve a token's curve first)${X}\n`);
    process.exit(1);
  }
  console.log(`${D}  explorer ${chain.explorer || '(none configured)'}${X}\n`);

  let contract = target;
  let observed = null;

  // --curve: the address given is a TOKEN, so find the contract its trades go
  // through before asking the explorer about it.
  if (flag('curve')) {
    const { ethers } = require('ethers');
    const prov = new ethers.JsonRpcProvider(chain.rpc, undefined, { staticNetwork: true });
    const head = await prov.getBlockNumber();
    console.log(`${C}1. Which contract does ${target} trade through?${X}`);
    observed = await decodeCurveIface(prov, target, { head, blocks: Number(optOf('blocks')) || 50000 });
    if (!observed.ok) { console.log(`   ${R}✗${X} ${observed.why}\n`); process.exit(1); }
    contract = observed.curve;
    console.log(`   ${G}✓${X} ${describeIface(observed)}\n`);
  }

  console.log(`${C}2. Is ${contract} verified on the explorer?${X}`);
  const got = await abi.fetchVerifiedAbi(chain.explorer, contract);
  if (!got.ok) {
    // ⚠️ Unreachable is RED, unverified is amber — they lead to opposite next
    // steps, and printing both the same way is what made a Cloudflare 403 look
    // like a settled question.
    console.log(got.reachable ? `   ${Y}·${X} ${got.why}` : `   ${R}✗${X} ${got.why}`);
    if (!got.reachable) console.log(`     ${D}this box could not ASK — that is not the same as the contract being unverified${X}`);
  } else {
    console.log(`   ${G}✓${X} ${got.abi.length} entries via ${got.source}${got.name ? ` — ${got.name}` : ''}`);
    const fns = got.abi.filter((e) => e && e.type === 'function');
    console.log(`   ${D}${fns.length} function(s)${X}`);
    if (observed && observed.buy) {
      // ⚠️ THE MATCH IS THE VERIFICATION. An explorer serves an ABI for a proxy
      // or for whatever somebody verified at that address; the selector we
      // watched execute has to be in it.
      const e = abi.entryForSelector(got.abi, observed.buy.selector);
      if (!e) {
        console.log(`   ${R}✗${X} the observed buy selector ${observed.buy.selector} is NOT in this ABI`);
        console.log(`     ${D}so the ABI describes some other contract (a proxy, or a different implementation)${X}`);
      } else {
        console.log(`   ${G}✓${X} the observed buy is ${C}${e.signature}${X}`);
        const published = abi.rolesOfEntry(e);
        for (const p of published) console.log(`       arg[${p.i}] ${p.type} ${p.name || ''} ${D}→ ${p.role}${X}`);
        const inferred = classifySlots(observed.buy, target).slots;
        const rec = abi.reconcile(published, inferred);
        console.log(rec.ok
          ? `   ${G}✓${X} the ABI and the observed trades AGREE — this curve can be built safely`
          : `   ${R}✗${X} ${rec.why}`);
      }
    }
  }

  if (observed && observed.buy) {
    console.log(`\n${C}3. What does the 4-byte registry say about ${observed.buy.selector}?${X}`);
    const fb = await abi.fourByteSignatures(observed.buy.selector);
    if (!fb.ok) console.log(`   ${Y}·${X} ${fb.why}`);
    else for (const s of fb.signatures) console.log(`   ${D}·${X} ${s}`);
  }
  console.log('');
}

main().catch((e) => { console.error(e); process.exit(1); });
