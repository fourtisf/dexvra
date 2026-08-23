#!/usr/bin/env node
'use strict';
/*
 * listings:fix — DOUBLE ROWS and MISSING LOGOS on the public board.
 *
 * "hapus token double dan setiap token harus punya logo … cari dri banyak
 * sumber dan jika tidak ada logo hapus aja tokenya." The board was showing
 * $FLOKI twice, both drawing the site's `FL` monogram — which is the right
 * fallback and the wrong thing to have to draw on a row nobody will ever come
 * and fix.
 *
 * Two passes, in this order, because deduping first means the logo pass does
 * not spend four network reads on a row that is about to be removed anyway:
 *
 *   1. DUPLICATES — same chain, same ticker, keep ONE.
 *   2. LOGOS      — resolve from four sources; delete what has none.
 *
 * ⚠️ THIS DELETES PUBLIC ROWS, so it inherits every guard `unseed:chain` has:
 * DRY RUN by default, and only `source: "bot"` + FREE tier + no trending slot
 * can be touched — enforced by the SITE, not by this script. A paid listing
 * with no logo is a customer to email, never a row to delete.
 */
// ⚠️ .env FIRST, before anything requires config/constants.
require("../src/config/loadEnv").loadEnv();

const api = require('../src/api/dexvra');
const { resolveLogo } = require('../src/services/tokenLogo');
const { notAProject } = require('../src/services/bigCoins');
const build = require('../src/helpers/build');

const G = '\x1b[32m', R = '\x1b[31m', Y = '\x1b[33m', D = '\x1b[2m', B = '\x1b[1m', X = '\x1b[0m';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Only rows an auto-listing run could have created. The site re-checks. */
const removable = (r) =>
  r.source === 'bot' &&
  String(r.tier || '').toUpperCase() === 'FREE' &&
  r.trendingRank == null &&
  !r.trendExp;

const hasLogo = (r) => /^https:\/\/\S+$/.test(String(r.logoUrl || ''));
const key = (r) => `${r.chain}:${String(r.sym || '').trim().toUpperCase()}`;

/**
 * Which of a duplicate set to KEEP. PURE, so the choice that removes public
 * rows is testable without a network.
 *
 * A logo beats no logo, then the bigger market cap, then the older listing —
 * the last one only so the answer is stable across runs rather than depending
 * on the order the API happened to return.
 */
function pickKeeper(rows) {
  return [...rows].sort((a, b) => {
    if (hasLogo(a) !== hasLogo(b)) return hasLogo(a) ? -1 : 1;
    const m = (Number(b.mcap) || 0) - (Number(a.mcap) || 0);
    if (m) return m;
    return (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0);
  })[0];
}

/**
 * The duplicate rows to drop, keyed on chain + TICKER.
 *
 * ⚠️ Two different real tokens CAN share a ticker — that is ordinary in crypto,
 * and on a paid board it would be wrong to touch either. It is safe here only
 * because the set is narrowed to rows this bot auto-listed for free on the SAME
 * chain: that is not two projects, it is one seeding run finding the same token
 * through two pools or two addresses.
 */
function duplicates(rows) {
  const groups = new Map();
  for (const r of rows.filter(removable)) {
    if (!r.sym) continue;
    const k = key(r);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const drop = [];
  for (const [, set] of groups) {
    if (set.length < 2) continue;
    const keep = pickKeeper(set);
    for (const r of set) if (r.id !== keep.id) drop.push({ row: r, keptSym: keep.sym, keptId: keep.id });
  }
  return drop;
}

(async () => {
  const flags = process.argv.slice(2).filter((a) => a.startsWith('--'));
  const only = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const apply = flags.includes('--apply');
  const doDupes = !flags.includes('--logos-only');
  const doLogos = !flags.includes('--dupes-only');

  if (flags.includes('--help')) {
    console.log(`
${B}listings:fix${X} — remove double rows, and give every row a logo

  npm run listings:fix                     # dry run, every chain
  npm run listings:fix -- --apply
  npm run listings:fix -- bsc solana --apply
  npm run listings:fix -- --dupes-only --apply
  npm run listings:fix -- --logos-only --apply

Logos are resolved from DexScreener, GeckoTerminal, the token's launchpad and
DexScreener's image CDN — every candidate is FETCHED before it is stored, so a
404 never becomes a broken image. A row with no logo from any source is
removed. Only rows the bot auto-listed for free are ever touched.
`);
    process.exit(0);
  }

  let rows;
  try {
    rows = (await api.getListings()) || [];
  } catch (e) {
    console.error(`\n${R}✗${X} could not read the listings API: ${e.message}\n`);
    process.exit(1);
  }
  if (only.length) rows = rows.filter((r) => only.includes(r.chain));

  console.log(`\n${B}Cleaning ${rows.length} listing(s)${only.length ? ` on ${only.join(', ')}` : ''}${X}   ${D}build ${build.stamp()}${X}`);
  console.log(apply ? `${Y}APPLY — rows will be changed and removed.${X}\n` : `${D}DRY RUN — nothing is written. Add --apply.${X}\n`);

  let removedDupes = 0;
  let fixed = 0;
  let removedNoLogo = 0;
  let refused = 0;
  const bySource = {};
  const dropped = new Set();

  // ── 1. duplicates ─────────────────────────────────────────────────────────
  if (doDupes) {
    const dupes = duplicates(rows);
    console.log(`${B}Duplicates${X}  ${dupes.length} row(s) to drop`);
    for (const { row } of dupes) {
      console.log(`  ${D}− $${row.sym} on ${row.chain} ${row.address.slice(0, 10)}…${X}`);
      if (!apply) continue;
      try {
        await api.deleteListing(row.id);
        dropped.add(row.id);
        removedDupes++;
      } catch (e) {
        refused++;
        console.log(`  ${Y}⚠ $${row.sym}: ${e.message}${X}`);
      }
      await sleep(120);
    }
    console.log('');
  }

  // ── 2. logos ──────────────────────────────────────────────────────────────
  if (doLogos) {
    const missing = rows.filter((r) => !dropped.has(r.id) && removable(r) && !hasLogo(r));
    console.log(`${B}Logos${X}  ${missing.length} row(s) with no logo`);
    for (const r of missing) {
      // A stablecoin that slipped in earlier should go, not be given artwork.
      if (notAProject(r.sym, r.name)) {
        console.log(`  ${D}− $${r.sym} (${r.chain}) — not a project${X}`);
        if (apply) {
          try {
            await api.deleteListing(r.id);
            removedNoLogo++;
          } catch (e) {
            refused++;
            console.log(`  ${Y}⚠ ${e.message}${X}`);
          }
        }
        continue;
      }
      const hit = await resolveLogo(r.chain, r.address);
      if (hit) {
        bySource[hit.source] = (bySource[hit.source] || 0) + 1;
        console.log(`  ${G}+${X} $${r.sym} (${r.chain}) ${D}← ${hit.source}${X}`);
        if (apply) {
          try {
            await api.updateListing(r.id, { logoUrl: hit.url });
            fixed++;
          } catch (e) {
            refused++;
            console.log(`  ${Y}⚠ $${r.sym}: ${e.message}${X}`);
          }
        }
      } else {
        console.log(`  ${D}− $${r.sym} (${r.chain}) — no logo anywhere${X}`);
        if (apply) {
          try {
            await api.deleteListing(r.id);
            removedNoLogo++;
          } catch (e) {
            refused++;
            console.log(`  ${Y}⚠ $${r.sym}: ${e.message}${X}`);
          }
        }
      }
      await sleep(120);
    }
  }

  if (apply) {
    console.log(
      `\n${G}${fixed}${X} logo(s) added${Object.keys(bySource).length ? ` ${D}(${Object.entries(bySource).map(([s, n]) => `${n} ${s}`).join(', ')})${X}` : ''}` +
        ` · ${G}${removedDupes}${X} duplicate(s) and ${G}${removedNoLogo}${X} logo-less row(s) removed` +
        `${refused ? ` · ${Y}${refused}${X} refused` : ''}. ${D}Nothing was announced.${X}\n`,
    );
  } else {
    console.log(`\n${D}Re-run with --apply to make these changes.${X}\n`);
  }
  process.exit(refused ? 1 : 0);
})().catch((e) => {
  console.error(`\n${R}✗${X} ${e.stack || e.message}\n`);
  process.exit(1);
});
