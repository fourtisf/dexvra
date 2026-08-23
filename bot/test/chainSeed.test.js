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
function harness({ items = [], ok = true, why = null, rows = [], ever = () => false, createImpl } = {}) {
  const calls = { create: [], info: [], top: [] };
  const deps = {
    async topByMcap(chain, o) {
      calls.top.push([chain, o]);
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
    sleep: async () => {},
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
