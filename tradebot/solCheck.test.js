'use strict';
/*
 * solCheck.test.js — sol:check is DRIVEN, not read.
 *
 * `node --check` proves syntax and every defect this repo has had in a check
 * script was a runtime shape: a probe that hung, a scan that reported a busy
 * pair as dead, a verdict that named the wrong layer. So the script is RUN.
 *
 * The property that matters most cannot be asserted any other way: a paid RPC
 * endpoint carries its API key in the path or the query, and this output is
 * read off a terminal that gets screenshotted.
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, 'scripts', 'sol-check.js');
const SECRET = 'SUPERSECRETKEY123';

/**
 * ⚠️ STDOUT AND STDERR ARE KEPT APART, and the first cut of this file did not.
 *
 * `solana.rpcUrls` warns on stderr about a refused entry with wording close to
 * the check's own, so a test asserting on the concatenation passed while the
 * check printed nothing at all — it was measuring the module's warning, not the
 * report an operator reads. A mutation run said so.
 *
 * `out` is the REPORT. `both` is for the one question that spans them: a key
 * leaked to stderr is still leaked.
 */
function run(env) {
  const opts = {
    env: { ...process.env, SKIP_DOTENV: '1', ...env },
    encoding: 'utf8', timeout: 90000, stdio: ['ignore', 'pipe', 'pipe'],
  };
  try {
    const out = execFileSync(process.execPath, [SCRIPT], opts);
    return { out, both: out };
  } catch (e) {
    // Non-zero is the ORDINARY outcome here: this sandbox has no egress, so
    // every host refuses. The output is the subject, not the exit code.
    const out = String((e && e.stdout) || '');
    return { out, both: out + String((e && e.stderr) || '') };
  }
}

test('⚠️ it never prints a url — only a hostname', () => {
  const { out, both } = run({ SOLANA_RPC: `https://paid.example/rpc/?api-key=${SECRET}` });
  assert.ok(out.includes('paid.example'), 'the host has to be named, or the check answers nothing');
  // BOTH streams: a key on stderr is on the same terminal.
  assert.ok(!both.includes(SECRET), 'the API KEY reached a terminal that gets screenshotted');
  assert.ok(!both.includes('/rpc/'), 'the path carries the key on some providers');
});

test('a placeholder entry is NAMED as ignored, not silently dropped', () => {
  const { out } = run({ SOLANA_RPC: 'https://endpoint-berbayar-anda,https://api.mainnet-beta.solana.com' });
  assert.match(out, /endpoint-berbayar-anda.*not a reachable host/,
    'a "fix" that changed nothing at all is what this line exists to end');
  assert.match(out, /api\.mainnet-beta\.solana\.com/, 'and the survivor is still listed');
});

test('it says WHICH host refused, which the wallet screen cannot', () => {
  const { out } = run({ SOLANA_RPC: 'https://nope.example/rpc' });
  // The screen says "the Solana RPC is rate-limiting this server (429)" and
  // stops one word short: with a failover list, "the paid host is refusing us"
  // and "the paid host never arrived" wear the same sentence.
  assert.match(out, /nope\.example —/, 'the verdict is per host');
});

test('it reaches its verdict even when nothing answers', () => {
  const { out } = run({ SOLANA_RPC: 'https://nope.example/rpc' });
  assert.match(out, /What \/wallet would show/, 'a probe that hangs is worse than one that says it cannot answer');
  assert.match(out, /every host refused/);
});

test('⚠️ core is required BEFORE solana — order, not presence', () => {
  // core.js loads tradebot/.env into process.env and solana.js reads
  // SOLANA_RPC at module-eval time, so the other order reports a correctly-set
  // endpoint as missing — a diagnostic about nothing. The same rule
  // loadEnv.test.js had to learn after matching the call anywhere in the file.
  const src = fs.readFileSync(SCRIPT, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const c = src.indexOf("require(path.join(__dirname, '..', 'core'))");
  const s = src.indexOf("require(path.join(__dirname, '..', 'solana'))");
  assert.ok(c > -1 && s > -1, 'both requires must still be there');
  assert.ok(c < s, 'solana.js reads the env at module-eval — core must load it first');
});
