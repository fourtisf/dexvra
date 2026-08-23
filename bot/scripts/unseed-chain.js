#!/usr/bin/env node
'use strict';
/*
 * unseed:chain — REMOVE the auto-listings a seeding run put on a chain.
 *
 * "ton ganti tron aja". `seed:chain --all` filled sixteen chains the trending
 * board is not even allowed to use, and TON took a slot on the site's chain
 * row that Tron was wanted in. Undoing that by hand is sixteen chains of
 * clicking.
 *
 * ⚠️ THIS DELETES PUBLIC ROWS, so every guard here is load-bearing:
 *
 *   · DRY RUN by default. `--apply` is the only thing that removes anything.
 *   · A CHAIN MUST BE NAMED. There is no `--all`, deliberately — the blast
 *     radius of a typo'd flag is the whole site, and this is the one script
 *     where that cannot be walked back.
 *   · Only `source: "bot"` + FREE tier + no trending slot. The SITE enforces
 *     that, not this script: a caller can be wrong about what it is holding,
 *     the store cannot, and a 409 naming the rule is better than a bulk run
 *     that had to be trusted.
 *   · A removed token NEVER comes back through the seeder — `everListed` is
 *     written at creation and is never cleared. That is the intent here (TON
 *     should stay gone) and it is the reason this is not a "refresh".
 */
// ⚠️ .env FIRST, before anything requires config/constants — a standalone
// script otherwise reads an empty environment and reports it as a fact about
// the server.
require("../src/config/loadEnv").loadEnv();

const api = require('../src/api/dexvra');
const { chainOf } = require('../src/config/chains');
const build = require('../src/helpers/build');

const G = '\x1b[32m', R = '\x1b[31m', Y = '\x1b[33m', D = '\x1b[2m', B = '\x1b[1m', X = '\x1b[0m';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Could this row have come from an auto-listing run? The site decides for
 *  real; this only filters what is worth ASKING about, so a dry run reports
 *  the same set the apply would act on. */
function removable(r) {
  if (r.source !== 'bot') return false;
  if (String(r.tier || '').toUpperCase() !== 'FREE') return false;
  if (r.trendingRank != null || r.trendExp) return false;
  return true;
}

(async () => {
  const argv = process.argv.slice(2);
  const flags = argv.filter((a) => a.startsWith('--'));
  const chains = argv.filter((a) => !a.startsWith('--')).map((c) => c.trim().toLowerCase());
  const apply = flags.includes('--apply');

  if (!chains.length || flags.includes('--help')) {
    console.log(`
${B}unseed:chain${X} — remove the auto-listings a seeding run put on a chain

  npm run unseed:chain -- ton
  npm run unseed:chain -- ton --apply

Only rows the BOT created on the FREE tier with no trending slot are removed —
a paid tier or a live slot is refused by the site itself. Nothing is announced.
A removed token never comes back through seed:chain.
`);
    process.exit(chains.length ? 0 : 1);
  }
  const bad = chains.filter((c) => !chainOf(c));
  if (bad.length) {
    console.error(`\n${R}✗${X} unknown chain: ${bad.join(', ')}\n`);
    process.exit(2);
  }

  let rows;
  try {
    rows = (await api.getListings()) || [];
  } catch (e) {
    console.error(`\n${R}✗${X} could not read the listings API: ${e.message}\n`);
    process.exit(1);
  }

  console.log(`\n${B}Removing auto-listings on ${chains.join(', ')}${X}   ${D}build ${build.stamp()}${X}`);
  console.log(
    apply
      ? `${Y}APPLY — these rows disappear from the site.${X}\n`
      : `${D}DRY RUN — nothing is removed. Add --apply.${X}\n`,
  );

  let removed = 0;
  let refused = 0;
  for (const chain of chains) {
    const mine = rows.filter((r) => r.chain === chain);
    const targets = mine.filter(removable);
    const kept = mine.length - targets.length;
    console.log(
      `${targets.length ? G + '•' : D + '·'}${X} ${B}${chain}${X}  ${mine.length} listing(s), ` +
        `${targets.length} removable${kept ? `, ${D}${kept} kept (paid, trending, or not bot-created)${X}` : ''}`,
    );
    if (!apply) continue;
    for (const r of targets) {
      try {
        await api.deleteListing(r.id);
        removed++;
        console.log(`  ${D}− $${r.sym}${X}`);
      } catch (e) {
        // A 409 is the site refusing on a rule this script could not see —
        // worth printing verbatim rather than counting silently.
        refused++;
        console.log(`  ${Y}⚠ $${r.sym}: ${e.message}${X}`);
      }
      await sleep(150); // the site is one small server
    }
  }

  if (apply) {
    console.log(`\n${G}${removed}${X} listing(s) removed${refused ? `, ${Y}${refused}${X} refused` : ''}. ${D}Nothing was announced.${X}\n`);
  } else {
    console.log(`\n${D}Re-run with --apply to remove them.${X}\n`);
  }
  process.exit(refused ? 1 : 0);
})().catch((e) => {
  console.error(`\n${R}✗${X} ${e.stack || e.message}\n`);
  process.exit(1);
});
