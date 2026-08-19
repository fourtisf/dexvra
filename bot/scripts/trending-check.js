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

  // ── "ADA BEBERAPA TOKEN TIDAK ADA PERSENAN TOKENYA WHY?" ───────────────────
  //
  // Rows on the public board carry a market cap and no percentage. The board
  // itself must not explain that — it is read by 10,593 subscribers and an
  // operator diagnostic on it would be chrome — so the answer lives here, and
  // it is MEASURED with the very call the board makes, on this box, rather than
  // reasoned about from the code.
  //
  // Behind a flag because it prices every featured token at GT's politeness
  // pace: ~30 rows is most of a minute, and the count check above is what an
  // operator usually came for.
  if (process.argv.includes('--rows')) {
    const market = require('../src/marketdata');
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    console.log(`\n  ${D}24h reading per featured row (the same call the board makes)${X}`);
    const featured = rows.filter(isFeatured);
    let missing = 0;
    for (const r of featured) {
      const m = await market.fetchMarket(r.chain, r.address).catch(() => null);
      await sleep(300);
      const pct = m && Number.isFinite(m.change24h) ? m.change24h : null;
      const cap = m && Number.isFinite(m.mcap) ? m.mcap : null;
      if (pct != null) continue;
      missing++;
      // Two different facts, and the board renders them identically.
      // Not "one of these two things" — the reason is RECORDED where it is
      // known, because "the pool has not traded" and "the pool reported
      // 12,400% and we refused it" need different answers and my own first
      // version of this line offered them as a guess between the two.
      const why = !m
        ? 'no market anywhere — no GeckoTerminal pool and no DexScreener pair. Nothing can price it, so the row publishes as a bare ticker.'
        : cap == null
          ? 'indexed, but with no price or cap either — nothing to publish'
          : `has a cap, no 24h reading${m.changeWhy ? ` — ${m.changeWhy}` : ''}`;
      console.log(`  ${Y}·${X} ${String(r.sym || r.address).padEnd(12)} ${D}${r.chain}${X}  ${why}`);
    }
    if (!missing) console.log(`  ${G}✓${X} every featured row has a 24h reading`);
    else console.log(`  ${D}${missing}/${featured.length} row(s) publish without a percentage. A blank is deliberate — an\n  unreadable change is not a 0%, and printing one on a public board would be a\n  claim nobody measured.${X}`);
  } else {
    console.log(`  ${D}A row with no % on the board? npm run trending:check -- --rows says which and why.${X}`);
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
