// shared/buildStamp.js — the build stamp as a FILE, keyed by the pid that wrote
// it, because a `[boot] build` line in a log the snipe loop fills several lines
// a second is gone within hours: `npm run deploy` ended red on a healthy box
// with "dexvra-tradebot no build stamp — did it start?".
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const stamp = require('../shared/buildStamp');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bstamp-'));

test('outside pm2 it writes NOTHING — a test or a one-off script must not leave stamps', () => {
  const dir = tmp();
  const saved = process.env.pm_id;
  delete process.env.pm_id;
  try {
    assert.strictEqual(stamp.writeStamp('abc1234', { dir }), null);
    assert.deepStrictEqual(fs.readdirSync(dir), []);
  } finally {
    if (saved !== undefined) process.env.pm_id = saved;
  }
});

test('it writes {sha, pid, at} under the pid, and the deploy reads exactly that', () => {
  const dir = tmp();
  const f = stamp.writeStamp('da073b4+dirty', { dir, force: true, pid: 4242, now: 1700, name: 'dexvra-tradebot' });
  assert.strictEqual(path.basename(f), '4242.json');
  assert.deepStrictEqual(stamp.readStamp(4242, dir), { sha: 'da073b4+dirty', pid: 4242, name: 'dexvra-tradebot', at: 1700 });
  // The shape deploy.sh greps for — one line of JSON with `"sha":"…"` and `"at":<ms>`.
  const raw = fs.readFileSync(f, 'utf8');
  assert.match(raw, /"sha":"da073b4\+dirty"/);
  assert.match(raw, /"at":1700/);
  assert.ok(!fs.existsSync(`${f}.tmp`), 'written then renamed — never half a file');
});

test("a dead process's stamp is pruned, a live one's is kept", () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, '111.json'), '{}');
  fs.writeFileSync(path.join(dir, '222.json'), '{}');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'kept');
  stamp.writeStamp('abc1234', { dir, force: true, pid: 333, isAlive: (pid) => pid === 222 });
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['222.json', '333.json', 'notes.txt']);
});

test('a stamp file that cannot be written never costs the boot', () => {
  const file = path.join(tmp(), 'not-a-dir');
  fs.writeFileSync(file, 'x');
  const warn = console.warn;
  let said = '';
  console.warn = (m) => (said = String(m));
  try {
    assert.strictEqual(stamp.writeStamp('abc1234', { dir: path.join(file, 'sub'), force: true }), null);
    assert.match(said, /fall back to the log line/);
  } finally {
    console.warn = warn;
  }
});

test('both packages publish through it — the boot line alone scrolls away', () => {
  for (const [f, call] of [
    ['bot/main.js', /\[boot\] build \$\{require\("\.\/src\/helpers\/build"\)\.publish\(\)\}/],
    ['bot/adminbot.js', /\[boot\] build \$\{require\("\.\/src\/helpers\/build"\)\.publish\(\)\}/],
    ['tradebot/telegram.js', /\[boot\] build \$\{require\('\.\/build'\)\.publish\(\)\}/],
  ]) {
    assert.match(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), call, `${f} prints the stamp without writing it`);
  }
  for (const f of ['bot/src/helpers/build.js', 'tradebot/build.js']) {
    assert.match(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), /shared\/buildStamp'\)\.writeStamp\(s\)/, f);
  }
  assert.match(fs.readFileSync(path.join(__dirname, '..', '.gitignore'), 'utf8'), /^\.run\/$/m, '.run/ must be ignored — the deploy refuses a dirty tree');
});
