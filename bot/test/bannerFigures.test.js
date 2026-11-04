// The figures the listing / trending artwork prints have ONE owner:
// fulfillment.bannerFigures. Four builders used to spell them, and three of
// them used toPrecision(4) — "$4.751e-7" for a pump.fun curve price, "$1.235e+4"
// for a token over $10k, and "$2,410,000,000" where a paid post prints "$2.4B".
// The same token read two ways depending on which door listed it, and the admin
// force-post (whose job is to show what a real post looks like) dropped the
// liquidity column altogether.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const fulfillment = require("../src/fulfillment");
const autoLister = require("../src/services/autoLister");
const forcePost = require("../src/admin/forcePost");

const { bannerFigures } = fulfillment;

test("bannerFigures: the spellings a reader can check against the token page", () => {
  assert.deepEqual(bannerFigures({ priceUsd: 4.751e-7, mcap: 4255.6, liq: 360.9 }), {
    price: "$0.0000004751",
    mcap: "$4.3K",
    liq: "$360",
  });
  assert.deepEqual(bannerFigures({ priceUsd: 12345.6, mcap: 2.41e9, liq: 1.23e8 }), {
    price: "$12,345.60",
    mcap: "$2.4B",
    liq: "$123M",
  });
});

test("bannerFigures: never exponent notation, at any magnitude", () => {
  for (let e = -13; e <= 8; e++) {
    for (const m of [1, 4.751, 9.99]) {
      const v = m * 10 ** e;
      const f = bannerFigures({ priceUsd: v, mcap: v * 1e6, liq: v * 1e5 });
      for (const [k, s] of Object.entries(f)) {
        if (s == null) continue;
        assert.doesNotMatch(s, /e[+-]?\d/i, `${k} for ${v} printed ${s}`);
        assert.doesNotMatch(s, /NaN|Infinity|undefined/, `${k} for ${v} printed ${s}`);
      }
    }
  }
});

test("bannerFigures: a missing figure is TBA (price) or left out (cap, depth) — never $0", () => {
  const empty = { price: "TBA", mcap: null, liq: null };
  assert.deepEqual(bannerFigures(null), empty);
  assert.deepEqual(bannerFigures(undefined), empty);
  assert.deepEqual(bannerFigures({ priceUsd: 0, mcap: 0, liq: 0 }), empty);
  assert.deepEqual(bannerFigures({ priceUsd: NaN, mcap: -5, liq: "x" }), empty);
});

const MARKETS = [
  { priceUsd: 4.751e-7, mcap: 4255.6, liq: 360.9 },
  { priceUsd: 12345.6, mcap: 2.41e9, liq: 1.23e8 },
  { priceUsd: 1.204, mcap: 12.9e6, liq: 0 },
  { priceUsd: 0, mcap: 0, liq: 0 },
];

test("every banner builder prints the SAME figures for the same market", () => {
  for (const live of MARKETS) {
    const want = bannerFigures(live);
    const pick = (c) => ({ price: c.price, mcap: c.mcap, liq: c.liq });
    const paid = fulfillment._bannerCoinOf({ sym: "X", name: "X", chain: "solana" }, live);
    const free = autoLister.bannerCoinFor({ chain: "solana" }, live, { sym: "X", name: "X" });
    const forced = forcePost._bannerCoinOf({
      symbol: "X",
      name: "X",
      chain: "solana",
      price: live.priceUsd,
      mcap: live.mcap,
      liq: live.liq,
    });
    assert.deepEqual(pick(paid), want, `paid listing, ${JSON.stringify(live)}`);
    assert.deepEqual(pick(free), want, `free auto listing, ${JSON.stringify(live)}`);
    assert.deepEqual(pick(forced), want, `admin force-post, ${JSON.stringify(live)}`);
  }
});

// The auto-trend banner is built inline inside an async announce, so the
// builders are pinned by source too — scoped to the BUILDER bodies, because the
// operator's log lines ("below its trigger ($812,400 < …)") spell caps in full
// on purpose. A fifth private spelling is how this drifted four times.
const code = (f) =>
  fs
    .readFileSync(path.join(__dirname, "..", f), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
const between = (src, start, end) => {
  const i = src.indexOf(start);
  assert.ok(i >= 0, `builder not found: ${start}`);
  const j = src.indexOf(end, i + start.length);
  assert.ok(j > i, `builder end not found after ${start}`);
  return src.slice(i, j);
};

test("no banner builder spells its own price or cap", () => {
  const builders = [
    ["src/fulfillment.js", between(code("src/fulfillment.js"), "function bannerCoinOf(", "\n}\n")],
    ["src/services/autoLister.js", between(code("src/services/autoLister.js"), "function bannerCoinFor(", "\n}\n")],
    ["src/admin/forcePost.js", between(code("src/admin/forcePost.js"), "function bannerCoinOf(", "\n}\n")],
    ["src/services/autoTrend.js", between(code("src/services/autoTrend.js"), 'postMedia(\n    "trending"', ").catch(")],
  ];
  for (const [f, body] of builders) {
    assert.match(body, /\.\.\.(?:require\("\.\.\/fulfillment"\)\.)?bannerFigures\(/, `${f}: the banner builder reads the one owner`);
    assert.doesNotMatch(body, /toPrecision\(|toLocaleString\(|formatNumber\(|fmtPrice\(/, `${f}: the banner builder spells a figure itself`);
  }
});
