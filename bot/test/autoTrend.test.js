// Auto-Trending config rails + top-up logic. Isolated data dir before requires.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-at-"));

const test = require("node:test");
const assert = require("node:assert");
const api = require("../src/api/dexvra");
const autoTrend = require("../src/services/autoTrend");

test("autotrend: defaults + rails (max 18h, valid ranges, capped target)", async () => {
  const d = autoTrend.get();
  assert.strictEqual(d.enabled, false);
  assert.strictEqual(d.maxHours, 18);
  // 24h/48h are clamped down to the 18h hard cap.
  let c = await autoTrend.set({ maxHours: 48 });
  assert.strictEqual(c.maxHours, 18, "48h clamped to 18h");
  c = await autoTrend.set({ maxHours: 24 });
  assert.strictEqual(c.maxHours, 18, "24h clamped to 18h");
  // max can't drop below min; target and gap stay within rails.
  c = await autoTrend.set({ minHours: 10, maxHours: 4 });
  assert.ok(c.maxHours >= c.minHours, "max kept >= min");
  c = await autoTrend.set({ target: 9999 });
  assert.strictEqual(c.target, autoTrend.HARD.targetMax, "target capped");
  c = await autoTrend.set({ minGapMin: 200, maxGapMin: 50 });
  assert.ok(c.maxGapMin >= c.minGapMin, "gap range kept valid");
  await autoTrend.reset();
  assert.deepStrictEqual(autoTrend.get(), autoTrend.DEFAULTS);
});

test("autotrend: disabled → no promotions", async () => {
  await autoTrend.reset(); // enabled:false
  api.getListings = async () => [{ status: "approved", chain: "solana", address: "a", sym: "A", trendingRank: null }];
  let booked = 0;
  api.bookTrending = async () => (booked++, {});
  assert.strictEqual(await autoTrend.runOnce(), 0);
  assert.strictEqual(booked, 0, "nothing promoted while disabled");
});

test("autotrend: tops up to target with random durations ≤ maxHours", async () => {
  await autoTrend.set({ enabled: true, target: 3, minHours: 3, maxHours: 18 });
  const now = Date.now();
  api.getListings = async () => [
    // one already featured
    { status: "approved", chain: "solana", address: "feat", sym: "F", trendingRank: 1, trendExp: now + 3600e3 },
    // eligible (not featured)
    { status: "approved", chain: "solana", address: "e1", sym: "E1", trendingRank: null },
    { status: "approved", chain: "bsc", address: "e2", sym: "E2", trendingRank: null },
    { status: "approved", chain: "base", address: "e3", sym: "E3", trendingRank: null },
    { status: "approved", chain: "eth", address: "e4", sym: "E4", trendingRank: null },
    // not approved → never eligible
    { status: "pending", chain: "solana", address: "np", sym: "NP", trendingRank: null },
  ];
  const calls = [];
  api.bookTrending = async (chain, address, hours) => (calls.push({ chain, address, hours }), {});
  const rng = () => 0.5; // deterministic
  const promoted = await autoTrend.runOnce({ rng });
  assert.strictEqual(promoted, 2, "featured=1, target=3 → promote 2");
  assert.strictEqual(calls.length, 2);
  for (const c of calls) {
    assert.ok(c.hours >= 3 && c.hours <= 18, `duration ${c.hours} within 3–18h`);
    assert.notStrictEqual(c.address, "np", "never promotes a non-approved listing");
    assert.notStrictEqual(c.address, "feat", "never re-promotes an already-featured one");
  }
});

test("autotrend: already at target → no-op", async () => {
  await autoTrend.set({ enabled: true, target: 1 });
  const now = Date.now();
  api.getListings = async () => [
    { status: "approved", chain: "solana", address: "feat", sym: "F", trendingRank: 1, trendExp: now + 3600e3 },
    { status: "approved", chain: "solana", address: "e1", sym: "E1", trendingRank: null },
  ];
  let booked = 0;
  api.bookTrending = async () => (booked++, {});
  assert.strictEqual(await autoTrend.runOnce(), 0);
  assert.strictEqual(booked, 0);
  await autoTrend.reset();
});
