// Auto-Trending config rails + top-up logic. Isolated data dir before requires.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-at-"));

const test = require("node:test");
const assert = require("node:assert");
const api = require("../src/api/dexvra");
const autoTrend = require("../src/services/autoTrend");
const log = require("../src/helpers/logger");

test("autotrend: defaults + rails (max 18h, valid ranges, capped per-chain target)", async () => {
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
  c = await autoTrend.set({ perChain: 9999 });
  assert.strictEqual(c.perChain, autoTrend.HARD.perChainMax, "per-chain target capped");
  // An unknown network would be topped up forever with nothing eligible.
  c = await autoTrend.set({ chains: ["solana", "not-a-chain", "BSC"] });
  assert.deepStrictEqual(c.chains, ["solana", "bsc"], "unknown ids dropped, case normalised");
  // An empty list is a mistake, not an instruction — "auto-trend nothing" is
  // what the enabled switch is for. It falls back to the shipped set.
  c = await autoTrend.set({ chains: [] });
  assert.deepStrictEqual(c.chains, autoTrend.DEFAULTS.chains);
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

test("every chain is topped up against its OWN count, not one shared pool", async () => {
  // THE bug, in one fixture. The board groups by network, and a single global
  // target let the network with the most listings win every shuffle: the live
  // board showed 5 Solana tokens, one BSC, one Ethereum, one Base — and no
  // Robinhood at all. Five listings per chain must produce five per chain.
  await autoTrend.set({ enabled: true, perChain: 5, minHours: 3, maxHours: 18 });
  const now = Date.now();
  const rows = [];
  for (const chain of ["solana", "bsc", "ethereum", "base", "robinhood"]) {
    // Solana is the crowded one — 12 candidates against everyone else's 5. Under
    // the old code that head start was the whole board.
    const n = chain === "solana" ? 12 : 5;
    for (let i = 0; i < n; i++) rows.push({ status: "approved", chain, address: `${chain}${i}`, sym: `${chain}${i}`, trendingRank: null });
  }
  api.getListings = async () => rows;
  const calls = [];
  api.bookTrending = async (chain, address, hours) => (calls.push({ chain, address, hours }), {});
  const promoted = await autoTrend.runOnce({ rng: () => 0.5 });

  const byChain = {};
  for (const c of calls) byChain[c.chain] = (byChain[c.chain] || 0) + 1;
  assert.deepStrictEqual(byChain, { solana: 5, bsc: 5, ethereum: 5, base: 5, robinhood: 5 }, JSON.stringify(byChain));
  assert.strictEqual(promoted, 25);
  for (const c of calls) assert.ok(c.hours >= 3 && c.hours <= 18, `duration ${c.hours} within 3–18h`);
  void now;
});

test("a chain already at its count is left alone; a short one is topped up", async () => {
  await autoTrend.set({ enabled: true, perChain: 2 });
  const now = Date.now();
  api.getListings = async () => [
    // solana: two already featured → nothing needed
    { status: "approved", chain: "solana", address: "s1", trendingRank: 1, trendExp: now + 3600e3 },
    { status: "approved", chain: "solana", address: "s2", trendingRank: 2, trendExp: now + 3600e3 },
    { status: "approved", chain: "solana", address: "s3", trendingRank: null },
    // bsc: one featured, one free → needs exactly one
    { status: "approved", chain: "bsc", address: "b1", trendingRank: 3, trendExp: now + 3600e3 },
    { status: "approved", chain: "bsc", address: "b2", trendingRank: null },
    // an EXPIRED slot is not featured — it is the whole reason this loop exists
    { status: "approved", chain: "base", address: "x1", trendingRank: 9, trendExp: now - 1000 },
    { status: "approved", chain: "base", address: "x2", trendingRank: null },
    // never eligible
    { status: "pending", chain: "solana", address: "np", trendingRank: null },
  ];
  const calls = [];
  api.bookTrending = async (chain, address) => (calls.push({ chain, address }), {});
  await autoTrend.runOnce({ rng: () => 0.5 });
  const got = calls.map((c) => c.address).sort();
  assert.deepStrictEqual(got, ["b2", "x1", "x2"], `promoted ${got.join(",")}`);
  assert.ok(!got.includes("s3"), "solana was already at 2 — do not overfill it");
  assert.ok(!got.includes("np"), "never promotes a non-approved listing");
});

test("only the configured chains are filled", async () => {
  // Tron has no listings and nobody sells trending there; topping it up every
  // cycle would just log a failure forever.
  await autoTrend.set({ enabled: true, perChain: 3, chains: ["solana", "robinhood"] });
  api.getListings = async () => [
    { status: "approved", chain: "solana", address: "s1", trendingRank: null },
    { status: "approved", chain: "robinhood", address: "r1", trendingRank: null },
    { status: "approved", chain: "tron", address: "t1", trendingRank: null },
    { status: "approved", chain: "ethereum", address: "e1", trendingRank: null },
  ];
  const calls = [];
  api.bookTrending = async (chain, address) => (calls.push(address), {});
  await autoTrend.runOnce({ rng: () => 0.5 });
  assert.deepStrictEqual(calls.sort(), ["r1", "s1"]);
  await autoTrend.set({ chains: autoTrend.DEFAULTS.chains });
});

test("a chain that CANNOT be filled says so — silence looks identical to 'not yet'", async () => {
  // Robinhood with two listings can never reach five, and no number of cycles
  // will change that. Without this line the operator waits for a loop that has
  // already done everything it can.
  await autoTrend.set({ enabled: true, perChain: 5 });
  api.getListings = async () => [{ status: "approved", chain: "robinhood", address: "r1", trendingRank: null }];
  api.bookTrending = async () => ({});
  const warns = [];
  const realWarn = log.warn;
  log.warn = (...a) => warns.push(a.join(" "));
  autoTrend._test.resetShortWarn();
  try {
    await autoTrend.runOnce({ rng: () => 0.5 });
  } finally {
    log.warn = realWarn;
  }
  const line = warns.join("\n");
  assert.match(line, /board below target/, line);
  assert.match(line, /robinhood \(needs 5, only 1 eligible\)/, line);
  assert.match(line, /solana \(needs 5, none eligible\)/, line);
  assert.match(line, /list more tokens on those chains, or lower the per-chain target/, "it must say what to DO");
});

test("the shortfall warning does not repeat every cycle", async () => {
  // It is a standing condition on a loop that runs every few minutes. Saying it
  // each time is how a real warning becomes wallpaper.
  await autoTrend.set({ enabled: true, perChain: 5 });
  api.getListings = async () => [{ status: "approved", chain: "bsc", address: "b1", trendingRank: null }];
  api.bookTrending = async () => ({});
  const warns = [];
  const realWarn = log.warn;
  log.warn = (...a) => warns.push(a.join(" "));
  autoTrend._test.resetShortWarn();
  try {
    for (let i = 0; i < 5; i++) await autoTrend.runOnce({ rng: () => 0.5 });
  } finally {
    log.warn = realWarn;
  }
  assert.strictEqual(warns.filter((w) => w.includes("board below target")).length, 1, warns.join("\n"));
});

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
  assert.ok(wild.announcePerDay <= 200, `daily cap railed: ${wild.announcePerDay}`);
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

test("the auto post uses the SAME template as a paid trending purchase", () => {
  // Operator's call (2026-07-25): "templatenya harus sama dengan trending yang
  // sudah di set, nothing beda". So there is no separate auto template — an
  // edit to Post: Trending in the admin bot must change BOTH.
  const src = fss.readFileSync(require.resolve("../src/services/autoTrend.js"), "utf8");
  assert.match(src, /fmt\.trendingPost\(coin\)/, "renders the paid trending card");
  assert.ok(!/trendingAutoPost|post_trending_auto/.test(src), "no separate auto card");
  const tpl = require("../src/templates");
  assert.ok(!tpl.keys().includes("post_trending_auto"), "the separate template is gone from the editor too");
  // …and the artwork badge states the slot's real length, like a paid run.
  assert.match(src, /Trending \$\{hours\}H/, "same badge shape as fulfillment.js");
});

test("the announce path never posts to the announcement channel", () => {
  // A @dexvraio headline is a 24H/48H PAID inclusion. Auto runs cap at 18h, so
  // today this holds by accident — pin it on purpose.
  const src = fss.readFileSync(require.resolve("../src/services/autoTrend.js"), "utf8");
  assert.ok(!/CHANNELS\.announce/.test(src), "autoTrend must never reference the announcement channel");
  assert.ok(/CHANNELS\.trending/.test(src), "…only the trending channel");
  assert.ok(!/pin:\s*true/.test(src), "and never pin — that pin belongs to the board");
});
