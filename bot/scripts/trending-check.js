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
  let blankRows = 0;
  if (process.argv.includes('--rows')) {
    // ⚠️ THIS DRIVES THE REAL RENDERER. It used to ask `fetchMarket` itself,
    // which is a SECOND copy of the board's question — and a check that
    // measures a stack the renderer does not use is how `fonts:check` printed
    // nine green ticks over a banner publishing boxes. `buildText()` is the one
    // function the pinned board goes through; whatever it drew, this reports.
    const poster = require('../src/services/trendingPoster');
    console.log(`\n  ${D}What the board itself just rendered (buildText, the same call the poster makes)${X}`);
    const text = await poster.buildText();
    const rec = poster.lastRender();
    // A surface that renders NOTHING is an error, never a quiet ✓ — an empty
    // measurement measured nothing, and reporting that as a pass is the whole
    // defect in miniature.
    if (!text || !rec || !rec.rows) {
      console.log(`  ${R}✗${X} the board rendered no rows at all — nothing is featured, or buildText failed`);
      blankRows = -1;
    } else {
      blankRows = rec.blank.length;
      for (const b of rec.blank) {
        console.log(`  ${Y}·${X} ${String('$' + b.sym).padEnd(13)} ${D}${b.chain}${X}  ${b.why || 'no reason recorded'}`);
      }
      if (!blankRows) console.log(`  ${G}✓${X} all ${rec.rows} row(s) on the board carry a 24h percentage`);
      else
        console.log(
          `  ${D}${blankRows}/${rec.rows} row(s) publish "—" instead of a percentage. That mark is deliberate:\n` +
            `  an unreadable change is not a 0%, and printing one on a public board would be a\n` +
            `  claim nobody measured. Auto-promotion and the market filler both refuse a token\n` +
            `  with no reading, so a row here is a slot somebody PAID for — or a reading that\n` +
            `  went away after the slot was booked, which resolves when it expires.${X}`,
        );
    }
  } else {
    console.log(`  ${D}A row showing "—" instead of a %? npm run trending:check -- --rows says which and why.${X}`);
  }

  if (!short.length && blankRows <= 0) {
    console.log(`\n${G}Every chain is at or above its minimum.${X}\n`);
    return;
  }
  // A board full of dashes is a FAILING board, so green has to mean "the board
  // is safe" rather than "the counts add up" — `fonts:check` had to learn the
  // same thing after printing nine green ticks over a broken banner. Only ever
  // when --rows was asked: without it nothing here measured the percentages,
  // and a check must not fail on a question it did not put.
  if (blankRows !== 0) {
    console.log(
      blankRows < 0
        ? `\n${R}The board rendered nothing.${X}`
        : `\n${R}${blankRows} row(s) on the board carry no percentage.${X}`,
    );
    console.log(`  ${D}The bot pages the ops channel when that lasts ${Math.round(watch.GRACE_MS / 60000)} min.${X}`);
  }
  if (!short.length) {
    console.log('');
    process.exit(1);
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
