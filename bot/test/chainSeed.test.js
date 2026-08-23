// Seeding a chain to N listings — "tambahkan token chain bsc base eth 50 token
// top nya … tidak perlu di announce cukup tambahkan aja tokennya".
//
// What these pin, each one a way a bulk lister could quietly do the wrong
// thing to a public site: it lists with the `free` package and never the
// `trending` one (which books a board slot nobody sold), it ANNOUNCES nothing,
// the target is up-to rather than add-N (so a re-run cannot double a chain),
// a token already listed or listed-once-and-removed is skipped, and "the
// market could not be read" stays a different answer from "there was nothing
// to add".
const test = require("node:test");
const assert = require("node:assert");

const seeder = require("../src/services/chainSeed");
const autoLister = require("../src/services/autoLister");

/** The module's CODE, comments stripped. A scan over the raw file matches the
 *  header explaining why the rule exists, so a correct module fails its own
 *  guard — the same trap the base58 ban in tradebot had to be rescued from. */
function code() {
  return require("node:fs")
    .readFileSync(require.resolve("../src/services/chainSeed.js"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

/** A GT-shaped big-coin row. */
const coin = (i, over = {}) => ({
  address: `0x${String(i).padStart(40, "a")}`,
  symbol: `T${i}`,
  name: `Token ${i}`,
  mcap: 10_000_000 - i,
  liq: 500_000,
  priceUsd: 1,
  ...over,
});

/** seedChain with every dependency injected — no network, no disk. */
function harness({ items = [], ok = true, why = null, rows = [], ever = () => false, createImpl, topImpl, cooldown = () => 0, sleepImpl } = {}) {
  const calls = { create: [], info: [], top: [], slept: [] };
  const deps = {
    cooldownRemaining: cooldown,
    async topByMcap(chain, o) {
      calls.top.push([chain, o]);
      if (topImpl) return topImpl(chain, o, calls.top.length);
      return { ok, why, items };
    },
    async getListings() {
      return rows;
    },
    wasEverListed: ever,
    async fetchTokenInfo(chain, address) {
      calls.info.push([chain, address]);
      return { name: "Enriched", symbol: "ENR", logoUrl: "http://x/y.png" };
    },
    async createFromInfo(chain, address, info, opts) {
      calls.create.push({ chain, address, info, opts });
      if (createImpl) return createImpl(chain, address, info, opts);
      return { listing: { id: address }, input: { sym: info.symbol } };
    },
    async sleep(ms) {
      calls.slept.push(ms);
      if (sleepImpl) await sleepImpl(ms);
    },
  };
  return { deps, calls };
}

test("plan is pure and takes exactly the shortfall, best first", () => {
  const p = seeder.plan({
    chain: "bsc",
    target: 50,
    current: 47,
    candidates: [coin(1), coin(2), coin(3), coin(4), coin(5)],
    known: new Set(),
    everListed: () => false,
  });
  assert.strictEqual(p.need, 3);
  assert.deepStrictEqual(p.take.map((c) => c.symbol), ["T1", "T2", "T3"]);
});

test("the target is UP TO, not add-N — a chain already there lists nothing", async () => {
  const { deps, calls } = harness({
    items: [coin(1), coin(2)],
    rows: Array.from({ length: 50 }, (_, i) => ({ chain: "base", address: `0x${i}` })),
  });
  const r = await seeder.seedChain("base", { target: 50, apply: true, deps, gapMs: 0 });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.listed, []);
  assert.match(r.why, /already at 50\/50/);
  assert.strictEqual(calls.create.length, 0, "nothing may be created at target");
  assert.strictEqual(calls.top.length, 0, "and the market is not even asked");
});

test("it lists with the FREE package — never `trending`, which books a board slot", async () => {
  const { deps, calls } = harness({ items: [coin(1), coin(2)] });
  await seeder.seedChain("bsc", { target: 2, apply: true, deps, gapMs: 0 });
  assert.strictEqual(calls.create.length, 2);
  for (const c of calls.create) {
    assert.strictEqual(c.opts.pkgKey, "free", "a seeded row is a plain listing, not a purchase");
  }
});

test("nothing is announced — no channel path exists on this module at all", () => {
  // `announce()` is reachable only from autoLister.runOnce, and only when it is
  // given a `tg`. A seeder that grew either would post fifty cards to a channel
  // of 12,607 subscribers — exactly what the operator asked not to happen.
  const src = code();
  assert.ok(!/\btg\b/.test(src), "chainSeed must never hold a telegram handle");
  assert.ok(!/announce|postChannel|runOnce/.test(src), "chainSeed must not reach the announcing path");
});

test("a token already listed, or listed once and removed, is skipped", async () => {
  const { deps, calls } = harness({
    items: [coin(1), coin(2), coin(3)],
    rows: [{ chain: "bsc", address: coin(1).address.toUpperCase() }], // case must not matter
    ever: (chain, address) => address === coin(2).address,
  });
  const r = await seeder.seedChain("bsc", { target: 3, apply: true, deps, gapMs: 0 });
  assert.deepStrictEqual(calls.create.map((c) => c.address), [coin(3).address]);
  assert.match(r.why, /1 already listed, 1 listed before and removed/);
});

test("an unreadable market is ok:false — NOT an empty chain", async () => {
  const { deps, calls } = harness({ ok: false, why: "429 from GeckoTerminal", items: [] });
  const r = await seeder.seedChain("ethereum", { target: 50, apply: true, deps, gapMs: 0 });
  assert.strictEqual(r.ok, false);
  assert.match(r.why, /could not read the market.*429/);
  assert.strictEqual(calls.create.length, 0);

  // …and the readable-but-empty case is a different answer with ok:true.
  const empty = harness({ ok: true, items: [] });
  const r2 = await seeder.seedChain("ethereum", { target: 50, apply: true, deps: empty.deps, gapMs: 0 });
  assert.strictEqual(r2.ok, true);
  assert.match(r2.why, /clear the floor/);
});

test("a dry run plans and writes nothing", async () => {
  const { deps, calls } = harness({ items: [coin(1), coin(2), coin(3)] });
  const r = await seeder.seedChain("base", { target: 3, deps, gapMs: 0 });
  assert.strictEqual(r.planned, 3);
  assert.deepStrictEqual(r.listed, []);
  assert.strictEqual(calls.create.length, 0, "--apply is the only thing that writes");
});

test("one refusal does not end the run, and is reported", async () => {
  const { deps, calls } = harness({
    items: [coin(1), coin(2), coin(3)],
    createImpl: (chain, address, info) => {
      if (address === coin(2).address) throw new Error("site said 400");
      return { listing: {}, input: { sym: info.symbol } };
    },
  });
  const r = await seeder.seedChain("bsc", { target: 3, apply: true, deps, gapMs: 0 });
  assert.strictEqual(calls.create.length, 3, "the third candidate is still tried");
  assert.strictEqual(r.listed.length, 2);
  assert.strictEqual(r.failed, 1);
  assert.match(r.why, /1 refused by the site/);
});

test("token info is an UPGRADE — a failed lookup still lists the token", async () => {
  const { deps, calls } = harness({ items: [coin(1)] });
  deps.fetchTokenInfo = async () => {
    throw new Error("timeout");
  };
  const r = await seeder.seedChain("bsc", { target: 1, apply: true, deps, gapMs: 0 });
  assert.strictEqual(r.listed.length, 1);
  assert.strictEqual(calls.create[0].info.name, "Token 1", "GT's own name carries the listing");
});

test("an unknown chain is refused before anything is read", async () => {
  const { deps, calls } = harness({ items: [coin(1)] });
  const r = await seeder.seedChain("notachain", { target: 50, apply: true, deps, gapMs: 0 });
  assert.strictEqual(r.ok, false);
  assert.match(r.why, /unknown chain/);
  assert.strictEqual(calls.top.length, 0);
});

test("it asks GT for far MORE than the shortfall, within GT's page limit", async () => {
  const { deps, calls } = harness({ items: [] });
  await seeder.seedChain("bsc", { target: 50, pages: 99, deps, gapMs: 0 });
  const [, o] = calls.top[0];
  // The biggest tokens on a chain are the ones most likely to be listed
  // already, so a limit of exactly `need` comes back mostly consumed.
  assert.ok(o.limit >= 50 * 4, `limit ${o.limit} must exceed the shortfall`);
  assert.strictEqual(o.pages, seeder.GT_MAX_PAGES, "GT serves 10 pages — asking for more is a wasted request");
});

test("createFromInfo is the ONE owner of turning a priced token into a listing", () => {
  // The seeder must not grow a second idea of what an auto listing is — the
  // rule trendFill was written under, and the reason everListed is honoured
  // through both doors.
  assert.strictEqual(typeof autoLister.createFromInfo, "function");
  assert.ok(!/createListing/.test(code()), "chainSeed must go through autoLister, never the API directly");
});


// ── GeckoTerminal's shared 120s cooldown ─────────────────────────────────────
//
// The first live dry run is what these are about. BSC read one page, GT 429'd
// on page 2 — which arms a PROCESS-WIDE cooldown — and the run then reported
// "only 7 token(s) on bsc clear the floor" plus two chains that were never
// asked anything at all:
//
//   ✗ base — could not read the market for base: cooldown
//   ✗ ethereum — could not read the market for ethereum: cooldown
//
// Every line of that is our own quota, printed as three facts about three
// chains. A bulk one-off is exactly the caller that can afford to wait.

test("a cooldown is WAITED OUT and the read RESUMES at the page that failed", async () => {
  let left = 120_000;
  const { deps, calls } = harness({
    cooldown: () => left,
    topImpl: (chain, o, n) =>
      n === 1
        ? { ok: true, why: "rate limited", nextPage: 2, pagesRead: 1, items: [coin(1)] }
        : { ok: true, why: null, nextPage: null, pagesRead: 3, items: [coin(2), coin(3)] },
    sleepImpl: async () => {
      left = 0;
    },
  });
  const r = await seeder.seedChain("bsc", { target: 3, apply: true, deps, gapMs: 0 });

  assert.strictEqual(calls.top.length, 2, "it asked again after waiting");
  assert.strictEqual(calls.top[1][1].startPage, 2, "resumed at the page that did NOT arrive");
  assert.ok(calls.slept[0] >= 120_000, `slept ${calls.slept[0]}ms — it must wait the cooldown out`);
  assert.strictEqual(r.listed.length, 3, "all three tokens found across the two reads");
  // Re-reading pages 1..N would spend the very quota that just ran out.
  assert.deepStrictEqual(calls.create.map((c) => c.address).sort(), [coin(1), coin(2), coin(3)].map((c) => c.address).sort());
});

test("a truncated read is reported as TRUNCATED, never as a thin chain", async () => {
  const { deps } = harness({
    cooldown: () => 0, // the cooldown already lifted; the read still ended early
    topImpl: () => ({ ok: true, why: "rate limited", nextPage: 2, pagesRead: 1, items: [coin(1)] }),
  });
  const r = await seeder.seedChain("bsc", { target: 50, deps, gapMs: 0 });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.truncated, "rate limited");
  // "only 1 token(s) on bsc clear the floor" would send the operator to lower
  // the market-cap floor for a problem that clears itself in two minutes.
  assert.match(r.why, /cut short/);
  assert.match(r.why, /Re-run to continue/);
  assert.ok(!/clear the floor/.test(r.why), "the quota must outrank the count");
});

test("the wait is BOUNDED — a stuck cooldown cannot hold the run for ever", async () => {
  const { deps, calls } = harness({
    cooldown: () => 120_000, // never lifts
    topImpl: () => ({ ok: true, why: "rate limited", nextPage: 2, pagesRead: 1, items: [coin(1)] }),
  });
  const r = await seeder.seedChain("bsc", { target: 50, deps, gapMs: 0, maxWaitMs: 200_000 });
  const total = calls.slept.reduce((a, b) => a + b, 0);
  assert.ok(total <= 200_000, `slept ${total}ms against a 200000ms budget`);
  assert.ok(calls.slept.length >= 1 && calls.slept.length < 20, "it stops, rather than spinning");
  assert.match(r.truncated, /wait budget is spent/);
});

test("only a COOLDOWN is worth sleeping on — a timeout answers the same in 2min", async () => {
  const { deps, calls } = harness({
    cooldown: () => 0,
    topImpl: () => ({ ok: true, why: "request failed", nextPage: 2, pagesRead: 1, items: [coin(1)] }),
  });
  await seeder.seedChain("bsc", { target: 50, deps, gapMs: 0 });
  assert.deepStrictEqual(calls.slept, [], "a dead socket is not a quota problem");
  assert.strictEqual(calls.top.length, 1);
});

test("waiting stops once there are enough candidates", async () => {
  const plenty = Array.from({ length: 300 }, (_, i) => coin(i + 1));
  const { deps, calls } = harness({
    cooldown: () => 120_000,
    topImpl: () => ({ ok: true, why: "rate limited", nextPage: 2, pagesRead: 1, items: plenty }),
  });
  await seeder.seedChain("bsc", { target: 50, deps, gapMs: 0 });
  assert.deepStrictEqual(calls.slept, [], "a target already met must not buy another two minutes");
});

test("topByMcap says WHERE it stopped, so a caller can resume there", async () => {
  const gt = require("../src/group/gtPairs");
  const bigCoins = require("../src/services/bigCoins");
  const asked = [];
  const real = gt.gtGet;
  try {
    gt.gtGet = async (path, params) => {
      asked.push(params.page);
      // page 3 is where the quota runs out
      if (params.page >= 3) return { ok: false, status: 429, reason: "rate limited" };
      return { ok: true, status: 200, body: { data: [], included: [] } };
    };
    const r = await bigCoins.topByMcap("bsc", { pages: 5, startPage: 2 });
    assert.deepStrictEqual(asked, [2, 3], "startPage is honoured, and it stops at the refusal");
    assert.strictEqual(r.nextPage, 3, "the page that did NOT arrive");
    assert.strictEqual(r.pagesRead, 1);
    assert.strictEqual(r.why, "rate limited");

    asked.length = 0;
    gt.gtGet = async (path, params) => {
      asked.push(params.page);
      return { ok: true, status: 200, body: { data: [], included: [] } };
    };
    const full = await bigCoins.topByMcap("bsc", { pages: 2 });
    assert.strictEqual(full.nextPage, null, "null means every page asked for was read");
    assert.strictEqual(full.why, null);
  } finally {
    gt.gtGet = real;
  }
});

test("the CLI halves its own GT budget BEFORE requiring the client", () => {
  // Two processes on one IP, each pacing itself at the free ceiling, is ~2x the
  // ceiling — which is how the first live run 429'd on its second page. And a
  // 429 the running BOT catches pauses every group's buy alerts for 120s, so
  // this script's convenience is charged to a paying customer's chat.
  //
  // ORDER is the rule, not presence: `gtPairs` freezes GT_MAX_RPM at require
  // time, so a line set after the require reads exactly like one that works.
  // The loadEnv guard is written the same way, for the same reason.
  const src = require("node:fs").readFileSync(require.resolve("../scripts/seed-chain.js"), "utf8");
  const set = src.indexOf("GT_MAX_RPM");
  const req = src.search(/require\('\.\.\/src\//);
  assert.ok(set > 0, "the script must lower its own GT budget");
  assert.ok(req > 0, "the script must require repo code (this guard is measuring nothing otherwise)");
  assert.ok(set < req, "GT_MAX_RPM must be set BEFORE the first repo require");
  // …and it must not overrule an operator who chose a number in .env.
  assert.match(src, /if \(!process\.env\.GT_MAX_RPM\)/);
});

test("a chain read only in PART exits non-zero — it is not a settled chain", () => {
  const src = require("node:fs").readFileSync(require.resolve("../scripts/seed-chain.js"), "utf8");
  assert.match(src, /process\.exit\(unreadable \|\| truncated \? 1 : 0\)/);
});

test("a progress renderer that throws cannot break the run", async () => {
  // The countdown is chrome. A broken terminal, a closed pipe, an EPIPE from a
  // dropped SSH session — none of them may cost the listings, which is the
  // same contract the banner renderers have with the posts they decorate.
  const { deps } = harness({ items: [coin(1), coin(2)] });
  const r = await seeder.seedChain("bsc", {
    target: 2,
    apply: true,
    deps,
    gapMs: 0,
    onProgress() {
      throw new Error("EPIPE");
    },
  });
  assert.strictEqual(r.listed.length, 2);
});

test("progress reports a WAIT before sleeping, not after", async () => {
  // Reported after the sleep it is describing, a countdown says "I waited two
  // minutes" to somebody who has already decided the terminal is stuck.
  const seenEvents = [];
  let left = 120_000;
  const { deps } = harness({
    cooldown: () => left,
    topImpl: (chain, o, n) =>
      n === 1
        ? { ok: true, why: "rate limited", nextPage: 2, pagesRead: 1, items: [coin(1)] }
        : { ok: true, why: null, nextPage: null, pagesRead: 2, items: [coin(2)] },
    sleepImpl: async () => {
      seenEvents.push("slept");
      left = 0;
    },
  });
  await seeder.seedChain("bsc", {
    target: 3,
    apply: true,
    deps,
    gapMs: 0,
    onProgress: (ev) => seenEvents.push(ev.kind),
  });
  assert.ok(seenEvents.indexOf("wait") < seenEvents.indexOf("slept"), "the wait is announced first");
  assert.ok(seenEvents.indexOf("slept") < seenEvents.indexOf("resume"), "and resume lands after it");
  assert.ok(seenEvents.includes("read"), "a page that arrived is reported too");
});
