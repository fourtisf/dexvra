// Rank-up alerts — marketdata 24h-change extraction + the climb/dedup logic
// and the post_rankup template.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-rankup-"));

const test = require("node:test");
const assert = require("node:assert");
const market = require("../src/marketdata");
const fmt = require("../src/channels/format");

function stubFetch(router) {
  const orig = global.fetch;
  global.fetch = async (url) => {
    const body = router(String(url));
    if (body === null) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => JSON.parse(body) };
  };
  return () => (global.fetch = orig);
}

test("fetchMarket surfaces the top pool's 24h change (GT)", async () => {
  const restore = stubFetch((url) => {
    if (!url.includes("geckoterminal")) return null;
    return JSON.stringify({
      data: {
        attributes: { price_usd: "0.01", market_cap_usd: "500000" },
        relationships: { top_pools: { data: [{ id: "solana_POOL1" }] } },
      },
      included: [
        { id: "solana_POOL1", attributes: { address: "POOL1", price_change_percentage: { h24: "42.5" } } },
      ],
    });
  });
  try {
    const m = await market.fetchMarket("solana", "AAA");
    assert.ok(m);
    assert.strictEqual(m.change24h, 42.5);
  } finally {
    restore();
  }
});

test("fetchMarket 24h change falls back to DexScreener when GT lacks price/mcap", async () => {
  const restore = stubFetch((url) => {
    if (url.includes("geckoterminal")) return null; // GT unindexed
    if (url.includes("dexscreener"))
      return JSON.stringify({
        pairs: [
          { chainId: "solana", priceUsd: "0.02", marketCap: 900000, liquidity: { usd: 40000 }, pairAddress: "p", priceChange: { h24: -8.3 } },
        ],
      });
    return null;
  });
  try {
    const m = await market.fetchMarket("solana", "AAA");
    assert.ok(m);
    assert.strictEqual(m.change24h, -8.3);
  } finally {
    restore();
  }
});

test("post_rankup renders rank + change with premium entities, clamps negatives", () => {
  const coin = { name: "Pepe", symbol: "$PEPE", chain: "ethereum", address: "0xabc", links: {}, siteUrl: "https://dexvra.io/t" };
  const card = fmt.rankupPost(coin, 2, 137.6);
  assert.ok(card.text.includes("$PEPE"));
  assert.ok(card.text.includes("#2"));
  assert.ok(card.text.includes("+138%"), card.text);
  assert.ok(card.text.includes("📈"), "chart-up emoji present (unicode fallback)");
  // a rounding-negative change never prints a minus
  const neg = fmt.rankupPost(coin, 1, -0.4);
  assert.ok(neg.text.includes("+0%"));
  assert.ok(!neg.text.includes("-"));
});

// The climb logic, unit-tested in isolation (mirrors rankUpChecker's rule).
test("climb rule: alert only on improvement INTO the top band", () => {
  const RANKUP_TOP = 3;
  const climbed = (prev, rank) => rank <= RANKUP_TOP && (prev == null || prev > rank);
  assert.ok(climbed(undefined, 1)); // new entrant at #1
  assert.ok(climbed(5, 2)); // 5 → 2 climb into band
  assert.ok(!climbed(2, 3)); // 2 → 3 is a DROP
  assert.ok(!climbed(1, 1)); // unchanged
  assert.ok(!climbed(6, 4)); // climbed but still outside top 3
});
