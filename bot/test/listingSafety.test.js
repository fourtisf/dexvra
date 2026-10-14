'use strict';
/*
 * "tambahkan filter scam honeypot dll intinya yang token2 potensi scam
 * honeypot tidak patut di free listing"
 *
 * A honeypot trades normally until somebody tries to sell, so nothing the
 * MARKET record shows can catch it — only a contract check can. The trade bot
 * has asked GoPlus (EVM) and RugCheck (Solana) before every buy since it was
 * written; those modules moved to shared/security/ and the free listing asks
 * the same source, with a stricter bar (a free listing is Dexvra vouching for
 * the token). These tests drive the policy, the parse, and every door.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ls-'));
const safety = require('../src/services/listingSafety');
const goplus = require('../../shared/security/goplus');
const rugcheck = require('../../shared/security/rugcheck');
const al = require('../src/services/autoLister');
const api = require('../src/api/dexvra');

/** Run `fn` with FREE_LISTING_SAFETY set to `v` (undefined = unset). */
async function withEnv(v, fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, 'FREE_LISTING_SAFETY');
  const prev = process.env.FREE_LISTING_SAFETY;
  if (v === undefined) delete process.env.FREE_LISTING_SAFETY;
  else process.env.FREE_LISTING_SAFETY = v;
  try {
    return await fn();
  } finally {
    if (had) process.env.FREE_LISTING_SAFETY = prev;
    else delete process.env.FREE_LISTING_SAFETY;
  }
}

const EVM = '0x' + 'ab'.repeat(20);
const MINT = 'So1Mint11111111111111111111111111111111111';

// A clean GoPlus / RugCheck record — every test flips ONE thing on it.
const cleanEvm = (over = {}) => ({
  honeypot: false, cannotSellAll: false, transferPausable: false, ownerChangeBalance: false,
  hiddenOwner: false, canTakeBackOwnership: false, selfDestruct: false, blacklisted: false,
  mintable: false, openSource: true, proxy: false, tradingCooldown: false,
  buyTaxPct: 0, sellTaxPct: 0, holders: 4200, ...over,
});
const cleanSol = (over = {}) => ({
  rugged: false, freezeAuthorityEnabled: false, mintAuthorityEnabled: false,
  topHolderPct: 6, top10Pct: 28, totalHolders: 3100, lpLockedPct: 100, risks: [], ...over,
});
const src = (sec, extra = {}) => ({
  goplus: { tokenSecurityX: async () => ({ sec, ok: !!sec, why: sec ? null : 'GoPlus HTTP 503', ...extra }) },
  rugcheck: { tokenSecurityX: async () => ({ sec, ok: !!sec, why: sec ? null : 'RugCheck HTTP 503', ...extra }) },
});

// ── the switch ──────────────────────────────────────────────────────────────

test('the PRODUCTION default is ON — unset and blank both mean on; only an explicit off turns it off', async () => {
  // The suite runs with it off (no remote here). This is what keeps that from
  // hiding a production default that quietly became off.
  await withEnv(undefined, () => assert.equal(safety.enabled(), true));
  await withEnv('', () => assert.equal(safety.enabled(), true));
  await withEnv('0', () => assert.equal(safety.enabled(), false));
  await withEnv('off', () => assert.equal(safety.enabled(), false));
});

// ── the policy ──────────────────────────────────────────────────────────────

test('EVM: a honeypot is refused, and the reason says so', async () => {
  await withEnv('1', async () => {
    const r = await safety.checkX('bsc', EVM, { sources: src(cleanEvm({ honeypot: true })) });
    assert.equal(r.ok, true);
    assert.match(r.refusal, /^potential scam \(.*honeypot/);
  });
});

test('EVM: what the trade bot only WARNS about is a refusal for a free listing', async () => {
  await withEnv('1', async () => {
    for (const [over, re] of [
      [{ mintable: true }, /mintable/],
      [{ openSource: false }, /not verified/],
      [{ proxy: true }, /proxy/],
      [{ tradingCooldown: true }, /cooldown/],
      [{ sellTaxPct: 8 }, /tax 8%/],
      [{ holders: 25 }, /only 25 holders/],
    ]) {
      const r = await safety.checkX('ethereum', EVM, { sources: src(cleanEvm(over)) });
      assert.match(r.refusal || '', re, JSON.stringify(over));
    }
  });
});

test('EVM: a clean contract passes — and a null holder count makes no claim', async () => {
  await withEnv('1', async () => {
    assert.equal((await safety.checkX('base', EVM, { sources: src(cleanEvm()) })).refusal, null);
    assert.equal((await safety.checkX('base', EVM, { sources: src(cleanEvm({ holders: null })) })).refusal, null);
    assert.equal((await safety.checkX('base', EVM, { sources: src(cleanEvm({ sellTaxPct: 5 })) })).refusal, null, '5% is the ceiling');
  });
});

test('Solana: freeze authority, mint authority, a rugged flag, a top-10 wall and 25 holders are each refused', async () => {
  await withEnv('1', async () => {
    for (const [over, re] of [
      [{ freezeAuthorityEnabled: true }, /freeze/],
      [{ mintAuthorityEnabled: true }, /mint authority/],
      [{ rugged: true }, /rugged/],
      [{ top10Pct: 85 }, /top 10 hold 85%/],
      [{ totalHolders: 25 }, /only 25 holders/],
      [{ risks: [{ name: 'Copycat token', level: 'danger' }] }, /Copycat/],
    ]) {
      const r = await safety.checkX('solana', MINT, { sources: src(cleanSol(over)) });
      assert.match(r.refusal || '', re, JSON.stringify(over));
    }
    assert.equal((await safety.checkX('solana', MINT, { sources: src(cleanSol()) })).refusal, null);
  });
});

test('⚠️ "could not ask" is ok:false — never read as safe, never as a scam', async () => {
  await withEnv('1', async () => {
    const r = await safety.checkX('bsc', EVM, { sources: src(null) });
    assert.equal(r.ok, false);
    assert.equal(r.refusal, null);
    assert.match(r.why, /GoPlus HTTP 503/);
    const thrown = await safety.checkX('bsc', EVM, {
      sources: { goplus: { tokenSecurityX: async () => { throw new Error('boom'); } } },
    });
    assert.equal(thrown.ok, false);
  });
});

test('a chain no safety source covers PASSES — refusing would end free listing there', async () => {
  await withEnv('1', async () => {
    const r = await safety.checkX('robinhood', EVM, {
      sources: { goplus: { tokenSecurityX: async () => ({ sec: null, ok: true, unsupported: true, why: 'GoPlus does not cover robinhood' }) } },
    });
    assert.deepEqual([r.ok, r.refusal], [true, null]);
  });
});

// ── the shared parse ────────────────────────────────────────────────────────

function stubFetch(t, handler) {
  const real = global.fetch;
  global.fetch = handler;
  t.after(() => (global.fetch = real));
}
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

test('goplus.tokenSecurityX tells a refusal, a missing record and a record apart', async (t) => {
  const a = (n) => '0x' + String(n).repeat(40).slice(0, 40);
  stubFetch(t, async (url) => {
    if (url.includes(a(1))) return json({}, 403);
    if (url.includes(a(2))) return json({ code: 4029, message: 'too many requests', result: {} });
    if (url.includes(a(3))) return json({ code: 1, result: {} });
    return json({ code: 1, result: { [a(4)]: { is_honeypot: '1', buy_tax: '0', sell_tax: '0.99', holder_count: '12' } } });
  });
  const r1 = await goplus.tokenSecurityX('bsc', a(1));
  assert.deepEqual([r1.ok, r1.sec], [false, null]);
  assert.match(r1.why, /403/);
  const r2 = await goplus.tokenSecurityX('bsc', a(2));
  assert.equal(r2.ok, false);
  assert.match(r2.why, /4029/);
  const r3 = await goplus.tokenSecurityX('bsc', a(3));
  assert.equal(r3.ok, false);
  assert.match(r3.why, /no record/);
  const r4 = await goplus.tokenSecurityX('bsc', a(4));
  assert.equal(r4.ok, true);
  assert.equal(r4.sec.honeypot, true);
  assert.equal(r4.sec.sellTaxPct, 99);
  // The trade bot's own API is unchanged: the record, or null.
  assert.equal((await goplus.tokenSecurity('bsc', a(4))).honeypot, true);
  assert.equal(await goplus.tokenSecurity('bsc', a(1)), null);
  assert.equal((await goplus.tokenSecurityX('robinhood', a(4))).unsupported, true);
});

test('rugcheck.tokenSecurityX reports a refusal with its reason', async (t) => {
  stubFetch(t, async () => json({}, 429));
  const r = await rugcheck.tokenSecurityX('solana', 'Rug1Mint1111111111111111111111111111111111');
  assert.equal(r.ok, false);
  assert.match(r.why, /RugCheck HTTP 429/);
  assert.equal((await rugcheck.tokenSecurityX('bsc', EVM)).unsupported, true);
});

test('the trade bot and the listing bot read ONE module — the tradebot files are shims', () => {
  assert.equal(require('../../tradebot/goplus'), goplus);
  assert.equal(require('../../tradebot/rugcheck'), rugcheck);
});

// ── the doors ───────────────────────────────────────────────────────────────

const now = Date.UTC(2026, 8, 29, 8);
const M = 1_000_000;
const healthy = (over = {}) => ({
  name: 'Nine Hood', symbol: 'NINEHOOD', mcap: 1.5 * M, liq: 150_000, vol24: 300_000, priceUsd: 0.0015,
  logoUrl: 'https://dd.dexscreener.com/x.png', pairCreatedAt: now - 72 * 3_600_000, ...over,
});

async function withSite(fn) {
  const real = { c: api.createListing, g: api.getListings, w: api.canCreate };
  const created = [];
  api.createListing = async (input) => (created.push(input), { id: 'x' + created.length, ...input });
  api.getListings = async () => [];
  api.canCreate = async () => ({ ok: true, status: 400, why: null });
  try {
    return await fn(created);
  } finally {
    api.createListing = real.c;
    api.getListings = real.g;
    api.canCreate = real.w;
  }
}

async function scan(addr, safetyX) {
  await al.resetState(now - 10 * 3_600_000);
  await al.set({ enabled: true, minMcap: 1 * M, maxMcap: 1.2 * M, paceListings: false, postChannel: false, minAgeHours: 0 });
  const calls = [];
  const deps = {
    fetchDiscoveryX: async () => ({ items: [{ chain: 'bsc', address: addr }], ok: true, sources: [] }),
    fetchTokenInfo: async () => healthy(),
    safetyX: async (c, a) => (calls.push([c, a]), safetyX(c, a)),
  };
  return { deps, calls };
}

test('a SCAN refuses a potential scam, counts it, cools it, and never asks the site', async () => {
  await withSite(async (created) => {
    const addr = '0x' + '31'.repeat(20);
    const { deps } = await scan(addr, async () => ({ ok: true, refusal: 'potential scam (honeypot (can’t sell))' }));
    assert.equal(await al.runOnce({ now, deps }), 0);
    assert.equal(created.length, 0);
    const s = al.lastScan();
    assert.equal(s.reasons['potential scam'], 1, JSON.stringify(s.reasons));
    assert.equal(s.blocker, null, 'a refused scam is the gate working, not a blocked scan');
    assert.match(al.scanLine(s), /potential scam ×1/);
    // Cooled: a contract does not stop being a honeypot in an hour, and asking
    // again every scan would spend the source on a known answer.
    const calls = [];
    const deps2 = { ...deps, safetyX: async (c, a) => (calls.push(a), { ok: true, refusal: null }) };
    assert.equal(await al.runOnce({ now: now + 3_600_000, deps: deps2 }), 0);
    assert.equal(calls.length, 0, 'the refused token was asked again inside its cool-off');
  });
});

test('⚠️ a scan whose safety source is down lists NOTHING, says so, pages, and cools nothing', async () => {
  await withSite(async (created) => {
    const addr = '0x' + '32'.repeat(20);
    const { deps } = await scan(addr, async () => ({ ok: false, refusal: null, why: 'safety check: GoPlus HTTP 503' }));
    assert.equal(await al.runOnce({ now, deps }), 0);
    assert.equal(created.length, 0, 'an unchecked token was listed');
    const s = al.lastScan();
    assert.equal(s.unchecked, 1);
    assert.equal(s.unpriced, 0, 'it is not a pricing failure');
    assert.match(s.blocker || '', /could not be safety-checked/);
    // No cool-off: once the source answers, the very next scan lists it.
    const later = now + 30 * 60_000;
    const deps2 = { ...deps, safetyX: async () => ({ ok: true, refusal: null }) };
    assert.equal(await al.runOnce({ now: later, deps: deps2 }), 1, 'the outage benched a good token');
  });
});

test('a clean token lists — and the scan hands its verdict to createFromInfo instead of asking twice', async () => {
  await withSite(async (created) => {
    const addr = '0x' + '33'.repeat(20);
    const { deps, calls } = await scan(addr, async () => ({ ok: true, refusal: null }));
    const real = safety.checkX;
    let doorAsked = 0;
    safety.checkX = async () => (doorAsked++, { ok: true, refusal: null });
    try {
      assert.equal(await al.runOnce({ now, deps }), 1);
    } finally {
      safety.checkX = real;
    }
    assert.equal(created.length, 1);
    assert.equal(calls.length, 1, 'the scan asked once');
    assert.equal(doorAsked, 0, 'createFromInfo asked again');
  });
});

test('createFromInfo — the door the board filler and the seeder use — refuses a scam AND an unchecked token itself', async () => {
  await withSite(async (created) => {
    const real = safety.checkX;
    try {
      safety.checkX = async () => ({ ok: true, refusal: 'potential scam (mintable supply)' });
      assert.equal(await al.createFromInfo('bsc', '0x' + '34'.repeat(20), healthy()), null);
      safety.checkX = async () => ({ ok: false, refusal: null, why: 'safety check: GoPlus HTTP 503' });
      assert.equal(await al.createFromInfo('bsc', '0x' + '35'.repeat(20), healthy()), null);
      assert.equal(created.length, 0);
      safety.checkX = async () => ({ ok: true, refusal: null });
      assert.ok(await al.createFromInfo('bsc', '0x' + '36'.repeat(20), healthy()));
      assert.equal(created.length, 1);
    } finally {
      safety.checkX = real;
    }
  });
});

test('🔎 Test scan asks the same check, or it promises a listing the scan will refuse', async () => {
  await withSite(async () => {
    const addr = '0x' + '37'.repeat(20);
    const { deps } = await scan(addr, async () => ({ ok: true, refusal: 'potential scam (honeypot (can’t sell))' }));
    const r = await al.dryRun({ now, deps });
    assert.equal(r.listed, 0);
    assert.equal((r.qualified || []).length, 0);
    assert.equal(r.reasons['potential scam'], 1, JSON.stringify(r));
  });
});
