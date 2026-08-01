'use strict';
/*
 * The denial-of-service that any Telegram user could trigger with one message.
 *
 * core.buy()/sellWithRetry() promises were created, then awaited several lines
 * later. Everything in between yields, so a promise that rejected on its first
 * microtask was ORPHANED — and Node's default is --unhandled-rejections=throw,
 * which terminates the process. A custodial trading bot going dark for every
 * user, from one message, with no stack trace pointing at the cause.
 *
 * Reachable via an amount like 0.0000001: String(1e-7) is "1e-7", and
 * ethers.parseEther refuses exponential notation.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const src = fs.readFileSync(require.resolve('./telegram.js'), 'utf8');

test('a trade promise is handled from the moment it is created', () => {
  // The handler must be attached in the SAME expression, not after the awaits.
  assert.match(
    src,
    /const buying = core\.buy\([^)]*\)\.then\(\(v\) => \(\{ v \}\), \(e\) => \(\{ e \}\)\)/,
    'core.buy() must settle into a marker at creation, never be left bare',
  );
  assert.match(
    src,
    /\.then\(\(v\) => \(\{ v \}\), \(e\) => \(\{ e \}\)\);\s*\n\s*progress = expert/,
    'sellWithRetry() must be handled at creation too',
  );
  // …and the failure must still surface to the existing try/catch.
  assert.match(src, /if \(bres\.e\) throw bres\.e;/, 'a buy failure must still be reported');
  assert.match(src, /if \(sres\.e\) throw sres\.e;/, 'a sell failure must still be reported');
});

test('the amount parser never hands ethers exponential notation', () => {
  // This is the input that reached parseEther and rejected. Anything under 1e-6
  // formats as "1e-7"/"5e-7" via String(), which ethers refuses outright.
  // parseAmt is already exposed through the module's _test bag.
  const parse = require('./telegram.js')._test.parseAmt;
  for (const input of ['0.0000001', '0.0000005', '0.000000123']) {
    const r = parse(input, 'ETH');
    assert.ok(r, `${input} must not be silently dropped`);
    if (r.amt) {
      assert.ok(!/e[+-]/i.test(r.amt), `${input} produced exponential "${r.amt}" — parseEther will throw`);
      assert.doesNotThrow(() => require('ethers').ethers.parseEther(r.amt), `parseEther rejected "${r.amt}"`);
    }
  }
  // Normal amounts must be untouched.
  assert.strictEqual(parse('0.05', 'ETH').amt, '0.05');
  assert.strictEqual(parse('1', 'ETH').amt, '1');
  assert.strictEqual(parse('2.5', 'ETH').amt, '2.5');
  // Dust is refused in the UI, with a reason, rather than reaching the money path.
  const dust = parse('0.0000000001', 'ETH');
  assert.ok(dust && dust.err, 'sub-dust must be refused with a message, not passed on');
  // Junk is still rejected.
  assert.strictEqual(parse('abc', 'ETH'), null);
  assert.strictEqual(parse('-1', 'ETH'), null);
  assert.strictEqual(parse('0', 'ETH'), null);
});

test('the process survives an unhandled rejection instead of dropping every user', () => {
  const entry = fs.readFileSync(require.resolve('./index.js'), 'utf8');
  assert.match(entry, /process\.on\('unhandledRejection'/, 'the entrypoint must install the guard');
  assert.match(entry, /process\.on\('uncaughtException'/);
  // The guard must not swallow silently — an invisible failure is how this class
  // of bug survives.
  assert.match(entry, /console\.error\('\[tradebot\] unhandledRejection:'/);
});
