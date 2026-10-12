'use strict';
/*
 * "ok bagaimana agar masalah ini tidak terjadi lgi" — the gates answer at the
 * door; this re-checks what is ALREADY listed, so a row from before the gates,
 * or a token turned honeypot after it was listed, is found by the bot and not
 * by the operator reading the channel.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.BOT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'la-'));
const audit = require('../src/services/listingAudit');

const good = (over = {}) => ({
  symbol: 'GOODX', name: 'Good Project', mcap: 3e6, liq: 3e5, vol24: 2e5,
  logoUrl: 'https://dd.dexscreener.com/x.png', priceChange: { h1: 1, h6: -3, h24: 9 }, ...over,
});
const row = (addr, over = {}) => ({ id: 'id-' + addr, chain: 'solana', address: addr, sym: '$' + addr.toUpperCase(), name: addr, tier: 'FREE', status: 'approved', logoUrl: 'https://x/y.png', ...over });

function deps({ rows, info = {}, safety = {}, auto = [] }) {
  const alerts = [];
  return {
    alerts,
    getListings: async () => rows,
    priceX: async (c, a) => (a in info ? info[a] : { info: good(), ok: true }),
    safetyX: async (c, a) => (a in safety ? safety[a] : { ok: true, refusal: null }),
    autoKeys: () => new Set(auto),
    alert: (h) => alerts.push(h),
  };
}

test.beforeEach(async () => {
  await audit._reset();
});

test('only the BOT\'S OWN approved listings are audited — never a purchase', () => {
  const rows = [
    row('free1'),
    row('paid1', { tier: 'GOLD' }),
    row('auto1', { tier: 'XPRESS' }),
    row('pend1', { status: 'pending' }),
  ];
  const got = audit.auditable(rows, new Set(['solana:auto1'])).map((r) => r.address);
  assert.deepEqual(got, ['free1', 'auto1']);
});

test('least-recently audited first — never-audited first of all', () => {
  const rows = [row('a'), row('b'), row('c')];
  const state = { checked: { 'solana:a': { at: 5 }, 'solana:b': { at: 1 } }, flagged: {} };
  assert.deepEqual(audit.pick(rows, state, 3).map((r) => r.address), ['c', 'b', 'a']);
});

test('THE REPORTED CASE: a listed $SHIB copy is flagged and paged ONCE, naming the command that removes it', async () => {
  const d = deps({
    rows: [row('fakeshib', { sym: '$SHIB', name: 'Shiba Inu', logoUrl: '' }), row('fine')],
    info: { fakeshib: { ok: true, info: good({ symbol: 'SHIB', name: 'Shiba Inu', logoUrl: null }) } },
  });
  const out = await audit.runOnce({ now: 1000, deps: d });
  assert.equal(out.newlyBad.length, 1);
  assert.equal(d.alerts.length, 1);
  assert.match(d.alerts[0], /\$SHIB/);
  assert.match(d.alerts[0], /impersonates a major coin/);
  assert.match(d.alerts[0], /npm run listings:nostables/);
  assert.doesNotMatch(d.alerts[0], /\$\$/, 'a doubled dollar sign');
  assert.ok(audit.flagged()['solana:fakeshib']);
  // Transition only: the next sweep says nothing about the same row.
  await audit.runOnce({ now: 2000, deps: d });
  assert.equal(d.alerts.length, 1, 'paged again for a row that was already flagged');
});

test('a token that turned HONEYPOT after it was listed is caught by the contract check', async () => {
  const d = deps({
    rows: [row('turned')],
    safety: { turned: { ok: true, refusal: 'potential scam (honeypot can’t sell, tax 99%)' } },
  });
  await audit.runOnce({ now: 1000, deps: d });
  assert.equal(d.alerts.length, 1);
  assert.match(d.alerts[0], /honeypot/);
});

test('⚠️ "could not ask" is never a flag — and the row is asked again first next sweep', async () => {
  const d = deps({
    rows: [row('dark'), row('lit')],
    info: { dark: { ok: false, info: null, why: 'DexScreener HTTP 429' } },
    safety: { lit: { ok: false, refusal: null, why: 'safety check: GoPlus HTTP 503' } },
  });
  const out = await audit.runOnce({ now: 1000, deps: d });
  assert.equal(out.unasked, 2);
  assert.equal(d.alerts.length, 0, 'an outage paged as a wave of scams');
  assert.deepEqual(audit.flagged(), {});
});

test('the ROW\'s own logo counts — "no logo" about a row that renders one would be false', async () => {
  const d = deps({ rows: [row('uploaded', { logoUrl: '/api/media/abc.png' })], info: { uploaded: { ok: true, info: good({ logoUrl: null }) } } });
  await audit.runOnce({ now: 1000, deps: d });
  assert.equal(d.alerts.length, 0);
});

test('a flagged row that passes again is cleared, silently', async () => {
  const bad = deps({ rows: [row('flip')], safety: { flip: { ok: true, refusal: 'potential scam (mintable supply)' } } });
  await audit.runOnce({ now: 1000, deps: bad });
  assert.ok(audit.flagged()['solana:flip']);
  const okd = deps({ rows: [row('flip')] });
  await audit.runOnce({ now: 2000, deps: okd });
  assert.equal(audit.flagged()['solana:flip'], undefined);
  assert.equal(okd.alerts.length, 0);
});

test('a row that left the site leaves the audit', async () => {
  const d = deps({ rows: [row('gone')], safety: { gone: { ok: true, refusal: 'potential scam (x)' } } });
  await audit.runOnce({ now: 1000, deps: d });
  await audit.runOnce({ now: 2000, deps: deps({ rows: [] }) });
  assert.deepEqual(audit.flagged(), {});
});

test('it is WIRED: attach starts it, and the cleanup script reads its flags', () => {
  const strip = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  assert.match(strip('src/services/attach.js'), /add\("listingAudit",\s*\(\)\s*=>\s*require\("\.\/listingAudit"\)\.start\(\)\)/);
  assert.match(strip('scripts/listings-stables.js'), /require\("\.\.\/src\/services\/listingAudit"\)\.flagged\(\)/);
  assert.match(strip('scripts/listings-stables.js'), /auditFlags\[keyOf\(r\.chain, r\.address\)\]/);
});

// ── The logo, looked at twice ───────────────────────────────────────────────
// `$W` (Wormhole Token) went live holding `https://wormhole.com/token.png`, a
// url /api/logo refuses by its allowlist, and the site draws its monogram
// there for ever — no gate at the door reaches backwards. The sweep asks
// listingLogo.healRow of every bot-made row it picks.

test('THE REPORTED CASE: a live row whose logo the site cannot draw is healed, and the recovery is SAID once', async () => {
  const d = deps({ rows: [row('wormhole', { sym: '$W', logoUrl: 'https://wormhole.com/token.png' }), row('fine')] });
  const asked = [];
  d.healLogo = async (r) => {
    asked.push(r.address);
    return r.address === 'wormhole'
      ? { state: 'healed', url: '/api/media/' + 'c'.repeat(24) + '.png', was: r.logoUrl, source: 'row' }
      : { state: 'renders' };
  };
  const out = await audit.runOnce({ now: 1000, deps: d });
  assert.deepEqual(asked.sort(), ['fine', 'wormhole'], 'every picked row is asked');
  assert.equal(out.healed.length, 1);
  const alert = d.alerts.find((a) => /logos repaired/.test(a));
  assert.ok(alert, 'a repaired logo is a recovery, and a recovery nobody hears about reads like an outage nobody fixed');
  assert.match(alert, /\$W/);
  assert.match(alert, /wormhole\.com\/token\.png/);
  assert.doesNotMatch(alert, /\$\$/, 'a doubled dollar sign');
});

test('a heal that throws never costs the audit — the scam checks still run', async () => {
  const d = deps({ rows: [row('a')] });
  d.healLogo = async () => {
    throw new Error('boom');
  };
  const out = await audit.runOnce({ now: 1000, deps: d });
  assert.equal(out.audited, 1);
  assert.equal(out.healed.length, 0);
});

test('production wiring: the sweep\'s real collaborators include the heal, and it is listingLogo.healRow', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'listingAudit.js'), 'utf8').replace(/\/\/.*$/gm, '');
  assert.match(src, /healLogo:\s*\(row\)\s*=>\s*listingLogo\.healRow\(row\)/);
});

test('"bagaimana agar tidak terjadi lgi": a live row whose logo CANNOT be fixed is FLAGGED once — removable, and cleared when a source finally has one', async () => {
  const d = deps({ rows: [row('nologo', { sym: '$NOLOGO', logoUrl: 'https://dead.example.com/x.png' })] });
  let state = 'none';
  d.healLogo = async () => (state === 'none' ? { state: 'none', why: 'none of 6 candidate(s) served an image' } : { state: 'healed', url: '/api/media/' + 'd'.repeat(24) + '.png', was: 'https://dead.example.com/x.png', source: 'coingecko' });
  await audit.runOnce({ now: 1000, deps: d });
  const flag = audit.flagged()['solana:nologo'];
  assert.ok(flag, 'a listing nobody can draw a logo for must not be a debug line');
  assert.match(flag.why, /^no logo \(the stored url cannot be drawn/);
  const page = d.alerts.find((a) => /\$NOLOGO/.test(a));
  assert.ok(page && /listings:nostables/.test(page), 'paged once, naming the command that removes it');

  await audit.runOnce({ now: 2000, deps: d });
  assert.equal(d.alerts.filter((a) => /\$NOLOGO/.test(a) && /fail the free-listing checks/.test(a)).length, 1, 'transition only');

  state = 'healed';
  await audit.runOnce({ now: 3000, deps: d });
  assert.equal(audit.flagged()['solana:nologo'], undefined, 'healed → the flag clears by itself');
});

test('…but a heal that could not ASK is never a flag — an outage must not page as a wave of logo-less listings', async () => {
  const d = deps({ rows: [row('flaky')] });
  d.healLogo = async () => ({ state: 'undecided', why: 'coingecko: HTTP 429' });
  await audit.runOnce({ now: 1000, deps: d });
  assert.equal(audit.flagged()['solana:flaky'], undefined);
});
