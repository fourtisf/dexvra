// The $BTC/$LTC defect, on the OTHER indexer.
//
// GeckoTerminal's `tokens/{address}/pools` and `?include=top_pools` return a
// token's pools on EITHER side, exactly as DexScreener's token endpoint does.
// Every reader here took the deepest one — so a stranger's deeper pool with OUR
// token as its QUOTE supplied the change, the volume, the counts (the wrong way
// round) and, where the pool's base price was read, the PRICE. These drive the
// real readers over that answer. See shared/geckoterminal/poolSide.js.
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
process.env.BOT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "dexvra-gtside-"));

const test = require("node:test");
const assert = require("node:assert/strict");
const gs = require("../../shared/geckoterminal/poolSide");

const BTC = "C5xph2yL6gMdxmuLGxJBkGpmuDFfyi5fqkBNhvL6pump";
const LTC = "LTCxj8Rk3sQm1yN9vW2pD7cE4hB6tA5uJ1kZ8xY2pump";
const WBTC = "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh";
const rel = (net, base, quote) => ({ base_token: { data: { id: `${net}_${base}` } }, quote_token: { data: { id: `${net}_${quote}` } } });

// The stranger's pool: deeper, listed FIRST — the whole defect.
const LTC_BTC = {
  id: "solana_LtcBtcPool", type: "pool",
  attributes: {
    address: "LtcBtcPool", name: "LTC / BTC", reserve_in_usd: "1100000",
    base_token_price_usd: "0.003212", quote_token_price_usd: "0.01635",
    market_cap_usd: "3100000", price_change_percentage: { h24: "4.2" },
    volume_usd: { h24: "90000" }, transactions: { h24: { buys: 900, sells: 300 } },
  },
  relationships: rel("solana", LTC, BTC),
};
const BTC_WBTC = {
  id: "solana_BtcWbtcPool", type: "pool",
  attributes: {
    address: "BtcWbtcPool", name: "BTC / WBTC", reserve_in_usd: "486000",
    base_token_price_usd: "0.01635", quote_token_price_usd: "80000",
    market_cap_usd: "16200000", price_change_percentage: { h24: "85.53" },
    volume_usd: { h24: "631000" }, transactions: { h24: { buys: 4666, sells: 8785 } },
  },
  relationships: rel("solana", BTC, WBTC),
};

function stubFetch(router) {
  const orig = global.fetch;
  global.fetch = async (url) => {
    const body = router(String(url));
    if (body === null) return { ok: false, status: 404, headers: new Map(), json: async () => ({}), text: async () => "" };
    return { ok: true, status: 200, headers: new Map(), json: async () => JSON.parse(body), text: async () => body };
  };
  return () => (global.fetch = orig);
}

test("the shared rule: a positively quote-side pool never describes the token", () => {
  assert.equal(gs.gtSideOf(LTC_BTC, BTC), "quote");
  assert.equal(gs.gtSideOf(BTC_WBTC, BTC), "base");
  assert.deepEqual(gs.ownGtPools([LTC_BTC, BTC_WBTC], BTC).map((p) => p.attributes.address), ["BtcWbtcPool"]);
  // base58 is case-SENSITIVE
  assert.equal(gs.gtSideOf(BTC_WBTC, BTC.toLowerCase()), null);
  // a pool GT sent no relationships for keeps its old treatment, AFTER a base-side one
  const bare = { attributes: { address: "Bare", reserve_in_usd: "9000000" } };
  assert.deepEqual(gs.ownGtPools([bare, BTC_WBTC], BTC).map((p) => p.attributes.address), ["BtcWbtcPool", "Bare"]);
  assert.equal(gs.bestGtPool([LTC_BTC], BTC), null, "only a stranger's pool: nothing of its own");
  const q = gs.quoteView([LTC_BTC], BTC);
  assert.equal(q.priceUsd, 0.01635, "the QUOTE token's price, never the base's");
  assert.equal(q.symbol, "BTC");
  assert.equal(q.buys24h, 300, "a buy of LTC there is somebody SELLING BTC");
  assert.equal(q.sells24h, 900);
});

test("the market read (fetchGT) takes change, depth and pool from the token's OWN pool", async () => {
  const market = require("../src/marketdata");
  const restore = stubFetch((url) =>
    url.includes("geckoterminal")
      ? JSON.stringify({
          data: {
            attributes: { name: "Big Titty Coin", symbol: "BTC", price_usd: "0.01635", market_cap_usd: "16200000" },
            relationships: { top_pools: { data: [{ id: LTC_BTC.id }, { id: BTC_WBTC.id }] } },
          },
          included: [LTC_BTC, BTC_WBTC],
        })
      : null,
  );
  try {
    const m = await market.fetchMarket("solana", BTC);
    assert.equal(m.symbol, "BTC");
    assert.equal(m.liq, 486000, "never the stranger's $1.1M");
    assert.equal(m.change24h, 85.53, "never LTC's +4.2%");
    assert.equal(m.poolAddress, "BtcWbtcPool");
  } finally {
    restore();
  }
  // and a quote-side sibling may not lend its change either
  const deep = { ...BTC_WBTC, attributes: { ...BTC_WBTC.attributes, price_change_percentage: { h24: null } } };
  const j = { data: { relationships: { top_pools: { data: [{ id: LTC_BTC.id }, { id: deep.id }] } } }, included: [LTC_BTC, deep] };
  assert.equal(market._changeFromPools(j, deep, BTC), null, "LTC's move is not BTC's");
});

test("the buy bot's GT pool (fetchGtPool) is the token's own — price, cap, counts the right way round", async () => {
  const gp = require("../src/group/gtPairs");
  gp._reset();
  const A = "0x1111111111111111111111111111111111111111", S = "0x2222222222222222222222222222222222222222", W = "0x3333333333333333333333333333333333333333";
  const evm = (p, base, quote) => ({ ...p, id: `plasma_${p.attributes.address}`, relationships: rel("plasma", base, quote) });
  const restore = stubFetch((url) =>
    url.includes("geckoterminal") ? JSON.stringify({ data: [evm(LTC_BTC, S, A), evm(BTC_WBTC, A, W)] }) : null,
  );
  try {
    const p = await gp.fetchPool("plasma", A);
    assert.equal(p.poolAddress, "BtcWbtcPool");
    assert.equal(p.symbol, "BTC");
    assert.equal(p.priceUsd, 0.01635);
    assert.equal(p.mcap, 16200000);
    assert.equal(p.buys24h, 4666);
  } finally {
    restore();
  }
  gp._reset();
  const restore2 = stubFetch((url) => (url.includes("geckoterminal") ? JSON.stringify({ data: [evm(LTC_BTC, S, A)] }) : null));
  try {
    const p = await gp.fetchPool("plasma", A);
    assert.equal(p.symbol, "BTC");
    assert.equal(p.priceUsd, 0.01635, "the quote's own price — not LTC's $0.003212");
    assert.equal(p.mcap, null, "LTC's cap is not ours");
    assert.equal(p.change24h, null);
    assert.equal(p.buys24h, 300);
    assert.equal(p.sells24h, 900);
  } finally {
    restore2();
  }
});

// ⚠️ The GT twin of the DexScreener guard: five readers had this defect, each
// with its own "deepest pool wins". A file that asks GT for a TOKEN's pools must
// go through the one owner, or say here why it does not need to.
test("every GeckoTerminal token-pool reader goes through shared/geckoterminal/poolSide", () => {
  const ROOT = path.join(__dirname, "..", "..");
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
  // a TOKEN's pools: `tokens/<addr>/pools`, or the token endpoint with include=top_pools
  const READS = /tokens\/\$\{[^}]+\}\/pools|include=top_pools/;
  const readers = files.filter(([, abs]) => READS.test(strip(fs.readFileSync(abs, "utf8"))));
  assert.ok(readers.length >= 4, `the scan found only ${readers.length} reader(s) — it is not reading the tree`);
  const bad = readers
    .filter(([, abs]) => !/require\(["'][./]+shared\/geckoterminal\/poolSide["']\)/.test(fs.readFileSync(abs, "utf8")))
    .map(([rel]) => rel);
  assert.deepEqual(bad, [], "these read a token's GT pools without the side rule");
});
