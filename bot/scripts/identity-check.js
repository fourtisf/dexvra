#!/usr/bin/env node
/*
 * npm run identity:check — is every listing published under its OWN name?
 *
 * "harusnya tokenya btc not ltc" (2026-11-05): C5xph…pump, Big Titty Coin
 * ($BTC), was listed as Little Titty Coin ($LTC) because the market data was
 * read off a stranger's pool. The readers are fixed and the doors now check the
 * token's own contract (services/tokenIdentity.js). Neither reaches a row that
 * was ALREADY written wrong, and the operator found that one by reading the
 * channel. This asks every listing's contract what it calls itself and names
 * any row whose ticker disagrees.
 *
 *   npm run identity:check                      the newest 30 listings
 *   npm run identity:check -- --all             every listing, paced
 *
 * One token: pass its chain and its address after `--` (the same pair the
 * admin console shows). It changes nothing — a ticker is not an editable field
 * on the site, so replacing a wrong row is an admin decision, and the remedy
 * is printed beside it.
 *
 * Exit: 1 when a listing's ticker is not its contract's, or when not one
 * contract could be read (that says nothing about the listings). A token whose
 * contract carries no symbol makes no claim and never turns the code.
 */
require('../src/config/loadEnv').loadEnv();

const api = require('../src/api/dexvra');
const log = require('../src/helpers/logger');
const build = require('../src/helpers/build');
const { chainOf } = require('../src/config/chains');
const { ticker } = require('../src/helpers/format');
const tokenIdentity = require('../src/services/tokenIdentity');

const tty = process.stdout.isTTY;
const G = tty ? '\x1b[32m' : '', R = tty ? '\x1b[31m' : '', Y = tty ? '\x1b[33m' : '', D = tty ? '\x1b[2m' : '', X = tty ? '\x1b[0m' : '';
const ok = (s) => console.log(`${G}✓${X} ${s}`);
const bad = (s) => console.log(`${R}✗${X} ${s}`);
const warn = (s) => console.log(`${Y}⚠${X} ${s}`);
const note = (s) => console.log(`  ${D}${s}${X}`);

const DEFAULT_N = 30;
// Blank is ABSENT, never 0; an explicit 0 is honoured.
const GAP_MS = (() => {
  const raw = String(process.env.IDENTITY_CHECK_GAP_MS == null ? '' : process.env.IDENTITY_CHECK_GAP_MS).trim();
  const n = raw === '' ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 300;
})();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const keyOf = (chain, address) => `${chain}:${String(address).toLowerCase()}`;
// The tier the AUTO-LISTER gave each row it made. Its package rotation hands
// out XPRESS and DIAMOND/GOLD/SILVER as well as FREE, so "not FREE" does not
// mean somebody paid — the listings:nostables lesson. Read, never re-derived.
function autoTiers() {
  try {
    return require('../src/services/autoLister').autoListedTiers() || {};
  } catch {
    return {};
  }
}

/** Who gave this row its tier — the difference between a tidy-up and a customer to put right. */
function provenance(row, granted = {}) {
  const tier = String(row.tier || '').toUpperCase();
  if (!tier || tier === 'FREE') return 'a free listing';
  if (granted[keyOf(row.chain, row.address)] === tier) return `tier ${tier} given by the auto-lister, not bought`;
  return `tier ${tier}, not given by the auto-lister — if somebody paid for it, list it again on the same package (an admin order costs nothing)`;
}

/** One row's verdict: 'match' | 'mismatch' | 'unread' | 'none'. Exported for the test. */
async function judge(row) {
  const r = await tokenIdentity.readX(row.chain, row.address, { budgetMs: 8000 });
  if (!r.ok) return { state: 'unread', why: r.why, contract: r };
  if (!r.symbol) return { state: 'none', why: r.why, contract: r };
  const c = tokenIdentity.conflict(row.sym || row.symbol, r.symbol);
  return c ? { state: 'mismatch', clash: c, contract: r } : { state: 'match', contract: r };
}

async function main() {
  console.log(`\nIs every listing published under its own name?   ${D}build ${build.stamp()}${X}\n`);
  const args = process.argv.slice(2);
  const all = args.includes('--all');
  const named = args.filter((a) => !a.startsWith('-'));
  let rows;
  if (named.length >= 2) {
    const [chain, address] = named;
    if (!chainOf(chain)) {
      // DIAGNOSED, never bounced to a usage screen with a bracketed blank in it.
      bad(`"${chain}" is not a chain this bot knows.`);
      note('Run it with no arguments to check the newest real listings instead.');
      process.exit(1);
    }
    const found = await api.findListing(chain, address).catch(() => null);
    rows = [found || { chain, address, sym: null, name: null }];
    if (!found) note('not a listing on the site — reading the contract anyway');
  } else if (named.length === 1) {
    bad('a token needs BOTH its chain and its address.');
    note('Run it with no arguments at all to check the newest real listings instead.');
    process.exit(1);
  } else {
    let listings;
    try {
      listings = await api.getListings();
    } catch (e) {
      bad(`could not read the listings API: ${e.message}`);
      note('That is the same credential fulfilment uses — check INTERNAL_API_TOKEN in bot/.env on the box.');
      process.exit(1);
    }
    rows = listings.filter((r) => r && r.address && r.chain && (r.status == null || r.status === 'approved'));
    if (!all) rows = rows.slice(0, DEFAULT_N);
    if (!rows.length) {
      warn('no listings on the site yet — nothing to check.');
      process.exit(0);
    }
    console.log(`${D}  ${all ? 'every' : `the ${rows.length} newest`} listing(s), each asked of its own contract${X}\n`);
  }

  if (!tokenIdentity.enabled()) warn('LISTING_IDENTITY is off in bot/.env — the doors are not checking; this run still reads every contract.');

  const granted = autoTiers();
  const tally = { match: 0, mismatch: 0, unread: 0, none: 0 };
  const why = {};
  const wrong = [];
  // The readers log their own per-token detail at INFO ("[solana-meta] …
  // metadata document could not be read: jinniu.fun ENOTFOUND"). That is about
  // a creator's website, not about the ticker — the ticker still comes off the
  // mint — and interleaved with the verdicts it reads as this check failing.
  // Held for the run, restored after; WARN and ERROR still print.
  const info = log.info;
  const debug = log.debug;
  log.info = () => {};
  log.debug = () => {};
  try {
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (i && GAP_MS) await sleep(GAP_MS);
      // A full run is minutes long and prints nothing for a row that matches,
      // which is most of them — a run in progress and a hung one looked alike.
      if (rows.length > 50 && i && i % 100 === 0) note(`… ${i}/${rows.length} checked`);
      const v = await judge(row).catch((e) => ({ state: 'unread', why: e.message }));
      tally[v.state]++;
      const head = `${ticker(row.sym || row.symbol || '?')}${row.name ? ` — ${row.name}` : ''}  ${D}${row.chain}/${row.address}${row.tier ? ` · ${row.tier}` : ''}${X}`;
      if (v.state === 'mismatch') {
        wrong.push({ row, v });
        bad(head);
        note(`the listing says $${v.clash.published}, but the token's own contract says $${v.clash.contract}${v.contract.name ? ` (${v.contract.name})` : ''}`);
        note(`${provenance(row, granted)}`);
        note('the listing was made from another token\'s market data. A ticker is not editable on the site:');
        note('delete it in the admin console (Listings → search the address → Manage → Delete), list it again,');
        note('and delete its channel post by hand.');
      } else if (v.state === 'unread') {
        warn(`${head}`);
        note(`could not read its contract: ${v.why}`);
        const k = String(v.why || '').slice(0, 80);
        why[k] = (why[k] || 0) + 1;
      } else if (rows.length === 1) {
        if (v.state === 'match') ok(`${head} — its contract says $${v.contract.symbol}`);
        else ok(`${head} — its contract carries no ticker to compare (${v.why || 'no symbol'})`);
      }
    }
  } finally {
    log.info = info;
    log.debug = debug;
  }

  console.log('');
  console.log(`${D}  ${tally.match} match · ${tally.mismatch} under another name · ${tally.none} with no on-chain ticker · ${tally.unread} could not be read${X}`);
  if (tally.mismatch) {
    bad(`${tally.mismatch} listing(s) are published under another token's name:`);
    // All of them in one place — on a long run the blocks above have scrolled
    // past between hundreds of rows.
    for (const { row, v } of wrong) {
      note(`$${v.clash.published} → really $${v.clash.contract}${v.contract.name ? ` (${v.contract.name})` : ''}   ${row.chain}/${row.address}   ${provenance(row, granted)}`);
    }
    note('Until they are deleted, no pump or rank-up alert goes out for them (it would name the wrong token).');
    process.exit(1);
  }
  if (tally.unread && !tally.match && !tally.none) {
    // "Could not ask" is never a ✓ — it says nothing about the listings.
    bad('not one contract could be read, so this run says nothing about the listings.');
    for (const [k, n] of Object.entries(why)) note(`${n}× ${k}`);
    note('On Solana that is the RPC in bot/.env (RPC_SOLANA_URLS); on EVM chains, that chain\'s RPC.');
    process.exit(1);
  }
  if (tally.unread) warn(`${tally.unread} contract(s) could not be read — those rows were NOT checked.`);
  ok('every listing that could be read is published under its own name.');
}

if (require.main === module) {
  main().catch((e) => {
    bad(`identity:check crashed: ${e.message}`);
    process.exit(1);
  });
}

module.exports = { judge, provenance };
