'use strict';
/*
 * guardTestPaths.test.js — two ways a test stops testing this repo.
 *
 * 1. An ABSOLUTE path. A test file written elsewhere and copied in keeps the
 *    author's machine baked into it: `require('/home/user/dexvra/tradebot/...')`
 *    resolves fine there and throws "Cannot find module" on the server, where
 *    the checkout lives at /opt/dexvra. The file's whole suite then never
 *    registers, so the run reports FEWER tests and one opaque failure.
 *
 * 2. The OPERATOR'S .env. core.js fills unset keys from tradebot/.env before
 *    anything reads them, so a knob like MONITOR_REFRESH_MS makes a test assert
 *    against production tuning instead of its own fixture. Twenty tests failed
 *    that way on the live server while passing everywhere else. `npm test` sets
 *    SKIP_DOTENV=1 to stop it.
 *
 * Both were real, both blocked a deploy, and neither is visible from reading
 * the failing test.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const files = fs.readdirSync(__dirname).filter((f) => f.endsWith('.test.js'));

test('no test hardcodes an absolute path into a require', () => {
  // Comments are stripped first — this very file quotes the offending form as
  // its own example, and a guard that trips on its own documentation gets
  // deleted rather than fixed.
  const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const f of files) {
    const src = strip(fs.readFileSync(path.join(__dirname, f), 'utf8'));
    const bad = src.match(/require\(['"]\/[^'"]+['"]\)/g) || [];
    assert.deepStrictEqual(bad, [], `${f} requires an absolute path: ${bad.join(', ')}`);
  }
});

test('npm test runs with the operator\'s .env switched off', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
  assert.match(pkg.scripts.test, /SKIP_DOTENV=1/,
    'without this every test reads whatever the live server happens to be configured with');
});

test('core.js honours SKIP_DOTENV, and only that', () => {
  const src = fs.readFileSync(path.join(__dirname, 'core.js'), 'utf8');
  assert.match(src, /if \(\/\^\(1\|true\|yes\)\$\/i\.test\(String\(process\.env\.SKIP_DOTENV \|\| ''\)\)\) return;/);
  // The env must still win over the file in production — that is what makes
  // `pm2 restart --update-env` and a systemd Environment= line work at all.
  assert.match(src, /if \(key && process\.env\[key\] === undefined\) process\.env\[key\] = val;/);
});

test('a test that needs a newer Node skips, it does not fail', () => {
  // Nineteen tests died on the server with
  //   The "timers" argument must be an instance of Array. Received an instance of Object
  // because mock.timers takes an options object only from Node 20.4. A suite
  // that cannot run on the box it is meant to gate is not a gate.
  const src = fs.readFileSync(path.join(__dirname, 'liveMonitorRuntime.test.js'), 'utf8');
  assert.match(src, /MOCK_TIMERS_OK/, 'the version guard is gone');
  assert.match(src, /skip: SKIP/, '…and the tests no longer route through it');
});

// ── the probe that settles a launchpad integration ──────────────────────────
//
// 4p can only report what the CONFIGURED factory emitted, so a factory that is
// live-but-WRONG reports "0 events" — identical to a quiet pad. That ambiguity
// is what left a Pons integration reading green while a real launch went by
// unseen. 4t asks the chain the opposite question, from a token the operator
// already has in front of them.
test('preflight 4t finds the contract that announced a given token', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, 'scripts', 'robinhood-preflight.js'), 'utf8');
  assert.match(src, /4t\. Who announced/, 'the token-targeted launchpad probe is gone');
  // TOPICS **AND** DATA: a launchpad that packs the token into the data rather
  // than indexing it would be invisible to a topic-only filter, which is half
  // the ABIs in the wild.
  assert.match(src, /\(lg\.topics \|\| \[\]\)\.join\(''\) \+ \(lg\.data \|\| ''\)/, 'the scan reads topics only again');
  // It must PRINT the .env line, not leave the operator to assemble it: a
  // diagnosis with no hands attached is a bug report the code files against
  // its owner.
  assert.match(src, /PONS_FACTORY=\$\{eAddr\}/, 'the probe stops short of the fix it found');
  // …and 4p must probe EVERY configured factory, or the legacy deployment is
  // exactly the blind spot this whole round was about.
  assert.match(src, /pons\.factories && pons\.factories\.length \? pons\.factories : \[pons\.factory\]/, '4p is back to probing one factory');
});
