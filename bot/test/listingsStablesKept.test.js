'use strict';
/*
 * "liat ini" — the first live `listings:nostables --apply` removed 48 of 51 and
 * then printed three red ✗ lines for $$PEPE: a GOLD row, an XPRESS row and a
 * public submission, each refused 409 by the site. The site was RIGHT (a bulk
 * script may never take a purchase away); the script was wrong to ask, wrong to
 * call the refusal a failure, and wrong to print the ticker with two dollars.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'stables-kept-'));
const api = require('../src/api/dexvra');
const script = require('../scripts/listings-stables');

const PEPE_ETH = '0x6982508145454Ce325dDbE47a25d4ec3d2311933';
const rows = [
  { id: 'l_free', chain: 'bsc', address: '0x' + '1'.repeat(40), sym: '$PEPE', name: 'Pepe', tier: 'FREE', source: 'bot' },
  { id: 'l_gold', chain: 'bsc', address: '0x' + '2'.repeat(40), sym: '$PEPE', name: 'Pepe', tier: 'GOLD', source: 'bot' },
  { id: 'l_sub', chain: 'solana', address: 'So1' + 'a'.repeat(40), sym: '$PEPE', name: 'Pepe', tier: 'FREE', source: 'submission' },
  { id: 'l_xp', chain: 'robinhood', address: '0x' + '3'.repeat(40), sym: '$PEPE', name: 'PEPE THE CHOSEN FROG', tier: 'XPRESS', source: 'bot' },
  { id: 'l_slot', chain: 'bsc', address: '0x' + '4'.repeat(40), sym: '$PEPE', name: 'Pepe', tier: 'FREE', source: 'bot', trendingRank: 2 },
  { id: 'l_real', chain: 'ethereum', address: PEPE_ETH, sym: '$PEPE', name: 'Pepe', tier: 'FREE', source: 'bot' },
];

async function run(argv, del = async () => ({ deleted: true })) {
  const out = [];
  const real = { log: console.log, get: api.getListings, del: api.deleteListing, argv: process.argv, code: process.exitCode };
  const asked = [];
  console.log = (...a) => out.push(a.join(' '));
  api.getListings = async () => rows;
  api.deleteListing = async (id) => {
    asked.push(id);
    return del(id);
  };
  process.argv = ['node', 'listings-stables.js', ...argv];
  try {
    // --apply is read at require time, so the module is loaded fresh per run.
    delete require.cache[require.resolve('../scripts/listings-stables')];
    await require('../scripts/listings-stables').main();
    return { text: out.join('\n'), asked, code: process.exitCode };
  } finally {
    console.log = real.log;
    api.getListings = real.get;
    api.deleteListing = real.del;
    process.argv = real.argv;
    process.exitCode = real.code;
  }
}

test('keptBy mirrors the site DELETE route: source, then tier, then a trending slot', () => {
  assert.equal(script.keptBy(rows[0]), null);
  assert.match(script.keptBy(rows[1]), /paid tier GOLD/);
  assert.match(script.keptBy(rows[2]), /source "submission", not the bot/);
  assert.match(script.keptBy(rows[4]), /trending slot/);
  // The route's own three refusals, so the two cannot drift apart unnoticed.
  const route = fs.readFileSync(path.join(__dirname, '..', '..', 'src/app/api/internal/listings/[id]/route.ts'), 'utf8');
  assert.match(route, /row\.source !== "bot"/);
  assert.match(route, /toUpperCase\(\) !== "FREE"/);
  assert.match(route, /row\.trendingRank != null \|\| row\.trendExp/);
});

test('THE REPORTED RUN: protected rows are KEPT and never asked; only the free bot copy goes', async () => {
  const r = await run(['--apply']);
  assert.deepEqual(r.asked, ['l_free'], 'the script asked the site to delete a protected row');
  assert.match(r.text, /Removed 1 of 1 · 4 kept \(protected\)/);
  assert.match(r.text, /Kept — the site protects these/);
  assert.doesNotMatch(r.text, /✗/, 'a guard that held rendered as a failure');
  assert.notEqual(r.code, 1);
  // The genuine PEPE on its home chain is not a copy and is not listed at all.
  assert.doesNotMatch(r.text, /l_real/);
});

test('⚠️ the ticker carries exactly ONE dollar sign', async () => {
  const r = await run([]);
  assert.match(r.text, /\$PEPE/);
  assert.doesNotMatch(r.text, /\$\$/);
});

test('a dry run deletes nothing', async () => {
  const r = await run([]);
  assert.deepEqual(r.asked, []);
  assert.match(r.text, /Dry run — nothing was deleted/);
});

test('a REAL failure still says ✗, with one dollar sign, and turns the exit code', async () => {
  const r = await run(['--apply'], async () => {
    throw new Error('DELETE → 500');
  });
  assert.match(r.text, /✗ \$PEPE — DELETE → 500/);
  assert.doesNotMatch(r.text, /\$\$/);
  assert.equal(r.code, 1);
});
