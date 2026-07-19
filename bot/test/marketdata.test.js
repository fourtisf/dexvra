// Market data: the num(null) regression (Number(null)===0 defeated the
// market_cap_usd ?? fdv_usd fallback → mcap "TBA" on every new token) and the
// DexScreener fallback with MANDATORY chain filtering (never price a token off
// a same-address pair on another chain).
const test = require("node:test");
const assert = require("node:assert");
const market = require("../src/marketdata");

const gtBody = (attrs) =>
  JSON.stringify({ data: { attributes: attrs, relationships: {} }, included: [] });
const dsBody = (pairs) => JSON.stringify({ pairs });

function stubFetch(router) {
  const orig = global.fetch;
  global.fetch = async (url) => {
    const body = router(String(url));
    if (body === null) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => JSON.parse(body) };
  };
  return () => (global.fetch = orig);
}

test("GT market_cap_usd:null falls back to fdv_usd (num(null) must be null, not 0)", async () => {
  const restore = stubFetch((url) => {
    if (url.includes("geckoterminal"))
      return gtBody({ price_usd: "0.0042", market_cap_usd: null, fdv_usd: "123456" });
    return null;
  });
  try {
    const m = await market.fetchMarket("solana", "So1anaAddr111");
    assert.ok(m);
    assert.strictEqual(m.priceUsd, 0.0042);
    assert.strictEqual(m.mcap, 123456); // was 0 → "TBA" before the fix
  } finally {
    restore();
  }
});

test("GT unindexed token → DexScreener fallback, chain-filtered", async () => {
  const restore = stubFetch((url) => {
    if (url.includes("geckoterminal")) return null; // GT hasn't indexed it yet
    if (url.includes("dexscreener"))
      return dsBody([
        // same-address deploy on ANOTHER chain with a huge (wrong) price — must be ignored
        { chainId: "bsc", priceUsd: "99", marketCap: 9e9, liquidity: { usd: 5e6 }, pairAddress: "wrong" },
        { chainId: "solana", priceUsd: "0.001", fdv: 250000, liquidity: { usd: 20000 }, pairAddress: "poolA",
          baseToken: { name: "Rise", symbol: "RISE" } },
      ]);
    return null;
  });
  try {
    const m = await market.fetchMarket("solana", "So1anaAddr111");
    assert.ok(m);
    assert.strictEqual(m.priceUsd, 0.001);
    assert.strictEqual(m.mcap, 250000); // marketCap missing → fdv
    assert.strictEqual(m.poolAddress, "poolA");
    assert.strictEqual(m.symbol, "RISE");
  } finally {
    restore();
  }
});

test("no chain-matching DexScreener pair → null (never a wrong-chain price)", async () => {
  const restore = stubFetch((url) => {
    if (url.includes("geckoterminal")) return null;
    if (url.includes("dexscreener"))
      return dsBody([{ chainId: "bsc", priceUsd: "99", marketCap: 9e9, liquidity: { usd: 5e6 } }]);
    return null;
  });
  try {
    const m = await market.fetchMarket("solana", "So1anaAddr111");
    assert.strictEqual(m, null);
  } finally {
    restore();
  }
});

test("GT price present but mcap missing → DS fills only the gap", async () => {
  const restore = stubFetch((url) => {
    if (url.includes("geckoterminal"))
      return gtBody({ price_usd: "0.5", market_cap_usd: null, fdv_usd: null });
    if (url.includes("dexscreener"))
      return dsBody([
        { chainId: "ethereum", priceUsd: "0.49", marketCap: 777777, liquidity: { usd: 1000 }, pairAddress: "p1" },
      ]);
    return null;
  });
  try {
    const m = await market.fetchMarket("ethereum", "0x" + "a".repeat(40));
    assert.ok(m);
    assert.strictEqual(m.priceUsd, 0.5); // GT price wins
    assert.strictEqual(m.mcap, 777777); // DS fills mcap
  } finally {
    restore();
  }
});
