// ONE DOOR FOR A CONTRACT — the trade bot's half of bot/test/caOneDoor.test.js.
//
// "bagaimana agar masalah ini tidak terjadi lgi" (2026-10-31): the DexScreener
// fix wired core.resolvePaste into the paste, /buy and /sell, and the audit
// after it found /pnl and BOTH ways of arming a CA snipe still reading a pasted
// link as "not a valid contract address" and a pair as the token — on the one
// path that arms a future spend. Every door here is a hand-written branch of
// telegram.js, so the next one will be too.
//
// So every call that shape-tests a contract the user typed (`isCa(`,
// `isAddrFor(`) is CLASSIFIED by the branch it sits in: RESOLVED branches must
// actually go through the resolver, EXEMPT ones say why they are not a token
// door. A new branch fails until somebody decides which it is. dexPaste.test.js
// is the driven half — a scan cannot tell a wiring that fires from one that is
// merely written down.
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert');

const SRC = fs.readFileSync(path.join(__dirname, 'telegram.js'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/[^\n]*$/gm, '');

// What a branch is called: a pending step, a command, a callback, or a function.
const LABEL = /p\.action === '([a-z_]+)'|text === '(\/[a-z]+)'|text\.startsWith\('(\/[a-z]+)|^(?:async )?function ([A-Za-z_]+)\(|data\.startsWith\('([a-z_:]+)'|data === '([a-z_:]+)'/gm;
const RESOLVER = /\b(?:pasteRef|snipeTargetRef|pnlFor)\(/;

/** Branches that take a TOKEN from the user, and must resolve it. */
const RESOLVED = ['/pnl', '/buy', '/sell', 'snw_ca', 'pnl_ca', 'snipeTargetRef', 'ca_snipe'];
/** Branches that shape-test an address and are not a token door, each with the
 *  reason. A new entry is a decision; make it in the open. */
const EXEMPT = {
  '/start': 'the ca_<chain>_<ca> deep link is built by OUR bot from a listing row, never typed',
  '/send': 'moves money out of a held token; a pointer DexScreener handed us is never resolved into a spend — the card\'s 📤 Send is the way in',
  parseSnipeLine: 'the snipe grammar; both callers resolve the first word through snipeTargetRef BEFORE parsing',
  wd_addr: 'a withdrawal DESTINATION wallet — resolving it would rewrite where money goes',
  wd_sweep_addr: 'a withdrawal DESTINATION wallet — resolving it would rewrite where money goes',
  wtok_addr: 'a token-send DESTINATION wallet — resolving it would rewrite where money goes',
  snw_dev: 'a developer WALLET to follow, not a token — a pair is never a wallet',
};

function sites() {
  const labels = [];
  let m;
  LABEL.lastIndex = 0;
  while ((m = LABEL.exec(SRC))) labels.push({ at: m.index, name: m.slice(1).find(Boolean) });
  const out = [];
  const call = /\b(isCa|isAddrFor)\(/g;
  while ((m = call.exec(SRC))) {
    const lineStart = SRC.lastIndexOf('\n', m.index) + 1;
    const before = SRC.slice(lineStart, m.index);
    if (/function\s*$|const isCa = $|function isAddrFor$/.test(before)) continue;   // the definitions
    let i = -1;
    for (let k = 0; k < labels.length && labels[k].at < m.index; k++) i = k;
    const lab = i >= 0 ? labels[i] : { at: 0, name: '(top)' };
    const end = i + 1 < labels.length ? labels[i + 1].at : SRC.length;
    out.push({ fn: m[1], label: lab.name, body: SRC.slice(lab.at, end) });
  }
  return out;
}

test('every branch that reads a contract the user typed is classified', () => {
  const unknown = sites().filter((s) => !RESOLVED.includes(s.label) && !EXEMPT[s.label]);
  assert.deepStrictEqual(
    unknown.map((s) => `${s.label} (${s.fn})`),
    [],
    'a new branch shape-tests an address without being classified — a DexScreener link or pair pasted there is read as the POOL. ' +
      'Route it through pasteRef / snipeTargetRef, or add it to EXEMPT with the reason it is not a token door.',
  );
});

test('every RESOLVED branch really goes through the resolver', () => {
  for (const s of sites().filter((x) => RESOLVED.includes(x.label))) {
    assert.ok(RESOLVER.test(s.body), `${s.label} reads a contract without pasteRef / snipeTargetRef — a pair is the POOL there again`);
  }
});

test('vacuity: the scan still finds the doors it was written for', () => {
  const seen = new Set(sites().map((s) => s.label));
  for (const l of ['/pnl', '/buy', '/sell', 'snw_ca', 'pnl_ca']) assert.ok(seen.has(l), `${l} no longer shape-tests anything — the scan is blind to it`);
  // ca_snipe reaches isAddrFor through parseSnipeLine, so it is pinned directly.
  const one = SRC.slice(SRC.indexOf("if (p.action === 'ca_snipe')"), SRC.indexOf("if (p.action === 'snw_ca')"));
  assert.ok(one.length > 200, 'the ca_snipe branch is gone');
  assert.match(one, /snipeTargetRef\(chatId, words\[0\]\)/, 'the one-line snipe arms on the typed address again');
});

test('EXEMPT carries no dead entries', () => {
  const seen = new Set(sites().map((s) => s.label));
  for (const k of Object.keys(EXEMPT)) assert.ok(seen.has(k), `${k} is exempt but no longer shape-tests anything — remove the entry`);
});
