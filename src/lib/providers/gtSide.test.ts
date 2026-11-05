// The $BTC/$LTC defect on the site's GeckoTerminal readers, and the port guard:
// gtSide.ts is a copy of shared/geckoterminal/poolSide.js, and a rule that
// drifts between two copies is worse than one in one place, because both look
// right. This LOADS the shared module and makes the two answer the same fixtures.
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
process.env.GT_INTERACTIVE_RESERVE = "0";
const { gtSideOf, ownOrdered } = await import("./gtSide.ts");
const { fetchListedMarket } = await import("./geckoterminal.ts");
const { _gtReset } = await import("./gt.ts");
const require = createRequire(import.meta.url);
const shared = require("../../../shared/geckoterminal/poolSide.js");

const BTC = "C5xph2yL6gMdxmuLGxJBkGpmuDFfyi5fqkBNhvL6pump";
const LTC = "LTCxj8Rk3sQm1yN9vW2pD7cE4hB6tA5uJ1kZ8xY2pump";
const WBTC = "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh";
const rel = (b: string, q: string) => ({ base_token: { data: { id: `solana_${b}` } }, quote_token: { data: { id: `solana_${q}` } } });
const LTC_BTC = {
  id: "solana_LtcBtc", type: "pool",
  attributes: {
    address: "LtcBtc", reserve_in_usd: "1100000", pool_created_at: null,
    price_change_percentage: { h24: "4.2" }, volume_usd: { h24: "90000" }, transactions: { h24: { buys: 900, sells: 300 } },
  },
  relationships: rel(LTC, BTC),
};
const BTC_WBTC = {
  id: "solana_BtcWbtc", type: "pool",
  attributes: {
    address: "BtcWbtc", reserve_in_usd: "486000", pool_created_at: null,
    price_change_percentage: { h24: "85.53" }, volume_usd: { h24: "631000" }, transactions: { h24: { buys: 4666, sells: 8785 } },
  },
  relationships: rel(BTC, WBTC),
};

test("the port answers every fixture exactly as the shared module does", () => {
  const cases: [unknown, string][] = [
    [LTC_BTC, BTC], [BTC_WBTC, BTC], [LTC_BTC, LTC], [BTC_WBTC, BTC.toLowerCase()],
    [{ id: "x" }, BTC], [{ relationships: { base_token: { data: { id: "eth_0xAbC" } } } }, "0xabc"], [null, BTC],
  ];
  for (const [p, a] of cases) assert.equal(gtSideOf(p as never, a), shared.gtSideOf(p, a), JSON.stringify([p && (p as { id?: string }).id, a]));
  const bare = { id: "solana_Bare", attributes: { reserve_in_usd: "1" } };
  const mine = ownOrdered([LTC_BTC, bare, BTC_WBTC] as never[], BTC).map((p: { id: string }) => p.id);
  assert.deepEqual(mine, ["solana_BtcWbtc", "solana_Bare"], "base-side first, quote-side never");
  assert.ok(!mine.includes("solana_LtcBtc"));
});

test("the board's GT read takes the token's change, volume and counts from its OWN pool", async () => {
  _gtReset();
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    Response.json({
      data: [{
        id: `solana_${BTC}`,
        attributes: { address: BTC, name: "Big Titty Coin", symbol: "BTC", image_url: null, price_usd: "0.01635", market_cap_usd: "16200000", fdv_usd: null, total_reserve_in_usd: "1586000" },
        // the stranger's pool FIRST — the whole defect
        relationships: { top_pools: { data: [{ id: LTC_BTC.id }, { id: BTC_WBTC.id }] } },
      }],
      included: [LTC_BTC, BTC_WBTC],
    })) as typeof fetch;
  try {
    const map = await fetchListedMarket("solana", [BTC]);
    const m = map.get(BTC.toLowerCase());
    assert.ok(m, "priced");
    assert.equal(m!.poolAddress, "BtcWbtc");
    assert.equal(m!.chg["24h"], 85.53, "never LTC's +4.2%");
    assert.equal(m!.vol["24h"], 631000);
    assert.equal(m!.txns["24h"].buys, 4666);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("the chart's pool (topPoolAddress) is the token's own, not the stranger's deeper one", async () => {
  _gtReset();
  const { topPoolAddress } = await import("./gtPool.ts");
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => Response.json({ data: [LTC_BTC, BTC_WBTC] })) as typeof fetch;
  try {
    assert.equal(await topPoolAddress("solana", BTC), "BtcWbtc");
    // with none of its own, the deepest is still a market FOR it
    globalThis.fetch = (async () => Response.json({ data: [LTC_BTC] })) as typeof fetch;
    assert.equal(await topPoolAddress("solana", BTC), "LtcBtc");
  } finally {
    globalThis.fetch = realFetch;
  }
});
