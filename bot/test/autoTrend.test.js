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

// Forced per-chain run: the board groups by network, so a chain with nothing
// featured shows nothing at all — and waiting for the random cycle to happen to
// pick that chain is not a plan. The admin panel's "⚡ Run now" needs a run that
// targets ONE chain and ignores the global target.
test("forced run promotes on the requested chain only", async () => {
  const rows = [
    { status: "approved", chain: "solana", address: "s1", sym: "S1" },
    { status: "approved", chain: "solana", address: "s2", sym: "S2" },
    { status: "approved", chain: "bsc", address: "b1", sym: "B1" },
  ];
  const booked = [];
  const realGet = api.getListings;
  const realBook = api.bookTrending;
  api.getListings = async () => rows;
  api.bookTrending = async (chain, address, hours) => {
    booked.push({ chain, address, hours });
    return {};
  };
  try {
    await autoTrend.set({ enabled: false }); // forced runs work with the service OFF
    assert.strictEqual(await autoTrend.runOnce({ chain: "bsc" }), 1);
    assert.strictEqual(booked.length, 1);
    assert.strictEqual(booked[0].chain, "bsc", `promoted the wrong chain: ${JSON.stringify(booked)}`);
    const cfg = autoTrend.get();
    assert.ok(booked[0].hours >= cfg.minHours && booked[0].hours <= cfg.maxHours, "duration stays inside the configured band");
  } finally {
    api.getListings = realGet;
    api.bookTrending = realBook;
  }
});

test("forced run: nothing eligible on that chain → 0, not an error", async () => {
  const now = Date.now();
  const realGet = api.getListings;
  const realBook = api.bookTrending;
  let booked = 0;
  // The only Solana token is already featured.
  api.getListings = async () => [
    { status: "approved", chain: "solana", address: "s1", sym: "S1", trendingRank: 1, trendExp: now + 3_600_000 },
  ];
  api.bookTrending = async () => {
    booked++;
    return {};
  };
  try {
    assert.strictEqual(await autoTrend.runOnce({ chain: "solana" }), 0);
    assert.strictEqual(booked, 0);
  } finally {
    api.getListings = realGet;
    api.bookTrending = realBook;
  }
});

test("featuredByChain counts what the panel shows", async () => {
  const now = Date.now();
  const realGet = api.getListings;
  api.getListings = async () => [
    { status: "approved", chain: "solana", address: "s1", trendingRank: 1, trendExp: now + 3_600_000 },
    { status: "approved", chain: "solana", address: "s2" },
    { status: "approved", chain: "bsc", address: "b1" },
    { status: "pending", chain: "bsc", address: "b2" }, // not approved → invisible
  ];
  try {
    const by = await autoTrend.featuredByChain(now);
    assert.deepStrictEqual(by.solana, { featured: 1, eligible: 1 });
    assert.deepStrictEqual(by.bsc, { featured: 0, eligible: 1 });
  } finally {
    api.getListings = realGet;
  }
});

// forceChain() exists because a button has to explain a zero. "0 promoted" has
// three very different causes and the operator can only act on the right one;
// silence on a tap reads as "the button is broken", which is how this was
// reported.
test("forceChain: promotes and names what it promoted", async () => {
  const realGet = api.getListings;
  const realBook = api.bookTrending;
  api.getListings = async () => [
    { status: "approved", chain: "bsc", address: "b1", sym: "$B1" },
    { status: "approved", chain: "solana", address: "s1", sym: "$S1" },
  ];
  api.bookTrending = async () => ({});
  try {
    const r = await autoTrend.forceChain("bsc");
    assert.strictEqual(r.promoted, 1);
    assert.match(r.syms[0], /\$B1 \d+h/, `names the token and its run: ${JSON.stringify(r.syms)}`);
    assert.strictEqual(r.reason, "", "no reason needed when it worked");
  } finally {
    api.getListings = realGet;
    api.bookTrending = realBook;
  }
});

test("forceChain: each kind of zero explains itself", async () => {
  const now = Date.now();
  const realGet = api.getListings;
  const realBook = api.bookTrending;
  try {
    // 1. nothing listed on that chain
    api.getListings = async () => [{ status: "approved", chain: "bsc", address: "b1", sym: "$B1" }];
    api.bookTrending = async () => ({});
    let r = await autoTrend.forceChain("solana");
    assert.strictEqual(r.promoted, 0);
    assert.match(r.reason, /no listings on solana/i, r.reason);

    // 2. everything there is already trending
    api.getListings = async () => [
      { status: "approved", chain: "solana", address: "s1", sym: "$S1", trendingRank: 1, trendExp: now + 3_600_000 },
    ];
    r = await autoTrend.forceChain("solana");
    assert.strictEqual(r.promoted, 0);
    assert.match(r.reason, /already trending/i, r.reason);

    // 3. the site refused the booking — the reason must carry the API's words
    api.getListings = async () => [{ status: "approved", chain: "solana", address: "s2", sym: "$S2" }];
    api.bookTrending = async () => {
      throw new Error("400: token not found");
    };
    r = await autoTrend.forceChain("solana");
    assert.strictEqual(r.promoted, 0);
    assert.match(r.reason, /refused|400/i, r.reason);

    // 4. the listings API is down
    api.getListings = async () => {
      throw new Error("ECONNREFUSED");
    };
    r = await autoTrend.forceChain("solana");
    assert.strictEqual(r.promoted, 0);
    assert.match(r.reason, /unavailable/i, r.reason);
  } finally {
    api.getListings = realGet;
    api.bookTrending = realBook;
  }
});

test("forceChain works while Auto Trending is OFF — it is a deliberate act", async () => {
  const realGet = api.getListings;
  const realBook = api.bookTrending;
  api.getListings = async () => [{ status: "approved", chain: "base", address: "x1", sym: "$X1" }];
  api.bookTrending = async () => ({});
  try {
    await autoTrend.set({ enabled: false });
    const r = await autoTrend.forceChain("base");
    assert.strictEqual(r.promoted, 1);
  } finally {
    api.getListings = realGet;
    api.bookTrending = realBook;
  }
});

// ── Announcing an auto-promotion ────────────────────────────────────────────
// Posting these publicly is the operator's call, but the volume is not: a slot
// lasts 3-18h and the target is 8, so refills alone are ~18 promotions a day.
// Every rail below exists to keep that from burying the PAID posts in the same
// channel — including the deep link a buyer was just DM'd as proof of delivery.
test("announce is OFF by default and every rail is railed", async () => {
  await autoTrend.reset();
  const c = autoTrend.get();
  assert.strictEqual(c.announce, false, "publishing must be opt-in");
  const wild = await autoTrend.set({ announcePerDay: 9999, announceGapMin: 0, announceCooldownDays: -5 });
  assert.ok(wild.announcePerDay <= 24, `daily cap railed: ${wild.announcePerDay}`);
  assert.ok(wild.announceGapMin >= 5, `spacing railed: ${wild.announceGapMin}`);
  assert.ok(wild.announceCooldownDays >= 0, `cooldown railed: ${wild.announceCooldownDays}`);
  await autoTrend.reset();
});

test("announceReason names every refusal", async () => {
  const now = 1_800_000_000_000;
  const DAY = 86_400_000;
  const row = { chain: "solana", address: "s1", sym: "$S1" };
  const cfg = { announce: true, announcePerDay: 3, announceGapMin: 60, announceCooldownDays: 7 };
  const empty = { announced: {}, day: null, lastAt: 0, pending: [] };
  assert.strictEqual(autoTrend.announceReason(row, empty, cfg, now), null, "a clean state may post");
  assert.match(autoTrend.announceReason(row, empty, { ...cfg, announce: false }, now), /off/i);
  assert.match(
    autoTrend.announceReason(row, { ...empty, day: { key: new Date(now).toISOString().slice(0, 10), n: 3 } }, cfg, now),
    /daily cap/i,
  );
  assert.match(autoTrend.announceReason(row, { ...empty, lastAt: now - 60_000 }, cfg, now), /too soon/i);
  assert.match(
    autoTrend.announceReason(row, { ...empty, announced: { "solana:s1": now - 2 * DAY } }, cfg, now),
    /cooldown/i,
  );
  // …and past the cooldown the same token is allowed again.
  assert.strictEqual(
    autoTrend.announceReason(row, { ...empty, announced: { "solana:s1": now - 8 * DAY } }, cfg, now),
    null,
  );
});

test("XPRESS tokens are never auto-promoted", async () => {
  // packages.js records the operator decision: "Xpress is listing-ONLY: no
  // trending slot, no trending-channel post". The upgrade path sold to an
  // Xpress buyer is to come back and BUY trending.
  assert.ok(autoTrend.NEVER_PROMOTE_TIERS.has("XPRESS"));
  const realGet = api.getListings;
  const realBook = api.bookTrending;
  const booked = [];
  api.getListings = async () => [
    { status: "approved", chain: "solana", address: "x1", sym: "$X1", tier: "XPRESS" },
    { status: "approved", chain: "solana", address: "f1", sym: "$F1", tier: "FREE" },
  ];
  api.bookTrending = async (chain, address) => {
    booked.push(address);
    return {};
  };
  try {
    await autoTrend.set({ enabled: true, target: 8, announce: false });
    await autoTrend.runOnce();
    assert.ok(!booked.includes("x1"), `the Xpress token must be left alone: ${booked}`);
    assert.ok(booked.includes("f1"), "…while the free one is fair game");
    // The forced per-chain path shares the rule.
    booked.length = 0;
    api.getListings = async () => [{ status: "approved", chain: "bsc", address: "x2", sym: "$X2", tier: "XPRESS" }];
    const r = await autoTrend.forceChain("bsc");
    assert.strictEqual(r.promoted, 0, "forced runs must not smuggle Xpress in");
    assert.strictEqual(booked.length, 0);
  } finally {
    api.getListings = realGet;
    api.bookTrending = realBook;
    await autoTrend.reset();
  }
});

test("a forced run QUEUES its announcement — the admin process cannot post", async () => {
  // channels/post.attach() happens only in src/bot.js (the main bot), so a post
  // from the admin process would throw "not attached to a bot". forceChain
  // hands the announcement over instead.
  const realGet = api.getListings;
  const realBook = api.bookTrending;
  api.getListings = async () => [{ status: "approved", chain: "base", address: "b9", sym: "$B9" }];
  api.bookTrending = async () => ({});
  try {
    await autoTrend.resetAnnounceState();
    await autoTrend.set({ announce: true });
    const r = await autoTrend.forceChain("base");
    assert.strictEqual(r.promoted, 1);
    const state = JSON.parse(fss.readFileSync(path.join(process.env.BOT_DATA_DIR, "autoTrendState.json"), "utf8"));
    assert.strictEqual(state.pending.length, 1, "queued for the main process");
    assert.strictEqual(state.pending[0].address, "b9");
  } finally {
    api.getListings = realGet;
    api.bookTrending = realBook;
    await autoTrend.resetAnnounceState();
    await autoTrend.reset();
  }
});

test("the announce path never posts to the announcement channel", () => {
  // A @dexvraio headline is a 24H/48H PAID inclusion. Auto runs cap at 18h, so
  // today this holds by accident — pin it on purpose.
  const src = fss.readFileSync(require.resolve("../src/services/autoTrend.js"), "utf8");
  assert.ok(!/CHANNELS\.announce/.test(src), "autoTrend must never reference the announcement channel");
  assert.ok(/CHANNELS\.trending/.test(src), "…only the trending channel");
  assert.ok(!/pin:\s*true/.test(src), "and never pin — that pin belongs to the board");
});
