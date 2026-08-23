#!/usr/bin/env node
'use strict';
/*
 * seed:chain — bring a chain UP TO N listings from its own biggest tokens.
 *
 * "tambahkan token chain bsc base eth 50 token top nya memecoin atau apa bebas
 * tidak perlu di announce cukup tambahkan aja tokennya" — the chain chips read
 * BSC 23 · Base 10 · Ethereum 9 and needed filling out. This lists them on the
 * site and posts NOTHING to any channel: `services/chainSeed.js` lists with the
 * `free` package through `autoLister.createFromInfo`, which has no announce
 * path at all (only the scan loop announces, and only with a `tg` this script
 * never constructs).
 *
 * ⚠️ DRY RUN by default. It creates real, public rows on dexvra.io, so the
 * shape of the run is readable before it is irreversible — `--apply` writes.
 */
// ⚠️ .env FIRST, before anything requires config/constants.
//
// `config/constants.js` freezes every value at require time, so a standalone
// script that requires repo code first reads an EMPTY environment and then
// reports that as a fact about the server — "INTERNAL_API_TOKEN is not set" on
// a box where it plainly is. `loadEnv()` is the one owner of which .env this
// process reads; a bare `require("dotenv").config()` here would be a private
// fourth idea of it, resolved against the CWD alone.
require("../src/config/loadEnv").loadEnv();

const seeder = require('../src/services/chainSeed');
const { chainOf } = require('../src/config/chains');

const G = '\x1b[32m', R = '\x1b[31m', Y = '\x1b[33m', D = '\x1b[2m', B = '\x1b[1m', X = '\x1b[0m';

// The operator types what the chips say. `chainOf` is an exact match on the
// registry id, so `eth` would bounce as "unknown chain" for a chain the site
// carries — the wrong-chain dead end, in a CLI.
const ALIAS = { eth: 'ethereum', ether: 'ethereum', bnb: 'bsc', binance: 'bsc', avax: 'avalanche', sol: 'solana', matic: 'polygon', arb: 'arbitrum', op: 'optimism' };
const resolve = (s) => {
  const k = String(s || '').trim().toLowerCase();
  return ALIAS[k] || k;
};

const num = (s, dflt) => {
  const n = Number(String(s).replace(/[_,$]/g, ''));
  return Number.isFinite(n) && n >= 0 ? n : dflt;
};

function usage() {
  console.log(`
${B}seed:chain${X} — list a chain's biggest tokens until it reaches a target count

  npm run seed:chain -- bsc base ethereum
  npm run seed:chain -- bsc base ethereum --apply

Options
  --target=N      how many listings the chain should END UP with (default ${seeder.DEFAULTS.target})
  --min-mcap=N    floor on market cap  (default ${seeder.DEFAULTS.minMcap.toLocaleString('en-US')})
  --min-liq=N     floor on liquidity   (default ${seeder.DEFAULTS.minLiq.toLocaleString('en-US')})
  --apply         actually create the listings (without it, nothing is written)

The target is UP TO, not add-N: a chain already at the target lists nothing, so
re-running after a half-finished pass is safe. Nothing is posted to any channel.
`);
}

(async () => {
  const argv = process.argv.slice(2);
  if (!argv.length || argv.includes('--help') || argv.includes('-h')) {
    usage();
    process.exit(argv.length ? 0 : 1);
  }

  const flags = argv.filter((a) => a.startsWith('--'));
  const chains = argv.filter((a) => !a.startsWith('--')).map(resolve);
  const flag = (name) => {
    const hit = flags.find((f) => f.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : null;
  };
  const apply = flags.includes('--apply');
  const opts = {
    target: num(flag('target'), seeder.DEFAULTS.target),
    minMcap: num(flag('min-mcap'), seeder.DEFAULTS.minMcap),
    minLiq: num(flag('min-liq'), seeder.DEFAULTS.minLiq),
    apply,
  };

  const bad = chains.filter((c) => !chainOf(c));
  if (bad.length) {
    console.error(`\n${R}✗${X} unknown chain: ${bad.join(', ')}\n`);
    process.exit(2);
  }

  console.log(
    `\n${B}Seeding to ${opts.target} listings per chain${X}  ` +
      `${D}mcap ≥ $${opts.minMcap.toLocaleString('en-US')} · liq ≥ $${opts.minLiq.toLocaleString('en-US')}${X}`,
  );
  console.log(
    apply
      ? `${Y}APPLY — real listings will be created on the site. Nothing is posted to any channel.${X}\n`
      : `${D}DRY RUN — nothing is written. Add --apply to create the listings.${X}\n`,
  );

  let unreadable = 0;
  let created = 0;
  for (const chain of chains) {
    const r = await seeder.seedChain(chain, opts);
    // ⚠️ "the market could not be read" and "there was nothing to add" are
    // different facts, and reporting the first as the second is how a rate
    // limit reads as "this chain is full".
    if (!r.ok) {
      unreadable++;
      console.log(`${R}✗${X} ${B}${chain}${X} — ${r.why}`);
      continue;
    }
    const head = `${chain}  ${r.current} → ${r.current + r.listed.length}/${r.target}`;
    if (!apply) {
      console.log(`${G}•${X} ${B}${head}${X}  ${D}(would list ${r.planned})${X}`);
    } else {
      created += r.listed.length;
      console.log(`${G}✓${X} ${B}${head}${X}  ${D}(+${r.listed.length}${r.failed ? `, ${r.failed} refused` : ''})${X}`);
    }
    if (r.why) console.log(`  ${D}${r.why}${X}`);
    for (const t of (apply ? r.listed : []).slice(0, 60)) {
      console.log(`  ${D}·${X} $${t.sym}  ${D}$${Math.round(t.mcap || 0).toLocaleString('en-US')}${X}`);
    }
  }

  if (apply) console.log(`\n${G}${created}${X} listing(s) created. ${D}Nothing was announced.${X}\n`);
  else console.log(`\n${D}Re-run with --apply to create them.${X}\n`);

  // Non-zero when a chain could not be READ — a cron or an operator scrolling
  // back must not take a silent pass for a full chain.
  process.exit(unreadable ? 1 : 0);
})().catch((e) => {
  console.error(`\n${R}✗${X} ${e.stack || e.message}\n`);
  process.exit(1);
});
