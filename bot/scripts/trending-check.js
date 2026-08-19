#!/usr/bin/env node
'use strict';
/*
 * trending:check — is every chain at its minimum RIGHT NOW, and if not, why?
 *
 * "Trending base dan ethereum sangat sedikit" was reported three times, each
 * time with a different cause underneath, and every time the operator was the
 * one who noticed by counting rows in the channel. The running bot pages about
 * it now (trendingWatch.js); this is the same question asked on demand, because
 * "wait up to two hours for the next cycle and read pm2" is not an answer when
 * somebody is looking at a short board.
 *
 * Exits non-zero when any configured chain is under its floor, so it is usable
 * straight after a deploy or from a cron.
 */
// ⚠️ .env FIRST, before anything requires config/constants.
//
// The first live run of this script reported "INTERNAL_API_TOKEN is not set" on
// a server where it IS set: `main.js` loads the env before requiring anything
// and a standalone script gets none of that, so the check read as a broken
// server rather than a broken script.
//
// `loadEnv()` is the one owner of "which .env does this process read" — repo
// root, then bot/, then the cwd, with override. A bare
// `require("dotenv").config()` here would be a fourth private idea of it, and
// it would resolve against the CWD alone, which is the exact failure that
// module was written for.
require("../src/config/loadEnv").loadEnv();

const autoTrend = require('../src/services/autoTrend');
const watch = require('../src/services/trendingWatch');
const api = require('../src/api/dexvra');
const { chainOf } = require('../src/config/chains');
const build = require('../src/helpers/build');

const G = '\x1b[32m', R = '\x1b[31m', Y = '\x1b[33m', D = '\x1b[2m', X = '\x1b[0m';

(async () => {
  const cfg = autoTrend.get();
  console.log(`\nTrending board vs the minimum you set   ${D}build ${build.stamp()}${X}\n`);
  if (!cfg.enabled) {
    console.log(`  ${Y}⚠ Auto Trending is OFF${X} — nothing tops the board up. @dexvraadminbot → 🤖 Auto Trending → ▶️ Enable.\n`);
  }

  let rows;
  try {
    rows = (await api.getListings()) || [];
  } catch (e) {
    console.log(`${R}✗ could not read the listings API: ${e.message}${X}`);
    if (/INTERNAL_API_TOKEN/.test(e.message)) {
      // Naming the files that WERE read is the whole diagnosis: "not set" over a
      // list containing bot/.env is a missing line in that file, and "not set"
      // over an empty list is a script that read no .env at all — which is what
      // this very check shipped doing.
      const envFiles = require('../src/config/loadEnv').loadEnv();
      console.log(`  ${D}.env read: ${envFiles.length ? envFiles.join(', ') : 'NONE — no .env at the repo root, in bot/, or in this directory'}`);
      console.log(`  That value lives in .env on the server and nowhere in this repo. If the bot is`);
      console.log(`  listing and trending normally it IS set — add it to one of the files above.${X}`);
    }
    console.log('  Nothing below can be measured until that answers.\n');
    process.exit(1);
  }

  const now = Date.now();
  const isFeatured = (r) => r.status === 'approved' && r.trendingRank != null && (!r.trendExp || r.trendExp > now);
  const on = (r, id) => String(r.chain).toLowerCase() === String(id).toLowerCase();

  const target = cfg.perChainMax > cfg.perChainMin ? `${cfg.perChainMin}–${cfg.perChainMax}` : `${cfg.perChainMin}`;
  console.log(`  ${D}target ${target} per chain · gain floor +${cfg.minGainPct}% · fill from market ${cfg.fillFromMarket ? 'ON' : 'OFF'}${X}\n`);

  const short = [];
  for (const id of cfg.chains) {
    const featured = rows.filter((r) => isFeatured(r) && on(r, id)).length;
    const eligible = rows.filter((r) => r.status === 'approved' && !isFeatured(r) && on(r, id)).length;
    const label = (chainOf(id) && chainOf(id).label) || id;
    const why = watch.diagnose({ featured, floor: cfg.perChainMin, eligible, gainFloor: cfg.minGainPct });
    if (why) {
      short.push({ id, featured, why });
      console.log(`  ${R}✗${X} ${String(label).padEnd(12)} ${R}${featured}/${cfg.perChainMin}${X} ${D}· ${eligible} spare listing(s)${X}`);
      console.log(`      ${Y}${why.text}${X}`);
    } else {
      console.log(`  ${G}✓${X} ${String(label).padEnd(12)} ${featured}/${cfg.perChainMin} ${D}· ${eligible} spare listing(s)${X}`);
    }
  }

  if (!short.length) {
    console.log(`\n${G}Every chain is at or above its minimum.${X}\n`);
    return;
  }
  console.log(`\n${R}${short.length} chain(s) below the minimum of ${cfg.perChainMin}.${X}`);
  // The running bot says the same thing in the ops channel after
  // TREND_SHORT_GRACE_MS — this is only the same answer, sooner.
  console.log(`  ${D}The bot pages the ops channel when a chain stays short for ${Math.round(watch.GRACE_MS / 60000)} min.${X}`);
  console.log(`  ${D}⚡ Run now on @dexvraadminbot → 🤖 Auto Trending fills one chain immediately.${X}\n`);
  process.exit(1);
})().catch((e) => {
  console.error(`trending:check failed: ${e.stack || e.message}`);
  process.exit(1);
});
