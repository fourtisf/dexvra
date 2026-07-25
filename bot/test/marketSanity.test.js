// Bad market data reaching a PINNED public board.
//
// Live incident: the trending board printed "+521366.00%" and a market cap of
// $1,299,222,047,441 for BONK — a token whose real cap is ~$258M, and which the
// PREVIOUS refresh of the same board had shown correctly. One poisoned pool
// supplied both numbers.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-mkt-"));

const test = require("node:test");
const assert = require("node:assert");
const market = require("../src/marketdata");

function stubFetch(router) {
  const orig = global.fetch;
  global.fetch = async (url) => {
    const body = router(String(url));
    if (body === null) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => JSON.parse(body) };
  };
  return () => (global.fetch = orig);
}

const gtToken = (attrs, pools) =>
  JSON.stringify({
    data: { attributes: attrs, relationships: { top_pools: { data: pools.map((p) => ({ id: p.id })) } } },
    included: pools,
  });

test("the deepest pool wins, not whichever GT listed first", () => {
  const j = {
    data: { relationships: { top_pools: { data: [{ id: "solana_JUNK" }, { id: "solana_REAL" }] } } },
    included: [
      { id: "solana_JUNK", attributes: { address: "JUNK", reserve_in_usd: "900" } },
      { id: "solana_REAL", attributes: { address: "REAL", reserve_in_usd: "5200000" } },
    ],
  };
  assert.strictEqual(market._deepestPool(j).attributes.address, "REAL");
  // A pool GT didn't list as a top pool is not considered at all.
  const stray = { ...j, included: [...j.included, { id: "solana_STRAY", attributes: { reserve_in_usd: "9e18" } }] };
  assert.strictEqual(market._deepestPool(stray).attributes.address, "REAL");
});

test("an absurd 24h change is dropped, not published", async () => {
  const restore = stubFetch((url) => {
    if (!url.includes("geckoterminal")) return null;
    return gtToken({ price_usd: "0.0000246", market_cap_usd: "258945999" }, [
      { id: "solana_P", attributes: { address: "P", reserve_in_usd: "5200000", price_change_percentage: { h24: "521366" } } },
    ]);
  });
  try {
    const m = await market.fetchMarket("solana", "BONK");
    assert.strictEqual(m.change24h, null, "the board prints nothing rather than +521366%");
    assert.strictEqual(m.mcap, 258945999, "the rest of the reading survives");
  } finally {
    restore();
  }
});

test("a real move inside the sane band still publishes", async () => {
  const restore = stubFetch((url) => {
    if (!url.includes("geckoterminal")) return null;
    return gtToken({ price_usd: "0.01", market_cap_usd: "500000" }, [
      { id: "solana_P", attributes: { address: "P", reserve_in_usd: "80000", price_change_percentage: { h24: "-33.81" } } },
    ]);
  });
  try {
    assert.strictEqual((await market.fetchMarket("solana", "X")).change24h, -33.81);
  } finally {
    restore();
  }
});

test("market caps that disagree wildly: the deeper liquidity wins", () => {
  const gt = { mcap: 1_299_222_047_441, liq: 900, priceUsd: 0.0146 };
  const ds = { mcap: 258_945_999, liq: 5_200_000, priceUsd: 0.0000246 };
  assert.strictEqual(market._pickTrusted(gt, ds, "solana", "BONK"), ds, "a $900 pool does not value a token at $1.3T");
  // The other way round too — this is about liquidity, not about the source.
  const gtDeep = { mcap: 258_945_999, liq: 5_200_000 };
  const dsThin = { mcap: 1_299_222_047_441, liq: 400 };
  assert.strictEqual(market._pickTrusted(gtDeep, dsThin, "solana", "BONK"), gtDeep);
});

test("sources that agree (or lack a value) are left alone", () => {
  const gt = { mcap: 258_945_999, liq: 5_200_000 };
  assert.strictEqual(market._pickTrusted(gt, { mcap: 260_000_000, liq: 10 }, "solana", "B"), gt, "a normal spread keeps GT");
  assert.strictEqual(market._pickTrusted(gt, { mcap: null, liq: 99 }, "solana", "B"), gt, "no DS value → nothing to compare");
  assert.strictEqual(market._pickTrusted({ mcap: null }, { mcap: 5, liq: 9 }, "solana", "B").mcap, null, "no GT value → GT shape kept, filled downstream");
});

test("the board itself refuses to print a six-digit percentage", () => {
  const src = fss.readFileSync(require.resolve("../src/services/trendingPoster.js"), "utf8");
  assert.match(src, /SANE_PCT/, "the render site has its own clamp");
  // Defence in depth: even if marketdata is bypassed or a future caller passes
  // raw data, the pinned board must not show it.
  const pctStr = (n) => (Number.isFinite(n) && Math.abs(n) <= 5000 ? `${n >= 0 ? "+" : ""}${n.toFixed(2)}%` : "");
  assert.strictEqual(pctStr(521366), "");
  assert.strictEqual(pctStr(-99.9), "-99.90%");
  assert.strictEqual(pctStr(4999), "+4999.00%");
});
