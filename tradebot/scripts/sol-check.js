#!/usr/bin/env node
'use strict';
/*
 * sol:check — WHICH SOLANA HOST IS THIS PROCESS ON, AND WILL IT ANSWER?
 *
 * WHY THIS EXISTS
 *
 * The wallet screen says `the Solana RPC is rate-limiting this server (429)`,
 * which is true and stops one word short of the diagnosis: it does not name the
 * HOST. With a failover list those are two completely different problems
 * wearing one sentence —
 *
 *   · a paid endpoint is configured and IS refusing us          → the provider
 *   · the paid endpoint never arrived and this is the public one → the .env
 *
 * — and three rounds went to the second while the screen was read as the first.
 * The boot line carries the host COUNT, and an operator's `pm2 logs | grep` for
 * it came back empty on a box producing it, because the snipe loop writes
 * several lines a second: the `[curve]` and `[jup]` scars, for the third time.
 * A fact that lives only in a log line is not retrievable.
 *
 * ⚠️ IT NEVER PRINTS A URL, only a HOSTNAME. A paid endpoint carries its API
 * key in the path or the query, and this output is read off a terminal that
 * gets screenshotted — three have been sent already in this investigation.
 *
 * ⚠️ AND IT DRIVES THE BOT'S OWN READER. `solBalancesX` is the exact call the
 * dashboard makes, so this measures the stack the screen uses rather than a
 * second copy of the question — `fonts:check` printed nine green ticks over a
 * banner publishing boxes by asking its own way.
 */
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

// ⚠️ ORDER IS THE RULE, NOT PRESENCE. `core.js` loads tradebot/.env into
// process.env and `solana.js` reads SOLANA_RPC at module-eval time, so
// requiring solana first would read an empty environment and report a
// correctly-set endpoint as missing — a diagnostic about nothing.
require(path.join(__dirname, '..', 'core'));
const solana = require(path.join(__dirname, '..', 'solana'));

const ENV_FILE = path.join(__dirname, '..', '.env');
const PUBLIC = 'https://api.mainnet-beta.solana.com';
let bad = 0;
const ok = (s) => console.log('  ✓ ' + s);
const no = (s) => { bad++; console.log('  ✗ ' + s); };
const warn = (s) => console.log('  ⚠ ' + s);
const note = (s) => console.log('    ' + s);

/** The one thing that may reach the screen. Never the path, never the query. */
const hostOf = (u) => { try { return new URL(u).hostname; } catch (_) { return 'an unparseable value'; } };

function build() {
  try {
    const sha = execSync('git rev-parse --short HEAD', { cwd: path.join(__dirname, '..'), stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    const dirty = execSync('git status --porcelain', { cwd: path.join(__dirname, '..'), stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    return sha + (dirty ? '+dirty' : '');
  } catch (_) { return 'unknown'; }
}

// Real, permanent mainnet accounts — the System Program and the WSOL mint. No
// placeholder is printed anywhere in this script: this repo has had a bracketed
// blank pasted into a live shell five times, and bash reads `<` as a redirect.
const PROBE = ['11111111111111111111111111111111', 'So11111111111111111111111111111111111111112'];

(async () => {
  console.log('\nSolana RPC — build ' + build() + '\n');

  // ── 1. What THIS process read ─────────────────────────────────────────────
  console.log('1 · Configuration');
  if (fs.existsSync(ENV_FILE)) ok('read ' + ENV_FILE);
  else no('no .env at ' + ENV_FILE + " — the trade bot reads its OWN .env, not the repo root's");

  const raw = String(process.env.SOLANA_RPC || '').trim();
  if (!raw) {
    warn('SOLANA_RPC is not set — this process is on the PUBLIC endpoint');
    note('It is shared with the whole internet and refuses datacenter IPs hard.');
    note('A line in ' + ENV_FILE + ' named SOLANA_RPC, holding the url your');
    note('provider gave you, is the only thing that raises that ceiling.');
  } else {
    const entries = raw.split(',').map((u) => u.trim()).filter(Boolean);
    const refused = entries.filter((u) => !solana.rpcUsable(u));
    ok(`SOLANA_RPC is set — ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}`);
    // ⚠️ A refused entry is the reason a "fix" can change nothing at all: the
    // list falls back to the public default and every read goes where it
    // always did. That is what `https://endpoint-berbayar-anda` cost.
    for (const r of refused) no(`"${hostOf(r)}" is not a reachable host — ignored (it looks like a placeholder)`);
  }

  const urls = solana.rpcUrls(null);
  const custom = solana.rpcIsCustom(null);
  note(`hosts the bot will use, in order:`);
  urls.forEach((u, i) => note(`  ${i + 1}. ${hostOf(u)}${u === PUBLIC ? '   ← public default' : ''}`));
  if (!custom) warn('every host is the public default — nothing here raises the ceiling');
  if (urls.length === 1) note('one host: there is no failover. SOLANA_RPC takes a comma-separated list.');

  // ── 2. Does each one actually answer THIS box? ────────────────────────────
  //
  // The half a config dump cannot answer, and the half this whole
  // investigation kept guessing at.
  console.log('\n2 · Does each host answer, right now?');
  solana._rpcUnpark();   // a park from a previous probe would skip the host under test
  let answered = 0;
  for (const u of urls) {
    const conn = solana.readConnections(u)[0];
    const t0 = Date.now();
    const r = await solana.solBalancesX(conn, PROBE, { conns: [conn] });
    const ms = Date.now() - t0;
    if (r.ok) { answered++; ok(`${hostOf(u)} — answered in ${ms}ms`); }
    else no(`${hostOf(u)} — ${r.why} (${ms}ms)`);
  }
  solana._rpcUnpark();   // …and one left behind would skip it for the verdict below

  // ── 3. What the wallet screen would say ───────────────────────────────────
  console.log('\n3 · What /wallet would show');
  // ⚠️ Does NOT count again. Section 2 already counted the host that refused,
  // and a check that inflates its own tally ("3 problem(s)" for one dead
  // endpoint) teaches the reader to discount the number.
  if (answered) ok('Solana balances read — the screen shows them');
  else console.log("  ✗ every host refused: /wallet would say `Couldn't reach Solana`");

  console.log('\n4 · The OTHER process');
  // Not measured here, on purpose: it is a different package with a different
  // .env, and a check reporting another process's configuration as its own is
  // the defect `trending:check` was caught by. But it is the one that spends:
  // ~142,000 requests a day PER TRACKED POOL against this bot's ~1,500 total.
  note('The buy bot in bot/ has its OWN Solana endpoint — RPC_SOLANA_URLS or');
  note('RPC_SOLANA in bot/.env — and setting one file is not setting the other.');
  note('It is also the heavy one: `cd bot && npm run rpc:check` measures it.');

  console.log('\n' + (bad
    ? '✗ ' + bad + ' problem(s) above.'
    : '✓ Solana is reachable and configured as intended.') + '\n');
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error('sol:check crashed:', (e && e.stack) || e); process.exit(1); });
