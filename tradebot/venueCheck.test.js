'use strict';
/*
 * ⚠️ `venue:check` CARRIES A PORT OF core.js's DexScreener slug map, AND A PORT
 * IS A SECOND OWNER.
 *
 * The real map is a private const in core.js and requiring core from a script
 * boots the whole trade bot. So it is copied — and a copy that drifts makes this
 * check report "DexScreener has no pair for this token" about a token the bot
 * prices perfectly well. That is a diagnostic lying in the REASSURING direction,
 * which is the failure this repo keeps paying for: `fonts:check` printing nine
 * green ticks over a banner drawing boxes, and `market:check`'s ported chain map
 * shipping thirteen chains short.
 *
 * It is read out of core.js's SOURCE rather than by requiring it, for the same
 * reason the port exists at all.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, 'core.js'), 'utf8');

test('the ported DexScreener slug map equals core.js\'s own', () => {
  const m = SRC.match(/const DS_CHAIN_KEY = (\{[^}]*\});/);
  assert.ok(m, 'core.js no longer declares DS_CHAIN_KEY the way this guard reads it');
  // eslint-disable-next-line no-eval
  const real = eval('(' + m[1] + ')');
  const { DS_SLUG } = require('./scripts/venue-check.js');
  assert.deepEqual(DS_SLUG, real, 'venue:check would look up the wrong DexScreener chain');
});

test('requiring the script does not run it', () => {
  // It exits(2) with usage when given no token. If that ran on require, the
  // test process would die here rather than reaching this line.
  const mod = require('./scripts/venue-check.js');
  assert.ok(mod && mod.DS_SLUG, 'the map must be exported without the CLI firing');
});
