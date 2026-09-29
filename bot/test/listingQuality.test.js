'use strict';
/*
 * "masa anda free listingkan token seperti ini … ini skem token"
 *
 * The channel announced Shiba Inu ($SHIB) ON SOLANA to 12,430 subscribers,
 * drawn with the Dexvra diamond because the token had no artwork. Its own
 * DexScreener page said everything: MKT CAP $5.9M, LIQUIDITY $5.6M, 0% over
 * 5m/1h/6h/24h, 7 traders, 25 holders. Every free-listing gate asked how BIG it
 * was; none asked whether it was REAL. Each of the four facts below is enough
 * to refuse it on its own, and each is pinned on its own — a scam that fixes
 * three of them must still trip the fourth.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lq-'));
const q = require('../src/services/listingQuality');
const al = require('../src/services/autoLister');
const api = require('../src/api/dexvra');

const SOL_FAKE = '9bMvs6e2PRpmBUsNd9SHGNBMR1jxQ6PN1UbSZgjvEyrt'; // from the channel screenshot
const SHIB_ETH = '0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE';
const BONK_SOL = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';

// A real project: its own ticker, a logo, a pool that is a fraction of its cap,
// and a price that moved.
const good = (over = {}) => ({
  symbol: 'GOODX',
  name: 'Good Project',
  priceUsd: 0.01,
  mcap: 3_000_000,
  liq: 300_000,
  vol24: 250_000,
  logoUrl: 'https://dd.dexscreener.com/ds-data/tokens/solana/x.png',
  priceChange: { m5: 0.4, h1: -2.1, h6: 8.3, h24: 14.2 },
  ...over,
});

// The reported token, as DexScreener described it.
const reported = () => ({
  symbol: 'SHIB',
  name: 'Shiba Inu',
  priceUsd: 0.00000595,
  mcap: 5_950_915,
  liq: 5_600_000,
  vol24: 297_000,
  logoUrl: null,
  priceChange: { m5: 0, h1: 0, h6: 0, h24: 0 },
});

test('the reported $SHIB on Solana is refused', () => {
  const why = q.qualityRefusal('solana', SOL_FAKE, reported());
  assert.match(why, /^impersonates a major coin/);
  assert.match(why, /Shiba Inu/);
});

test('a real project passes', () => {
  assert.equal(q.qualityRefusal('solana', 'GoodMint1111111111111111111111111111111111', good()), null);
});

// ── 1. impersonation ───────────────────────────────────────────────────────

test('the genuine major on its home contract is not an impersonator — the board filler lists these', () => {
  assert.equal(q.impersonates('ethereum', SHIB_ETH, 'SHIB', 'Shiba Inu'), null);
  assert.equal(q.impersonates('solana', BONK_SOL, 'BONK', 'Bonk'), null);
  assert.equal(q.qualityRefusal('ethereum', SHIB_ETH, good({ symbol: 'SHIB', name: 'Shiba Inu' })), null);
});

test('EVM addresses fold case; base58 does NOT (a lowercased mint is a different account)', () => {
  assert.equal(q.impersonates('ethereum', SHIB_ETH.toLowerCase(), 'SHIB', 'Shiba Inu'), null);
  assert.ok(q.impersonates('solana', BONK_SOL.toLowerCase(), 'BONK', 'Bonk'));
});

test('the same ticker on the wrong CHAIN is a copy, even at the home address shape', () => {
  // SHIB's Ethereum address pasted onto BSC is not Shiba Inu on BSC.
  assert.ok(q.impersonates('bsc', SHIB_ETH, 'SHIB', 'Shiba Inu'));
  assert.ok(q.impersonates('base', '0x' + '1'.repeat(40), 'PEPE', 'Pepe'));
  assert.ok(q.impersonates('ethereum', '0x' + '2'.repeat(40), 'NEAR', 'NEAR Protocol'), 'a major with no home here at all');
});

test('a borrowed NAME under a different ticker is caught too, a $ prefix is not a disguise', () => {
  assert.ok(q.impersonates('solana', SOL_FAKE, 'SHIBSOL', 'Shiba Inu'));
  assert.ok(q.impersonates('solana', SOL_FAKE, '$shib', 'whatever'));
});

test('names are matched EXACTLY, never as a prefix — "Baby Shiba Inu" is its own memecoin', () => {
  assert.equal(q.impersonates('solana', SOL_FAKE, 'BABYSHIB', 'Baby Shiba Inu'), null);
  assert.equal(q.impersonates('solana', SOL_FAKE, 'SHIBAI', 'Shiba AI'), null);
});

// ── 2. no artwork ──────────────────────────────────────────────────────────

test('a token with no logo is refused — the banner would draw the Dexvra mark in its place', () => {
  assert.equal(q.qualityRefusal('solana', 'm', good({ logoUrl: null })), 'no logo');
  assert.equal(q.qualityRefusal('solana', 'm', good({ logoUrl: '' })), 'no logo');
  assert.equal(q.qualityRefusal('solana', 'm', good({ logoUrl: 'ipfs://bafy' })), 'no logo', 'a url nothing here can draw');
});

// ── 3. liquidity ≈ market cap ──────────────────────────────────────────────

test('liquidity near the whole market cap is refused; a normal ratio is not', () => {
  assert.match(q.qualityRefusal('solana', 'm', good({ liq: 2_850_000 })), /^liquidity ≈ market cap \(95%/);
  assert.equal(q.qualityRefusal('solana', 'm', good({ liq: 600_000 })), null, '20% is an ordinary pool');
  assert.equal(q.qualityRefusal('solana', 'm', good({ liq: 1_800_000 })), null, 'exactly the ceiling passes');
});

test('an unpublished liquidity or cap makes no claim', () => {
  assert.equal(q.qualityRefusal('solana', 'm', good({ liq: 0 })), null);
  assert.equal(q.qualityRefusal('solana', 'm', good({ mcap: null })), null);
});

// ── 4. a price that did not move ───────────────────────────────────────────

test('0.00% over 1h, 6h and 24h while it trades is refused', () => {
  const why = q.qualityRefusal('solana', 'm', good({ priceChange: { m5: 0, h1: 0, h6: 0, h24: 0 } }));
  assert.match(why, /^flat price/);
});

test('an ABSENT window is not a flat one, and a quiet day with no volume says nothing', () => {
  assert.equal(q.isFlat(good({ priceChange: { h1: null, h6: 0, h24: 0 } })), false);
  assert.equal(q.isFlat(good({ priceChange: undefined })), false, 'a source that publishes no change (GT, a pad)');
  assert.equal(q.isFlat(good({ vol24: 0, priceChange: { h1: 0, h6: 0, h24: 0 } })), false);
  assert.equal(q.isFlat(good({ priceChange: { h1: 0, h6: 0, h24: 0.01 } })), false);
});

// ── the doors ──────────────────────────────────────────────────────────────

async function withCreate(fn) {
  const real = { c: api.createListing, g: api.getListings };
  const seen = [];
  api.createListing = async (input) => (seen.push(input), { id: 'x' + seen.length, ...input });
  api.getListings = async () => [];
  try {
    return await fn(seen);
  } finally {
    api.createListing = real.c;
    api.getListings = real.g;
  }
}

test('createFromInfo — the ONE door — refuses the reported token BEFORE the site is asked', async () => {
  await withCreate(async (seen) => {
    assert.equal(await al.createFromInfo('solana', SOL_FAKE, reported()), null);
    // …and each fact alone, on an otherwise good record.
    assert.equal(await al.createFromInfo('solana', 'M1', good({ logoUrl: null })), null);
    assert.equal(await al.createFromInfo('solana', 'M2', good({ liq: 2_900_000 })), null);
    assert.equal(await al.createFromInfo('solana', 'M3', good({ priceChange: { h1: 0, h6: 0, h24: 0 } })), null);
    assert.deepEqual(seen, [], 'the site was asked to create one of them');
    assert.equal(al.wasEverListed('solana', SOL_FAKE), false);
    // The positive: a real project still lists through the same door.
    assert.ok(await al.createFromInfo('solana', 'GoodMint', good()));
    assert.equal(seen.length, 1);
  });
});

test('a SCAN counts the refusal under its own reason and lists nothing', async () => {
  const now = Date.UTC(2026, 8, 29, 6);
  await al.resetState(now - 10 * 3_600_000);
  await al.set({ enabled: true, minMcap: 1_000_000, maxMcap: 1_500_000, paceListings: false, postChannel: false, minAgeHours: 0 });
  await withCreate(async (seen) => {
    const deps = {
      fetchDiscoveryX: async () => ({ items: [{ chain: 'solana', address: SOL_FAKE }], ok: true, sources: [] }),
      fetchTokenInfo: async () => reported(),
    };
    assert.equal(await al.runOnce({ now, deps }), 0);
    assert.equal(seen.length, 0);
    const s = al.lastScan();
    const reasons = JSON.stringify(s.reasons || s);
    assert.match(reasons, /impersonates a major coin/, `the scan must name why: ${reasons}`);
    assert.doesNotMatch(reasons, /SHIB Shiba/, 'the per-token detail is stripped so every impersonator is one bucket');
  });
});

test('rejectReason asks the size gates FIRST — a small scam still reports "below its trigger"', () => {
  // listingWatch reads the dominant reason to tell a quiet market from a blind
  // scan; a microcap scam reported as "impersonates" would skew that.
  const cfg = { maxMcapHard: 1e9, minLiq: 0, minVol24: 0, minAgeHours: 0 };
  const why = al.rejectReason({ ...reported(), mcap: 30_000 }, cfg, 1_000_000, Date.now(), 'solana', SOL_FAKE);
  assert.match(why, /^below its trigger/);
});
