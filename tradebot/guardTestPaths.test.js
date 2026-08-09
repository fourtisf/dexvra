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
