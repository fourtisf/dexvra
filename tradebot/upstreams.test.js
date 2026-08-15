'use strict';
/*
 * upstreams.test.js — the watchdog that exists so a human does not have to be
 * the monitoring.
 *
 * Three outages in two days, all the same shape:
 *   • Jupiter retired quote-api.jup.ag/v6 → every Solana buy died, five wallets
 *     at a time, under a green ✅ receipt.
 *   • pump.fun moved to frontend-api-v3 → snipe discovery went blind and
 *     /health kept printing 🟢.
 *   • /swap started failing on a base whose /quote answered fine.
 *
 * Every one was found by a person typing `npm run preflight:solana` AFTER a user
 * complained. The check existed, worked, and named each problem in one line — it
 * simply only ran when somebody already suspected something.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const upstreams = require('./upstreams');
const WSRC = fs.readFileSync(path.join(__dirname, 'watchers.js'), 'utf8');
const PSRC = fs.readFileSync(path.join(__dirname, 'scripts', 'solana-preflight.js'), 'utf8');
const RSRC = fs.readFileSync(path.join(__dirname, 'report.js'), 'utf8');

// ── What is watched ──────────────────────────────────────────────────────────

test('every upstream that has actually broken is probed', () => {
  const keys = upstreams.PROBES.map((p) => p.key);
  for (const k of ['jupiter.quote', 'jupiter.swap', 'pumpfun.feed', 'dexscreener']) {
    assert.ok(keys.includes(k), `${k} is not watched`);
  }
});

test('the swap build is its own probe, not assumed from the quote', () => {
  // These are two endpoints on one host and they have already failed
  // independently: /quote answered while /swap returned 500. Probing only the
  // cheap one would have reported healthy straight through that outage.
  const q = upstreams.PROBES.find((p) => p.key === 'jupiter.quote');
  const s = upstreams.PROBES.find((p) => p.key === 'jupiter.swap');
  assert.ok(q && s && q.run !== s.run);
  assert.ok(s.critical, 'a bot that cannot build a swap is not tradeable, so this must be critical');
});

test('critical means "users cannot trade", and is not handed out freely', () => {
  const crit = upstreams.PROBES.filter((p) => p.critical).map((p) => p.key);
  assert.deepStrictEqual(crit.sort(), ['jupiter.quote', 'jupiter.swap']);
  // A blind snipe feed and a card missing its price are real, but they are not
  // the same emergency as every buy failing. An alert where everything is
  // critical is an alert with no priority in it.
  assert.ok(!upstreams.PROBES.find((p) => p.key === 'pumpfun.feed').critical);
});

test('every probe says what the USER loses, not just which host is down', () => {
  for (const p of upstreams.PROBES) {
    assert.ok(p.costs && p.costs.length > 15, `${p.key} has no user-facing consequence`);
    assert.ok(!/http|api\.|\.ag|\.fun/i.test(p.costs), `${p.key} describes a host, not a consequence: ${p.costs}`);
  }
});

// ── A monitor must not be able to hurt what it monitors ──────────────────────

test('a probe never throws and never hangs', async () => {
  const boom = upstreams.PROBES[0].run;
  assert.strictEqual(typeof boom, 'function');
  // Drive the real guard with a fetch that never resolves: it must still settle.
  const realFetch = global.fetch;
  global.fetch = () => new Promise(() => {});
  try {
    const r = await Promise.race([
      upstreams.PROBES.find((p) => p.key === 'dexscreener').run(),
      new Promise((res) => setTimeout(() => res('HUNG'), 20000)),
    ]);
    assert.notStrictEqual(r, 'HUNG', 'a probe outlived its own timeout');
    assert.strictEqual(r.ok, false);
    assert.match(r.detail, /timed out/);
  } finally { global.fetch = realFetch; }
});

test('checkAll always resolves, and reports critical separately from total', async () => {
  const realFetch = global.fetch;
  global.fetch = async () => { throw new TypeError('fetch failed'); };
  try {
    const snap = await upstreams.checkAll();
    assert.strictEqual(snap.ok, false);
    assert.strictEqual(snap.criticalOk, false);
    assert.strictEqual(snap.results.length, upstreams.PROBES.length);
    for (const r of snap.results) assert.strictEqual(typeof r.detail, 'string');
  } finally { global.fetch = realFetch; }
});

// ── Alerting on transitions ──────────────────────────────────────────────────

test('only CHANGES are announced', () => {
  // A broken upstream posting every sweep is a channel nobody reads by the
  // second hour, and the alert that matters is buried in its repetitions.
  assert.match(WSRC, /const _upState = new Map\(\);/);
  assert.match(WSRC, /if \(was && !r\.ok\) broke\.push\(r\);/);
  assert.match(WSRC, /else if \(!was && r\.ok\) fixed\.push\(r\);/);
  assert.match(WSRC, /if \(broke\.length \|\| fixed\.length\) report\.upstreamChange/);
});

test('a recovery is an alert too', () => {
  // "It is broken" with no matching "it is back" leaves the operator unable to
  // tell a fixed outage from a forgotten one.
  assert.match(RSRC, /🟢 <b>Upstream recovered<\/b>/);
  assert.match(RSRC, /function upstreamChange\(broke, fixed\)/);
});

test('a bot that BOOTS into an outage still reports it', () => {
  // There is no transition to catch when the process restarts mid-outage — the
  // break happened while it was down. First sweep reports a problem, and stays
  // quiet about everything that is merely fine.
  assert.match(WSRC, /if \(was === undefined\) \{[\s\S]*?if \(!r\.ok\) broke\.push\(r\);[\s\S]*?continue;/);
});

test('the watchdog cannot be starved down to a useless interval', () => {
  assert.match(WSRC, /Math\.max\(60000, Number\(process\.env\.UPSTREAM_CHECK_MS \|\| 600000\)\)/);
});

// ── One list, two callers ────────────────────────────────────────────────────

test('the preflight and the running bot probe the same things', () => {
  // Two copies of "is Jupiter up" would eventually disagree — this repo has
  // already paid for that once, carrying two different pump.fun hosts in two
  // processes with neither aware of the other.
  assert.match(PSRC, /const upstreams = require\(path\.join\(__dirname, '\.\.', 'upstreams'\)\)/);
  assert.match(PSRC, /for \(const p of upstreams\.PROBES\)/);
  assert.match(WSRC, /const upstreams = require\('\.\/upstreams'\)/);
  assert.match(WSRC, /await upstreams\.checkAll\(\)/);
});

// ── /health stops being able to lie ──────────────────────────────────────────

test('the Solana snipe reports whether the FEED answered, not just that it ran', () => {
  // `lastFeedOkAt` is the only field that distinguishes the two. Without it a
  // pump.fun host dead for days still rendered a green tick — the state that
  // looks most like a healthy one.
  assert.match(WSRC, /_solSnipeStats = \{ polls: 0, launchesSeen: 0, lastLaunchAt: null, lastFeedOkAt: null/);
  assert.match(WSRC, /out\.solSnipe\.sinceFeedOkMs = _solSnipeStats\.lastFeedOkAt/);
  assert.match(WSRC, /out\.solSnipe\.launchesSeen = _solSnipeStats\.launchesSeen/);
});

test('an unreachable feed FAILS the cycle instead of returning quietly', () => {
  // The old `if (!coins.length) return` counted as a successful tick, so the
  // loop's own heartbeat certified a blind bot as healthy.
  assert.match(WSRC, /const feed = await solana\.pumpfunNewX\(50\);/);
  assert.match(WSRC, /if \(!feed\.ok\) \{[\s\S]*?throw new Error\('pump\.fun feed: '/);
});

test('/health carries the last upstream sweep', () => {
  // "The loops are running" while every Solana buy fails at Jupiter is the exact
  // gap that let this go unnoticed.
  assert.match(WSRC, /out\.upstreams = \{ ageMs: now - _lastUpstream\.at, ok: _lastUpstream\.ok, criticalOk: _lastUpstream\.criticalOk/);
  assert.match(WSRC, /failing: _lastUpstream\.results\.filter\(\(r\) => !r\.ok\)/);
});

// ── "It reported nothing" and "it never ran" are different facts ─────────────

test('the first sweep always prints, even when everything is fine', () => {
  // Silence afterwards is the design — a healthy watchdog says nothing. But
  // silence is also exactly what a watchdog that never started looks like, and
  // an operator grepping for it cannot tell them apart. The same rule as
  // lastFeedOkAt, applied to the monitor itself.
  assert.match(WSRC, /if \(!_upFirstDone\) \{/);
  assert.match(WSRC, /\[upstream\] first sweep: \$\{ok\}\/\$\{snap\.results\.length\} ok/);
  assert.match(WSRC, /let _upFirstDone = false;/);
});

test('boot says whether an alert would actually reach anyone', () => {
  // report.post() swallows its own failures so a channel hiccup can never touch
  // the trade path — which means a misconfigured channel is silent in precisely
  // the way an outage is. A watchdog whose alerts land nowhere does not exist.
  assert.match(WSRC, /report\.enabled\(\) \? 'go to the ops channel' : 'are DISABLED/);
  assert.match(RSRC, /function enabled\(\) \{ return !!\(_token\(\) && _channel\(\)\); \}/);
});
