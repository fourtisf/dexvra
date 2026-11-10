// "harusnya tokenya btc not ltc" — the deepest pair was a STRANGER's.
//
// C5xph2yL6gMdxmuLGxJBkGpmuDFfyi5fqkBNhvL6pump is Big Titty Coin ($BTC) on
// Solana, paired with WBTC ($486K). Somebody also opened an LTC/BTC pool —
// Little Titty Coin with OUR token as its QUOTE — and that pool was deeper
// ($1.1M). DexScreener's token endpoint returns both, every reader took the
// deepest pair and read `baseToken`/`priceUsd`/`marketCap`/`info` off it, and
// the listing went out to 12,338 subscribers as $LTC with LTC's logo, price,
// cap and liquidity.
//
// These drive the REAL readers over that answer, shaped as DexScreener sends it.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const tp = require("../../shared/dexscreener/tokenPairs");

const BTC = "C5xph2yL6gMdxmuLGxJBkGpmuDFfyi5fqkBNhvL6pump";
const LTC = "LTCxj8Rk3sQm1yN9vW2pD7cE4hB6tA5uJ1kZ8xY2pump";
const WBTC = "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh";

// Both pairs, as DexScreener answers `latest/dex/tokens/<BTC>` — the stranger's
// pool FIRST and DEEPER, which is the whole defect.
const LTC_BTC = {
  chainId: "solana", dexId: "pumpswap", pairAddress: "LtcBtcPool111111111111111111111111111111111",
  baseToken: { address: LTC, name: "Little Titty Coin", symbol: "LTC" },
  quoteToken: { address: BTC, name: "Big Titty Coin", symbol: "BTC" },
  priceNative: "0.1964", priceUsd: "0.003212",
  liquidity: { usd: 1_100_000, base: 170_000_000, quote: 33_600_000 },
  volume: { h24: 90_000 }, txns: { h24: { buys: 900, sells: 300 } }, priceChange: { h24: 4.2 },
  fdv: 3_100_000, marketCap: 3_100_000, pairCreatedAt: 1_800_000_000_000,
  info: { imageUrl: "https://cdn.example/ltc.png", socials: [{ type: "twitter", url: "https://x.com/ltc" }] },
};
const BTC_WBTC = {
  chainId: "solana", dexId: "pumpswap", pairAddress: "3M9sVgL4u6atkaiEXf3XhQqnFmb6iJvZK3MemCQaen1w",
  baseToken: { address: BTC, name: "Big Titty Coin", symbol: "BTC" },
  quoteToken: { address: WBTC, name: "Wrapped BTC", symbol: "WBTC" },
  priceNative: "0.0000002035", priceUsd: "0.01635",
  liquidity: { usd: 486_000, base: 14_688_924, quote: 3.06 },
  volume: { h24: 631_000 }, txns: { h24: { buys: 4666, sells: 8785 } }, priceChange: { h24: 85.53 },
  fdv: 16_200_000, marketCap: 16_200_000, pairCreatedAt: 1_795_000_000_000,
  info: { imageUrl: "https://cdn.example/btc.png", socials: [{ type: "twitter", url: "https://x.com/btc" }] },
};
const PAYLOAD = { schemaVersion: "1.0.0", pairs: [LTC_BTC, BTC_WBTC] };

function stubFetch(payload) {
  const real = global.fetch;
  global.fetch = async (u) => {
    const url = String(u);
    if (url.includes("api.dexscreener.com/latest/dex/tokens/")) {
      return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("{}", { status: 404 });
  };
  return () => { global.fetch = real; };
}

test("the shared rule: a token's own pairs are its BASE-side pairs, deepest first", () => {
  assert.equal(tp.sideOf(LTC_BTC, BTC), "quote");
  assert.equal(tp.sideOf(BTC_WBTC, BTC), "base");
  assert.deepEqual(tp.ownPairs(PAYLOAD.pairs, BTC).map((p) => p.pairAddress), [BTC_WBTC.pairAddress]);
  assert.equal(tp.bestOwnPair(PAYLOAD.pairs, LTC).pairAddress, LTC_BTC.pairAddress);
  assert.equal(tp.ownPairs(PAYLOAD.pairs, BTC, { chainId: "bsc" }).length, 0, "the chain filter applies");
  // base58 is case-SENSITIVE: a lowercased mint is a different account
  assert.equal(tp.ownPairs(PAYLOAD.pairs, BTC.toLowerCase()).length, 0);
  // EVM hex is not
  const evm = { ...BTC_WBTC, baseToken: { address: "0xAbCdEf0000000000000000000000000000000001" } };
  assert.equal(tp.ownPairs([evm], "0xabcdef0000000000000000000000000000000001").length, 1);
});

test("a token seen ONLY as a quote keeps its name and USD price — nothing of the other token's", () => {
  const q = tp.quoteView([LTC_BTC], BTC, { chainId: "solana" });
  assert.equal(q.symbol, "BTC");
  assert.equal(q.name, "Big Titty Coin");
  // LTC's USD price over LTC's price in BTC = BTC's USD price
  assert.ok(Math.abs(q.priceUsd - 0.003212 / 0.1964) < 1e-12);
  assert.equal(q.mcap, undefined, "the pair's cap is the other token's — never carried");
  assert.equal(tp.quoteView([{ ...LTC_BTC, priceNative: null }], BTC).priceUsd, null, "no priceNative, no price");
});

test("listing autofill (dexscreener.fetchTokenInfoX) describes $BTC, not the deeper $LTC pool", async () => {
  const ds = require("../src/dexscreener");
  const undo = stubFetch(PAYLOAD);
  try {
    const r = await ds.fetchTokenInfoX("solana", BTC);
    assert.equal(r.ok, true);
    assert.equal(r.info.symbol, "BTC");
    assert.equal(r.info.name, "Big Titty Coin");
    assert.equal(r.info.priceUsd, 0.01635);
    assert.equal(r.info.mcap, 16_200_000);
    assert.equal(r.info.liq, 486_000);
    assert.equal(r.info.logoUrl, "https://cdn.example/btc.png");
    assert.equal(r.info.twitter, "https://x.com/btc");
    assert.equal(r.info.poolAddress, BTC_WBTC.pairAddress);
  } finally { undo(); }
});

test("listing autofill: a token only ever seen as a quote gets its identity and nothing else", async () => {
  const ds = require("../src/dexscreener");
  const undo = stubFetch({ pairs: [LTC_BTC] });
  try {
    const r = await ds.fetchTokenInfoX("solana", BTC);
    assert.equal(r.info.symbol, "BTC");
    assert.equal(r.info.mcap, null);
    assert.equal(r.info.logoUrl, null, "LTC's artwork must never become BTC's");
    assert.equal(r.info.twitter, null);
    assert.equal(r.info.liq, 0, "every size gate stays shut on somebody else's pool");
  } finally { undo(); }
});

test("the post's market read (marketdata.fetchMarket) prices $BTC, not $LTC", async () => {
  const md = require("../src/marketdata");
  const undo = stubFetch(PAYLOAD);
  try {
    const m = await md.fetchMarket("solana", BTC, { cheap: true });
    assert.ok(m, "the read answered");
    assert.equal(m.priceUsd, 0.01635);
    assert.equal(m.mcap, 16_200_000);
    assert.equal(m.liq, 486_000);
    assert.notEqual(m.symbol, "LTC");
    assert.notEqual(m.logoUrl, "https://cdn.example/ltc.png");
  } finally { undo(); }
});

test("the buy bot watches the token's OWN pool, and a quote-side pool is read the right way round", async () => {
  const gp = require("../src/group/gtPairs");
  const undo = stubFetch(PAYLOAD);
  try {
    const r = await gp.dsResolveAcross(BTC, ["solana"]);
    assert.equal(r.chain, "solana");
    assert.equal(r.pool.poolAddress, BTC_WBTC.pairAddress, "never the stranger's deeper pool");
    assert.equal(r.pool.symbol, "BTC");
    assert.equal(r.pool.priceUsd, 0.01635);
  } finally { undo(); }
  const q = gp.dsPoolOf(LTC_BTC, BTC);
  assert.equal(q.symbol, "BTC");
  assert.ok(Math.abs(q.priceUsd - 0.003212 / 0.1964) < 1e-12, "our price, not the base's");
  assert.equal(q.mcap, null, "the base's cap is not ours");
  assert.equal(q.buys24h, 300, "a buy of LTC there is somebody SELLING BTC");
  assert.equal(q.sells24h, 900);
});

// ⚠️ TEN readers had this defect, each with its own copy of "deepest pair wins".
// A reader added later forgets in exactly the same way, so the rule is counted:
// every file that asks `latest/dex/tokens/` must go through the one owner, or
// say here why it does not need to.
test("every DexScreener token reader goes through shared/dexscreener/tokenPairs", () => {
  const ROOT = path.join(__dirname, "..", "..");
  const EXEMPT = {
    // candidates ARE each pair's base token — keyed by baseToken.address, so a
    // pair only ever describes the token it is filed under
    "bot/src/services/dsBigCoins.js": "candidates are keyed by each pair's own base",
    // already filters on the base side with the pair rule's own sameAddress
    "bot/scripts/ca-check.js": "filters dsPair.sameAddress(baseToken, row.address)",
  };
  const files = [];
  const walk = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name === "test" || e.name.startsWith(".")) continue;
      const abs = path.join(dir, e.name), r = `${rel}/${e.name}`;
      if (e.isDirectory()) walk(abs, r);
      else if (e.name.endsWith(".js") && !e.name.endsWith(".test.js")) files.push([r.slice(1), abs]);
    }
  };
  walk(path.join(ROOT, "bot", "src"), "/bot/src");
  walk(path.join(ROOT, "bot", "scripts"), "/bot/scripts");
  walk(path.join(ROOT, "tradebot"), "/tradebot");
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const readers = files.filter(([, abs]) => /latest\/dex\/tokens\//.test(strip(fs.readFileSync(abs, "utf8"))));
  assert.ok(readers.length >= 8, `the scan found only ${readers.length} reader(s) — it is not reading the tree`);
  const bad = readers
    .filter(([rel]) => !EXEMPT[rel])
    .filter(([, abs]) => !/require\(["'][./]+shared\/dexscreener\/tokenPairs["']\)/.test(fs.readFileSync(abs, "utf8")))
    .map(([rel]) => rel);
  assert.deepEqual(bad, [], "these ask DexScreener for a token's pairs without the base-side rule");
  for (const rel of Object.keys(EXEMPT)) assert.ok(readers.some(([r]) => r === rel), `${rel} is exempt but no longer a reader — drop it`);
});
