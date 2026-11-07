// "mengapa free listing not much work padahal setiap hari ada project memecoin
// yang 1m ke atas mcnya" (2026-09-28) — 41h of "priced 12 and none qualified —
// below its trigger ×12" while $1M memecoins launched every day.
//
// Two holes, both about WHICH tokens reach pricing:
//   1. the only feeds were "latest" snapshots of minutes-old microcaps, and
//   2. a token seen small was cooled and, once it scrolled off the feed, never
//      looked at again — the scanner saw every future $1M project while it was
//      tiny and forgot it.
// These tests pin both fixes, and the scan tests are DRIVEN through runOnce: a
// unit test of `revisits()` passes on a scan that never calls it.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-movers-"));

const test = require("node:test");
const assert = require("node:assert");

const al = require("../src/services/autoLister");
const api = require("../src/api/dexvra");
const movers = require("../src/services/marketMovers");
const discovery = require("../src/discovery");
const ds = require("../src/dexscreener");
const ps = require("../src/poolstrade");

const M = 1_000_000;
const HOUR = 3_600_000;
const now = 1_800_000_000_000;

const healthy = (over = {}) => ({
  name: "Moon Frog",
  symbol: "MFROG",
  mcap: 1.5 * M,
  liq: 150_000,
  vol24: 400_000,
  priceUsd: 0.0015,
  logoUrl: "https://dd.dexscreener.com/x.png",
  pairCreatedAt: now - 72 * HOUR,
  ...over,
});

// A GT pools response, as `include=base_token` returns it.
const gtBody = (rows) => ({
  data: rows.map((r, i) => ({
    attributes: { market_cap_usd: r.mcap ?? null, fdv_usd: r.fdv ?? null, reserve_in_usd: String(r.liq || 50_000) },
    relationships: { base_token: { data: { id: `t${i}` } } },
  })),
  included: rows.map((r, i) => ({ id: `t${i}`, type: "token", attributes: { address: r.address, symbol: r.symbol || "MEME", name: r.name || "Meme" } })),
});

// ── the source ──────────────────────────────────────────────────────────────
//
// The GT-mechanics tests below force GeckoTerminal ON and stub DexScreener as
// refusing, so GT alone decides each answer. Whether GT is asked AT ALL on a
// keyless box is its own test further down.
process.env.AUTOLIST_MOVERS_GT = "1";
const noDs = async () => ({ ok: false, why: "stubbed out", items: [] });

test("parsePools: one candidate per BASE token, the money filtered out, fdv as the hint when cap is null", () => {
  const out = movers.parsePools(
    gtBody([
      { address: "So1Meme", fdv: 2.1 * M },
      { address: "So1Wrapped", symbol: "WSOL", name: "Wrapped SOL", mcap: 90e9 },
      { address: "So1Meme", fdv: 9 * M, liq: 1_000 }, // a thin sibling pool — its fdv must not win
    ]),
    "solana",
  );
  assert.deepStrictEqual(out, [{ chain: "solana", address: "So1Meme", mcapHint: 2.1 * M }]);
});

test("fetchMoversX: one GT request per chain in scope, and a refusal is ok:false with the reason — never an empty market", async () => {
  await movers._reset();
  const asked = [];
  const refusing = await movers.fetchMoversX({
    dsTop: noDs,
    chains: ["solana", "bsc"],
    now,
    get: async (p) => {
      asked.push(p);
      return { ok: false, status: 429, reason: "rate limited" };
    },
  });
  assert.strictEqual(asked.length, 2);
  assert.ok(asked.every((p) => /\/trending_pools$/.test(p)), asked.join());
  assert.strictEqual(refusing.ok, false, "a GT refusing us is not 'nothing is moving'");
  assert.match(refusing.why, /solana: GeckoTerminal rate limited; DexScreener stubbed out/, "both sources named — a 429 and a DexScreener outage are different fixes");

  await movers._reset();
  const answering = await movers.fetchMoversX({ dsTop: noDs, chains: ["solana"], now, get: async () => ({ ok: true, body: gtBody([{ address: "So1A", mcap: 1.2 * M }]) }) });
  assert.strictEqual(answering.ok, true);
  assert.deepStrictEqual(answering.items, [{ chain: "solana", address: "So1A", mcapHint: 1.2 * M }]);
  // A second ask inside the TTL costs nothing — a scan and a 🔎 Test scan
  // minutes apart must not both spend a GT request per chain.
  let again = 0;
  await movers.fetchMoversX({ dsTop: noDs, chains: ["solana"], now: now + 60_000, get: async () => (again++, { ok: true, body: gtBody([]) }) });
  assert.strictEqual(again, 0);
});

test("fetchMoversX: with nothing on file, a GT queue that will not answer costs the scan its budget — and the late answer is kept for the next scan", async () => {
  await movers._reset();
  let release;
  const slow = new Promise((r) => (release = r));
  const t0 = Date.now();
  const r = await movers.fetchMoversX({ dsTop: noDs, chains: ["solana"], now, budgetMs: 1_000, get: () => slow });
  assert.ok(Date.now() - t0 < 3_000, "the scan waited on the GT queue past its budget");
  assert.strictEqual(r.ok, false);
  assert.match(r.why, /solana: no answer yet/);
  release({ ok: true, body: gtBody([{ address: "So1Late", mcap: 1.1 * M }]) });
  await new Promise((r2) => setTimeout(r2, 20));
  let asked = 0;
  const next = await movers.fetchMoversX({ dsTop: noDs, chains: ["solana"], now: now + 60_000, get: async () => (asked++, { ok: false }) });
  assert.strictEqual(asked, 0, "the late answer did not land");
  assert.deepStrictEqual(next.items.map((c) => c.address), ["So1Late"]);
});

// ⚠️ THE PRODUCTION FAILURE. `listing:check` (its own process, empty GT queue)
// printed 53 movers and "5 would be listed"; ⚡ Run now in dexvra-bot — whose GT
// queue is shared with the buy bot — could not get a slot in 25s, and the 10-min
// cache expired before the next scan. The scan must read what is ON FILE and
// never wait on the queue for it.
test("THE RUN-NOW BUG: with an answer on file, a GT queue that never answers costs the scan NOTHING", async () => {
  await movers._reset();
  await movers.fetchMoversX({ dsTop: noDs, chains: ["solana"], now, get: async () => ({ ok: true, body: gtBody([{ address: "So1Hot", mcap: 3 * M }]) }) });
  let refreshes = 0;
  const never = () => (refreshes++, new Promise(() => {}));
  const t0 = Date.now();
  const r = await movers.fetchMoversX({ dsTop: noDs, chains: ["solana"], now: now + 2 * HOUR, budgetMs: 60_000, get: never });
  assert.ok(Date.now() - t0 < 1_000, `the scan waited on the GT queue with an answer on file (${Date.now() - t0}ms)`);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.items.map((c) => c.address), ["So1Hot"]);
  assert.strictEqual(refreshes, 1, "a stale answer must still start a refresh behind it");
  // …but not one older than the stale bound: a day-old trending list is not served.
  await movers._reset();
  await movers.fetchMoversX({ dsTop: noDs, chains: ["bsc"], now, get: async () => ({ ok: true, body: gtBody([{ address: "0xold", mcap: 3 * M }]) }) });
  const old = await movers.fetchMoversX({ dsTop: noDs, chains: ["bsc"], now: now + movers.STALE_MS + HOUR, budgetMs: 1_000, get: async () => ({ ok: false, reason: "rate limited" }) });
  assert.deepStrictEqual(old.items, []);
});

test("the answer is PERSISTED — a restart, or listing:check in its own process, warms the bot", async () => {
  await movers._reset();
  await movers.fetchMoversX({ dsTop: noDs, chains: ["base"], now, get: async () => ({ ok: true, body: gtBody([{ address: "0xpersist", mcap: 2 * M }]) }) });
  movers._forgetMemory(); // a new process: memory gone, the file kept
  const r = await movers.fetchMoversX({ dsTop: noDs, chains: ["base"], now: now + 60_000, get: async () => ({ ok: false, reason: "should not be asked" }) });
  assert.deepStrictEqual(r.items.map((c) => c.address), ["0xpersist"]);
});

test("warm() starts refreshes without waiting, and start() calls it at boot", async () => {
  await movers._reset();
  const asked = [];
  movers.warm(["solana", "bsc"], { dsTop: noDs, now, get: async (p) => (asked.push(p), { ok: true, body: gtBody([]) }) });
  await new Promise((r) => setTimeout(r, 10));
  assert.strictEqual(asked.length, 2);
  const src = require("node:fs").readFileSync(require.resolve("../src/services/autoLister"), "utf8");
  const startBody = src.slice(src.indexOf("function start(tg"));
  assert.match(startBody.slice(0, 2500), /movers\.warm\(/, "start() no longer warms the movers source — the first scan after a deploy is blind again");
});

test("fetchMoversX: an empty scope asks the memecoin chains, never more than MAX_CHAINS; AUTOLIST_MOVERS=0 asks nothing", async () => {
  await movers._reset();
  const asked = [];
  await movers.fetchMoversX({ dsTop: noDs, chains: [], now, get: async (p) => (asked.push(p), { ok: true, body: gtBody([]) }) });
  assert.strictEqual(asked.length, movers.chainsFor([]).length);
  assert.ok(asked.length > 0 && asked.length <= movers.MAX_CHAINS);
  process.env.AUTOLIST_MOVERS = "0";
  try {
    await movers._reset();
    let n = 0;
    const r = await movers.fetchMoversX({ dsTop: noDs, now, get: async () => (n++, { ok: true, body: gtBody([]) }) });
    assert.strictEqual(n, 0);
    assert.strictEqual(r.ok, true);
  } finally {
    delete process.env.AUTOLIST_MOVERS;
  }
});

// ⚠️ THE BOX'S OWN STATE (2026-09-28): `gtmovers → bsc: rate limited ·
// robinhood: cooldown …` beside `[buybot] GeckoTerminal backing off for 120s …
// Buy alerts are paused`. Every GT request this source added was taken from the
// buy bot, so on a keyless box it asks DexScreener and leaves GT alone.
test("on a KEYLESS box GeckoTerminal is not asked at all — DexScreener answers, with the cap as the hint", async () => {
  await movers._reset();
  delete process.env.AUTOLIST_MOVERS_GT;
  try {
    let gtAsked = 0;
    const r = await movers.fetchMoversX({
      chains: ["solana"],
      now,
      get: async () => (gtAsked++, { ok: true, body: gtBody([]) }),
      dsTop: async (chain, o) => {
        assert.strictEqual(o.feeds, false, "the scan reads the feeds already — asking twice is two requests for one list");
        return { ok: true, items: [{ address: "So1Ds", mcap: 1.3 * M, symbol: "DSMEME" }] };
      },
    });
    assert.strictEqual(gtAsked, 0, "a keyless box's GT quota belongs to the buy bot");
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(r.items, [{ chain: "solana", address: "So1Ds", mcapHint: 1.3 * M }]);
  } finally {
    process.env.AUTOLIST_MOVERS_GT = "1";
  }
});

test("GT refusing while DexScreener answers is an ANSWER — and with both, the GT row wins the merge", async () => {
  await movers._reset();
  const ds = async () => ({ ok: true, items: [{ address: "So1Both", mcap: 0.9 * M }, { address: "So1DsOnly", mcap: 2 * M }] });
  const refused = await movers.fetchMoversX({ chains: ["solana"], now, dsTop: ds, get: async () => ({ ok: false, reason: "rate limited" }) });
  assert.strictEqual(refused.ok, true, "a GT 429 must not blind the scan while DexScreener answers");
  assert.strictEqual(refused.items.length, 2);
  await movers._reset();
  const both = await movers.fetchMoversX({ chains: ["solana"], now, dsTop: ds, get: async () => ({ ok: true, body: gtBody([{ address: "So1Both", mcap: 1.4 * M }]) }) });
  assert.deepStrictEqual(
    both.items.map((c) => [c.address, c.mcapHint]),
    [
      ["So1Both", 1.4 * M],
      ["So1DsOnly", 2 * M],
    ],
  );
});

test("discovery: the movers source is OPT-IN, leads the round-robin, and its hint survives the merge", async () => {
  const real = { d: ds.fetchDiscoveryX, p: ps.fetchDiscoveryX, m: movers.fetchMoversX };
  let moversAsked = 0;
  ds.fetchDiscoveryX = async () => ({ items: [{ chain: "solana", address: "So1Feed" }, { chain: "solana", address: "So1Both" }], ok: true });
  ps.fetchDiscoveryX = async () => ({ items: [], ok: true });
  movers.fetchMoversX = async () => (moversAsked++, { items: [{ chain: "solana", address: "So1Both", mcapHint: 2 * M }], ok: true });
  try {
    await discovery.fetchDiscoveryX();
    assert.strictEqual(moversAsked, 0, "a caller that did not ask must not spend GT requests");
    const d = await discovery.fetchDiscoveryX({ movers: true });
    assert.strictEqual(moversAsked, 1);
    assert.deepStrictEqual(d.items[0], { chain: "solana", address: "So1Both", mcapHint: 2 * M });
    assert.deepStrictEqual(d.items[1], { chain: "solana", address: "So1Feed" }, "the long-standing shape is unchanged where there is no hint");
    assert.ok(d.sources.some((s) => s.name === "gtmovers"));
  } finally {
    ds.fetchDiscoveryX = real.d;
    ps.fetchDiscoveryX = real.p;
    movers.fetchMoversX = real.m;
  }
});

// ── the order ───────────────────────────────────────────────────────────────

test("orderCandidates: near-the-floor hints first, the feed in its own order next, out-of-range hints last", () => {
  const cfg = { minMcap: 1 * M, maxMcapHard: 50 * M };
  const out = al.orderCandidates(
    [
      { address: "feed1" },
      { address: "huge", mcapHint: 900 * M },
      { address: "tiny", mcapHint: 20_000 },
      { address: "near", mcapHint: 0.8 * M },
      { address: "feed2" },
      { address: "big", mcapHint: 6 * M },
    ],
    cfg,
  );
  assert.deepStrictEqual(out.map((c) => c.address), ["near", "big", "feed1", "feed2", "huge", "tiny"]);
});

// ── driven scans ────────────────────────────────────────────────────────────

async function withSite(fn) {
  const real = { c: api.createListing, g: api.getListings };
  const created = [];
  api.createListing = async (input) => (created.push(input), { id: "x", ...input });
  api.getListings = async () => [];
  try {
    return await fn(created);
  } finally {
    api.createListing = real.c;
    api.getListings = real.g;
  }
}

test("THE REPORTED BUG: a token seen SMALL, gone from the feed, and grown past its trigger is found and listed", async () => {
  await al.resetState(now - 10 * HOUR);
  await al.set({ enabled: true, minMcap: 1 * M, maxMcap: 1.5 * M, paceListings: false, postChannel: false });
  await withSite(async (created) => {
    let mcap = 30_000;
    let feed = [{ chain: "solana", address: "So1Grower" }];
    const deps = {
      fetchDiscoveryX: async () => ({ items: feed, ok: true, sources: [] }),
      // Only the grower grows — the newcomer in scan 2 stays a microcap, so a 1
      // below can only be the remembered token.
      fetchTokenInfo: async (c, a) => healthy({ mcap: a === "So1Grower" ? mcap : 30_000 }),
    };
    // Scan 1: the feed shows it at $30k — turned down, and far enough below to
    // be cooled for 12h.
    assert.strictEqual(await al.runOnce({ now, deps }), 0);
    // It scrolls off the "latest" feed, and a day later it is a $1.5M project.
    feed = [{ chain: "solana", address: "So1Other" }];
    mcap = 1.5 * M;
    const later = now + 24 * HOUR;
    assert.strictEqual(await al.runOnce({ now: later, deps }), 1, "the grown token was never looked at again — the reported bug");
    assert.strictEqual(created.length, 1);
    const s = al.lastScan();
    assert.ok(s.revisited >= 1, `the report must say it re-checked earlier sightings: ${JSON.stringify(s)}`);
  });
});

test("a remembered token still honours its cool-off — the memory rotates, it does not hammer", async () => {
  await al.resetState(now - 10 * HOUR);
  await al.set({ enabled: true, minMcap: 1 * M, maxMcap: 1.5 * M, paceListings: false, postChannel: false });
  await withSite(async () => {
    const priced = [];
    let feed = [{ chain: "solana", address: "So1Tiny" }];
    const deps = {
      fetchDiscoveryX: async () => ({ items: feed, ok: true, sources: [] }),
      fetchTokenInfo: async (c, a) => (priced.push(a), healthy({ mcap: 20_000 })),
    };
    await al.runOnce({ now, deps });
    feed = [{ chain: "solana", address: "So1Else" }];
    priced.length = 0;
    await al.runOnce({ now: now + HOUR, deps }); // well inside the 12h cool
    assert.ok(!priced.includes("So1Tiny"), "a token 50× below its trigger was re-priced an hour later");
    // …and it is not re-offered at all while cooled, or every remembered token
    // would inflate "N on cool-off" on the panel — up to two thousand of them.
    assert.strictEqual(al.lastScan().cooled, 0, "a cooled sighting was offered to the loop anyway");
    priced.length = 0;
    await al.runOnce({ now: now + 13 * HOUR, deps });
    assert.ok(priced.includes("So1Tiny"), "past its cool-off, a remembered token must be asked again");
  });
});

test("the scan asks discovery for the movers, and prices a near-the-floor mover BEFORE the feed's microcaps", async () => {
  await al.resetState(now - 10 * HOUR);
  await al.set({ enabled: true, minMcap: 1 * M, maxMcap: 1.5 * M, paceListings: false, postChannel: false });
  await withSite(async (created) => {
    let opts = null;
    const priced = [];
    const deps = {
      fetchDiscoveryX: async (o) => (
        (opts = o),
        {
          // The feed's microcaps come FIRST from discovery; on a real scan the
          // lookup budget runs out on them before the mover is ever reached.
          items: [
            { chain: "solana", address: "So1Micro1" },
            { chain: "solana", address: "So1Micro2" },
            { chain: "solana", address: "So1Mover", mcapHint: 1.6 * M },
          ],
          ok: true,
          sources: [],
        }
      ),
      fetchTokenInfo: async (c, a) => (priced.push(a), a === "So1Mover" ? healthy({ mcap: 1.6 * M }) : healthy({ mcap: 25_000 })),
    };
    assert.strictEqual(await al.runOnce({ now, deps }), 1);
    assert.strictEqual(opts && opts.movers, true, "the scan must ask for the market-movers source");
    assert.strictEqual(priced[0], "So1Mover", `the mover waited behind the microcaps: ${priced.join()}`);
    assert.strictEqual(created.length, 1);
    assert.strictEqual(al.lastScan().movers, 1);
  });
});

test("🧹 Clear history forgets the sightings too — it is a statement about tokens", async () => {
  await al.resetState(now - 10 * HOUR);
  await al.set({ enabled: true, minMcap: 1 * M, maxMcap: 1.5 * M, paceListings: false, postChannel: false });
  await withSite(async () => {
    await al.runOnce({
      now,
      deps: { fetchDiscoveryX: async () => ({ items: [{ chain: "solana", address: "So1Seen" }], ok: true, sources: [] }), fetchTokenInfo: async () => healthy({ mcap: 10_000 }) },
    });
  });
  const statePath = path.join(process.env.BOT_DATA_DIR, "autoListerState.json");
  assert.ok(Object.keys(JSON.parse(fss.readFileSync(statePath, "utf8")).seen || {}).length >= 1, "precondition: the sighting was recorded");
  await al.resetState(now + HOUR);
  assert.deepStrictEqual(JSON.parse(fss.readFileSync(statePath, "utf8")).seen, {});
});

test("pruneSeen: a week-old sighting is dropped, and the memory is bounded", () => {
  const seen = { a: { c: "solana", a: "A", f: now - 8 * 24 * HOUR, t: now }, b: { c: "solana", a: "B", f: now - HOUR, t: now } };
  assert.deepStrictEqual(Object.keys(al.pruneSeen(seen, now)), ["b"]);
});

// ── so it cannot go quiet unnoticed again ───────────────────────────────────
// The reported alert said "Nothing is broken; lower 🎯". For THIS failure that
// advice is wrong: the closest candidate was a fraction of $1M, and lowering
// the trigger to meet it lists microcaps. The watch measures HOW FAR below.

const watch = require("../src/services/listingWatch");

test("THE REPORTED ALERT: ×12 below trigger with the closest at 3% is a BLIND discovery, not a quiet market", () => {
  const scan = {
    priced: 12,
    reasons: { "below its trigger": 12 },
    nearest: { sym: "PEPE2", chain: "solana", mcap: 34_000, ratio: 0.03 },
    sources: [{ name: "gtmovers", ok: false, why: "solana: rate limited" }],
    movers: 0,
  };
  const d = watch.diagnose(scan);
  assert.strictEqual(d.code, "blind_discovery");
  assert.strictEqual(d.fault, true, "a scan that cannot see $1M tokens is a fault, not 'the service is running correctly'");
  assert.match(d.text, /3% of its trigger/);
  assert.match(d.text, /rate limited/, "the reason the movers source failed must be named");
  assert.doesNotMatch(d.text, /lower 🎯 if/, "the advice that would list microcaps must not be given here");
});

test("…but candidates sitting just under their triggers is still the market, and still says so", () => {
  const d = watch.diagnose({ priced: 12, reasons: { "below its trigger": 12 }, nearest: { sym: "X", mcap: 950_000, ratio: 0.9 }, sources: [], movers: 3 });
  assert.strictEqual(d.code, "nothing_qualified");
  assert.strictEqual(d.fault, false);
});

test("a scan records the candidate CLOSEST to its trigger, and the scan line prints it", async () => {
  await al.resetState(now - 10 * HOUR);
  await al.set({ enabled: true, minMcap: 1 * M, maxMcap: 1.5 * M, paceListings: false, postChannel: false });
  await withSite(async () => {
    const caps = { So1A: 20_000, So1B: 400_000, So1C: 60_000 };
    await al.runOnce({
      now,
      deps: {
        fetchDiscoveryX: async () => ({ items: Object.keys(caps).map((a) => ({ chain: "solana", address: a })), ok: true, sources: [] }),
        fetchTokenInfo: async (c, a) => healthy({ mcap: caps[a] }),
      },
    });
  });
  const s = al.lastScan();
  assert.strictEqual(s.nearest && s.nearest.mcap, 400_000, `nearest: ${JSON.stringify(s.nearest)}`);
  assert.match(al.scanLine(s), /closest \$MFROG \$400\.0K = \d+% of its trigger/);
});
