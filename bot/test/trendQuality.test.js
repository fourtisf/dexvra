// A FREE TRENDING SLOT IS FOR A TOKEN WITH A MARKET BEHIND IT.
//
// Reported with a screenshot of the board — "untuk free trending mohon di
// filter agar high mc dan vol yang rame yang ditrendingkan, bukan kaya vol
// bahkan ga ada $10 di trendingin":
//
//     $MRNA   +465.0%   MCAP $157.7K   VOL $0.05   10 txns
//     $GOOGL  +164.0%   MCAP  $66.4K   VOL $0.04    8 txns
//
// Five cents of trading in a day, promoted for free over real markets. Ranking
// could never have prevented it — `byGain` sorts by 24h change and a percentage
// off an empty book is the biggest one there is, which is the same shape
// `minGainPct` was written for (a token down 99.94% on a $1,648 cap) at the
// other end of the scale.
//
// Every test here fails on a plausible half-fix: a floor on one door only, a
// floor a forced run bypasses, a floor that treats "we could not read it" as
// "it is small", and a floor that leaves the chain stranded instead of handing
// it to the market filler.
//
// No network: every upstream is stubbed.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-tq-"));

const test = require("node:test");
const assert = require("node:assert");

const market = require("../src/marketdata");
const api = require("../src/api/dexvra");
const autoTrend = require("../src/services/autoTrend");
const trendFill = require("../src/services/trendFill");
const watch = require("../src/services/trendingWatch");
const log = require("../src/helpers/logger");

// The refusal COUNT is what reaches the watch, so one test reads it back off
// the log line rather than trusting that it was computed correctly.
const logged = [];
const realInfo = log.info;
log.info = (...a) => {
  logged.push(a.join(" "));
  return typeof realInfo === "function" ? undefined : undefined;
};

// The two rows off the operator's screenshot, and one real market from the same
// board (rank 4, which they opened rather than complained about).
const MRNA = { priceUsd: 1.576e-6, mcap: 157_700, vol24h: 0.05, change24h: 465 };
const GOOGL = { priceUsd: 6.6e-7, mcap: 66_400, vol24h: 0.04, change24h: 164 };
const LAOWU = { priceUsd: 0.000361, mcap: 360_800, vol24h: 636_200, change24h: 102 };

const listing = (address, chain = "solana") => ({
  status: "approved",
  chain,
  address,
  sym: address,
  trendingRank: null,
});

/** Drive one auto-trend pass over `rows`, with `reading` as the whole market. */
async function promoteWith(rows, reading, { forceChain = null } = {}) {
  const realMarket = market.fetchMarket;
  const realListings = api.getListings;
  const realBook = api.bookTrending;
  market.fetchMarket = async (_chain, address) => reading(address);
  api.getListings = async () => rows;
  const booked = [];
  api.bookTrending = async (_chain, address) => booked.push(address);
  let forced = null;
  try {
    if (forceChain) forced = await autoTrend.forceChain(forceChain, { count: 3, rng: () => 0.5 });
    else await autoTrend.runOnce({ rng: () => 0.5 });
  } finally {
    market.fetchMarket = realMarket;
    api.getListings = realListings;
    api.bookTrending = realBook;
  }
  return { booked, forced };
}

/** The shipped floors, stated rather than inherited — these tests are ABOUT
 *  them, so every number they turn on is written down here. */
async function withFloors(extra = {}) {
  await autoTrend.reset();
  return autoTrend.set({
    enabled: true,
    chains: ["solana"],
    perChainMin: 3,
    perChainMax: 3,
    minGainPct: 0,
    announce: false,
    fillFromMarket: false,
    minMcapUsd: 100_000,
    minVol24hUsd: 10_000,
    ...extra,
  });
}

// ── the predicate ────────────────────────────────────────────────────────────

test("the floors refuse the exact rows that were reported, and pass the real market", () => {
  const cfg = { minMcapUsd: 100_000, minVol24hUsd: 10_000 };
  const why = (m) => autoTrend.floorRefusal({ mcap: m.mcap, vol24: m.vol24h }, cfg);
  // MRNA clears the cap floor at $157.7K and dies on the volume — which is the
  // row the report was actually about, and the reason a cap floor ALONE would
  // not have fixed this board.
  assert.match(why(MRNA).why, /\$0\.05 24h volume/, "the reported row, named with its own number");
  assert.strictEqual(why(MRNA).code, "vol");
  // GOOGL fails both; the CAP is reported because it is checked first. One
  // reason, the first one found — a refusal listing everything wrong with a
  // token is a paragraph nobody reads.
  assert.strictEqual(why(GOOGL).code, "mcap");
  assert.match(why(GOOGL).why, /\$66\.4K cap/);
  assert.strictEqual(why(LAOWU), null, "$360.8K cap on $636.2K of volume is a real market");
});

test("a floor set to 0 is OFF and asks nothing at all", () => {
  // It has to stay expressible: an operator who wants the old unfiltered board
  // must be able to say so, and a token that publishes nothing must not be
  // refused by a filter nobody turned on.
  const off = { minMcapUsd: 0, minVol24hUsd: 0 };
  assert.strictEqual(autoTrend.floorRefusal({ mcap: null, vol24: null }, off), null);
  assert.strictEqual(autoTrend.floorRefusal({ mcap: 1, vol24: 0 }, off), null);
  // …and one at a time.
  assert.strictEqual(autoTrend.floorRefusal({ mcap: 1, vol24: 9e9 }, { minMcapUsd: 0, minVol24hUsd: 10_000 }), null);
  assert.ok(autoTrend.floorRefusal({ mcap: 1, vol24: 9e9 }, { minMcapUsd: 100_000, minVol24hUsd: 0 }));
});

test("an UNREADABLE value is refused, and a measured ZERO is refused for a different reason", () => {
  const cfg = { minMcapUsd: 100_000, minVol24hUsd: 10_000 };
  // A floor is a CLAIM ("cap ≥ $100K"). A token whose cap nobody publishes
  // cannot be shown to satisfy it — the rule the gainers banner's minMcapUsd
  // already states, in the same words.
  assert.match(autoTrend.floorRefusal({ mcap: null, vol24: 1e6 }, cfg).why, /could not be read/);
  assert.match(autoTrend.floorRefusal({ mcap: 5e6, vol24: null }, cfg).why, /could not be read/);
  // …and a REAL zero is a reading, not a gap. It is the exact case being
  // filtered, and it must not be reported as "we could not tell".
  assert.match(autoTrend.floorRefusal({ mcap: 5e6, vol24: 0 }, cfg).why, /\$0 24h volume/);
});

// ── door 1: the promoter ─────────────────────────────────────────────────────

test("a dead token is NOT promoted while the chain has real markets", async () => {
  await withFloors();
  const rows = [listing("MRNA"), listing("GOOGL"), listing("LAOWU")];
  const { booked } = await promoteWith(rows, (a) => ({ MRNA, GOOGL, LAOWU }[a]));
  assert.deepStrictEqual(booked, ["LAOWU"], `a dead row was promoted: ${booked.join(",")}`);
});

test("…and NOT promoted even when it is the only thing on the chain", async () => {
  // ⚠️ THIS IS THE ONE THAT MUST NOT BECOME AN EXEMPTION. `hasMarket` and
  // `hasReading` both fall open where nothing on a chain qualifies, because a
  // chain no indexer covers would otherwise never fill. These floors must NOT:
  // the market filler exists precisely for a chain that cannot fill from its
  // own listings, so refusing here strands nothing — it routes. An exemption
  // would put the reported board straight back on any chain of dead tokens,
  // which is exactly the chain that produces one.
  await withFloors();
  const { booked } = await promoteWith([listing("MRNA"), listing("GOOGL")], (a) => ({ MRNA, GOOGL }[a]));
  assert.deepStrictEqual(booked, [], `a chain of dead tokens still published: ${booked.join(",")}`);
});

test("the FLOOR FILL honours them too — or the rule is decorative", async () => {
  // The pass whose whole job is to overrule a floor ("the minimum outranks the
  // gain floor") is the pass that would silently delete these, on the chains
  // that are short — which is every chain an operator is looking at. The
  // free-fall bound already has this scar.
  await withFloors({ minGainPct: 500 }); // nothing clears the gain floor → every pick comes from the floor fill
  const rows = [listing("MRNA"), listing("GOOGL"), listing("LAOWU")];
  const { booked } = await promoteWith(rows, (a) => ({ MRNA, GOOGL, LAOWU }[a]));
  assert.ok(!booked.includes("MRNA"), `the floor fill booked a dead row: ${booked.join(",")}`);
  assert.ok(!booked.includes("GOOGL"), `the floor fill booked a dead row: ${booked.join(",")}`);
  assert.deepStrictEqual(booked, ["LAOWU"], "only the real market reaches the board");
});

test("⚡ Run now is bound by them too — it is the path an operator watches", async () => {
  // Every other rule on this pass is bypassed by a forced run on purpose: the
  // gain floor and the free-fall bound govern how DISCRETIONARY the bot is
  // being, and the operator has decided that. These are not that — they are the
  // standing answer to what may go on the board at all, and a button that
  // published VOL $0.05 would reproduce the report from the one path somebody
  // is looking at while they tap it.
  await withFloors();
  const { booked, forced } = await promoteWith([listing("MRNA"), listing("GOOGL")], (a) => ({ MRNA, GOOGL }[a]), {
    forceChain: "solana",
  });
  assert.deepStrictEqual(booked, [], "Run now published a dead token");
  assert.strictEqual(forced.promoted, 0);
  // A refusal with no numbers on it is a button that looks broken. It must name
  // the floors and at least one token, so the fix (lower a floor, or 🧲) is
  // reachable from what the operator just read.
  assert.match(forced.reason, /free-trending floors/i);
  assert.match(forced.reason, /\$100\.0K/, "the cap floor is named");
  assert.match(forced.reason, /\$10\.0K/, "the volume floor is named");
  assert.match(forced.reason, /MRNA/, "…and at least one refused token");
});

test("with the floors OFF, the old behaviour is exactly what still happens", async () => {
  // The escape hatch has to work, or "set it to 0" on the panel is a lie.
  await withFloors({ minMcapUsd: 0, minVol24hUsd: 0 });
  const rows = [listing("MRNA"), listing("GOOGL"), listing("LAOWU")];
  const { booked } = await promoteWith(rows, (a) => ({ MRNA, GOOGL, LAOWU }[a]));
  assert.deepStrictEqual(booked.sort(), ["GOOGL", "LAOWU", "MRNA"]);
});

test("a chain stranded by the floors ASKS THE FILLER — refusing is not a state that resolves itself", async () => {
  // The fourth cause, one field over: the promoter refuses these two on every
  // cycle for the same reason for ever, and if `gap()` is not raised nothing in
  // the loop can move the chain. The board would sit under its minimum with no
  // trace but a log line.
  await withFloors({ fillFromMarket: true, fillMaxPerCycle: 3 });
  const asked = [];
  const realMarket = market.fetchMarket;
  const realListings = api.getListings;
  market.fetchMarket = async (_c, a) => ({ MRNA, GOOGL }[a]);
  api.getListings = async () => [listing("MRNA"), listing("GOOGL")];
  try {
    await autoTrend.runOnce({
      rng: () => 0.5,
      deps: {
        fillChain: async (chain, need) => {
          asked.push([chain, need]);
          return { chain, need, listed: [], tried: 0, why: "test" };
        },
      },
    });
  } finally {
    market.fetchMarket = realMarket;
    api.getListings = realListings;
  }
  assert.deepStrictEqual(asked, [["solana", 3]], "the fill must be asked for the whole floor shortfall");
});

test("⚠️ a token nobody PRICED is not counted as one that failed the floors", async () => {
  // `byGain` prices at most 25 candidates a chain and leaves the rest
  // annotated `undefined` — "we never looked". Those rows are still filtered
  // out (promoting a token nobody priced is how a dead row reaches the board),
  // but counting them as "below the floors" would tell an operator with 100
  // listings that 75 of their tokens are too small, about tokens this pass
  // never opened. That number reaches the watch, and it is the number they
  // would act on.
  await withFloors({ perChainMin: 1, perChainMax: 1 });
  // ⚠️ CLEARED, not inherited. `logged` is module-level and every earlier test
  // in this file writes a refusal line into it — so `find` returned the FIRST
  // match, from a three-token fixture, and the assertion passed no matter what
  // this test did. Caught by mutating the source and watching the test stay
  // green: the persisted-setting leak this repo already documents, in a log
  // buffer instead of a store.
  logged.length = 0;
  const rows = [];
  // 30 dead ones so the whole probe budget is spent on them, then a real one
  // far down the tail that never gets looked at.
  for (let i = 0; i < 30; i++) rows.push(listing(`DEAD${i}`));
  rows.push(listing("UNSEEN"));
  const seen = new Set();
  const { booked } = await promoteWith(rows, (a) => {
    seen.add(a);
    return a === "UNSEEN" ? LAOWU : MRNA;
  });
  assert.deepStrictEqual(booked, [], "nothing was promotable");
  assert.ok(!seen.has("UNSEEN"), "the fixture must leave a row unprobed, or this test proves nothing");
  // The count the watch reads must be the rows actually judged, not the whole
  // spare list.
  const line = logged.find((l) => /below the free-trending floors/.test(l));
  assert.ok(line, "the refusal was never logged");
  const n = Number((line.match(/: (\d+) candidate/) || [])[1]);
  assert.ok(n > 0 && n <= 25, `counted ${n} refusals — the unprobed tail was counted too (line: ${line})`);
});

// ── door 2: the market filler ────────────────────────────────────────────────

const bigCoin = (symbol, over) => ({
  chain: "base",
  address: `0x${symbol}`,
  symbol,
  name: `${symbol} Token`,
  mcap: 2e7,
  liq: 5e5,
  vol24: 1e6,
  change24h: 5,
  ...over,
});

function fillDeps(items, over = {}) {
  return {
    topByMcap: async () => ({ ok: true, why: null, items }),
    fetchTokenInfo: async () => null,
    getListings: async () => [],
    wasEverListed: () => false,
    createFromInfo: async (chain, address, merged) => ({ input: { sym: merged.symbol, tier: "GOLD" } }),
    ...over,
  };
}

test("the filler will not LIST a dead big-cap into a board slot", async () => {
  // A filled listing books its slot AT CREATION, so a candidate that slipped
  // past the query is published with nothing left to refuse it. The floors have
  // to bind here as well as at the query, or the door meant to help the board
  // is the door that breaks it.
  const made = [];
  const r = await trendFill.fillChain("base", 2, {
    cfg: { minMcapUsd: 100_000, minVol24hUsd: 10_000 },
    deps: fillDeps([bigCoin("DEAD", { vol24: 3 }), bigCoin("REAL")], {
      createFromInfo: async (_c, _a, merged) => (made.push(merged.symbol), { input: { sym: merged.symbol, tier: "GOLD" } }),
    }),
  });
  assert.deepStrictEqual(made, ["REAL"], `the filler listed a dead token: ${made.join(",")}`);
  assert.deepStrictEqual(r.listed.map((x) => x.sym), ["REAL"]);
});

test("a chain refused for the floors SAYS so, rather than 'already listed'", async () => {
  // Each counter is a different answer: free-fall clears itself in a day, a
  // floor is a SETTING, and "already listed" needs no action at all. A counter
  // that did not join the ladder reports as the last branch, which is the
  // defect this file's neighbour already pins for the reading rule.
  const r = await trendFill.fillChain("base", 2, {
    cfg: { minMcapUsd: 100_000, minVol24hUsd: 10_000 },
    deps: fillDeps([bigCoin("D1", { vol24: 3 }), bigCoin("D2", { vol24: 0 })]),
  });
  assert.strictEqual(r.listed.length, 0);
  assert.match(r.why, /below the free-trending floors/);
  assert.ok(!/already listed/.test(r.why), `it read as "already listed": ${r.why}`);
});

test("the DOMINANT refusal is reported, not the first one written down", async () => {
  // Every branch of that ladder says "every", and with three mutually exclusive
  // counters that is only true of the one accounting for all of them. A chain
  // with one dead token and three in free-fall is a free-fall problem, and
  // sending the operator to change a floor over it is the wrong fix.
  const r = await trendFill.fillChain("base", 2, {
    cfg: { minMcapUsd: 100_000, minVol24hUsd: 10_000 },
    deps: fillDeps([
      bigCoin("DEAD", { vol24: 3 }),
      bigCoin("F1", { change24h: -40 }),
      bigCoin("F2", { change24h: -55 }),
      bigCoin("F3", { change24h: -90 }),
    ]),
    maxDropPct: 15,
  });
  assert.match(r.why, /down more than 15%/, `the minority reason won: ${r.why}`);
  assert.match(r.why, /3 of 4/, "…and it says it was not all of them");
});

test("the floors have ONE owner — the filler does not carry a second copy", async () => {
  // Two copies of a floor is two floors, and the free-fall bound has already
  // shown which way that fails: the door WITHOUT the rule wins, because its
  // picks book their slot directly. Swapping the owner out must change what the
  // filler does.
  let asked = 0;
  const r = await trendFill.fillChain("base", 2, {
    cfg: { minMcapUsd: 100_000, minVol24hUsd: 10_000 },
    deps: fillDeps([bigCoin("ANY")], { floorRefusal: () => (asked++, { code: "vol", why: "stubbed" }) }),
  });
  assert.ok(asked > 0, "fillChain judged a candidate without asking autoTrend.floorRefusal");
  assert.strictEqual(r.listed.length, 0, "…and it did not honour the answer it was given");
});

test("the volume floor reaches the QUERY, so a quiet page never becomes candidates", async () => {
  // GT is asked `h24_volume_usd_desc`, which is a RANKING and not a floor —
  // page 2 of a quiet chain is full of pools that have not traded all day.
  let opts = null;
  await trendFill.fillChain("base", 1, {
    cfg: { minMcapUsd: 100_000, minVol24hUsd: 25_000, fillMinMcap: 5e6, fillMinLiq: 1e5 },
    deps: fillDeps([], { topByMcap: async (_chain, o) => ((opts = o), { ok: true, why: null, items: [] }) }),
  });
  assert.strictEqual(opts.minVol24, 25_000, "the volume floor was not passed to topByMcap");
});

// ── the watch: which refusal it was ──────────────────────────────────────────

test("the watch names the FLOORS, not the −15% sentence, when that is the cause", async () => {
  // `spares_unusable` asserts "they are below −15%" for every way a spare can
  // be unusable. With the floors on that is now most often false, and it is the
  // sentence an operator would act on — it sends them to look at a percentage
  // when the answer is a $0.05 volume.
  const why = watch.diagnose({
    featured: 1,
    floor: 5,
    eligible: 4,
    floorRefused: 4,
    minMcapUsd: 100_000,
    minVol24hUsd: 10_000,
  });
  assert.strictEqual(why.code, "below_floors");
  assert.match(why.text, /free-trending floors/);
  assert.match(why.text, /\$100K/);
  assert.match(why.text, /\$10K/);
  assert.ok(!/below −15%/.test(why.text), "it printed the free-fall sentence over a floor refusal");
});

test("a chain short for the OLD reasons still gets the old answers", async () => {
  // The new branch must not swallow the other three. `floorRefused` is only
  // ever non-zero on a pass that actually measured it.
  assert.strictEqual(watch.diagnose({ featured: 5, floor: 5, eligible: 0 }), null, "at target → nothing to say");
  assert.strictEqual(watch.diagnose({ featured: 1, floor: 5, eligible: 3 }).code, "spares_unusable");
  assert.strictEqual(watch.diagnose({ featured: 1, floor: 5, eligible: 0 }).code, "no_listings");
  assert.strictEqual(
    watch.diagnose({ featured: 1, floor: 5, eligible: 3, fillWhy: "GT rate limited", floorRefused: 3 }).code,
    "fill_failed",
    "the filler's own reason still outranks everything — it is the most specific fact available",
  );
});

// ── config plumbing ──────────────────────────────────────────────────────────

test("both floors PERSIST — a setting set() does not write is a setting that reverts", async () => {
  // The bug class this repo names verbatim: a key can reach DEFAULTS and get()'s
  // normaliser and still never reach the file, so the panel reports the new
  // value and the loop keeps the old one.
  await autoTrend.reset();
  await autoTrend.set({ minMcapUsd: 250_000, minVol24hUsd: 40_000 });
  delete require.cache[require.resolve("../src/services/autoTrend")];
  const fresh = require("../src/services/autoTrend");
  assert.strictEqual(fresh.get().minMcapUsd, 250_000, "the cap floor did not survive a re-read");
  assert.strictEqual(fresh.get().minVol24hUsd, 40_000, "the volume floor did not survive a re-read");
  await fresh.reset();
});

test("they ship ON, and 0 is reachable rather than clamped away", async () => {
  await autoTrend.reset();
  const d = autoTrend.get();
  assert.ok(d.minMcapUsd > 0, "the cap floor must ship ON — it is what was asked for");
  assert.ok(d.minVol24hUsd > 0, "the volume floor must ship ON");
  const off = await autoTrend.set({ minMcapUsd: 0, minVol24hUsd: 0 });
  assert.strictEqual(off.minMcapUsd, 0, "0 must stay expressible — it is the escape hatch");
  assert.strictEqual(off.minVol24hUsd, 0);
  // …and a fat-finger is still clamped.
  const wild = await autoTrend.set({ minMcapUsd: -5, minVol24hUsd: 9e15 });
  assert.strictEqual(wild.minMcapUsd, 0);
  assert.strictEqual(wild.minVol24hUsd, autoTrend.HARD.minVol24hUsdMax);
  await autoTrend.reset();
});

test("fetchMarket carries a 24h volume at all — the floor has nothing to read otherwise", () => {
  // It did not, before this. Both readers had the field in scope and discarded
  // it, so a volume floor could not have been written without plumbing it.
  const src = fss.readFileSync(path.join(__dirname, "..", "src", "marketdata.js"), "utf8");
  assert.match(src, /vol24h: vnum\(p\.volume\?\.h24\)/, "the DexScreener reader must publish it");
  assert.match(src, /volume_usd\?\.h24/, "the GeckoTerminal reader must publish it");
  assert.match(src, /vol24h: trusted\.vol24h \?\? gt\.vol24h \?\? ds\.vol24h/, "…and the merge must keep it");
  // A ZERO volume is a fact and must not read as "unknown": `num()` answers
  // null for 0, which is why this needed its own reader.
  assert.match(src, /const vnum =/, "a volume needs a reader that allows 0");
});
