// "CEK LP BUKAN HANYA MC DAN VOLUME" — the free listing judged a token's SIZE
// (cap, both-sides liquidity, volume) and never how much of that size a seller
// could be paid from. A honeypot ($NASDUCK, Robinhood) was listed at a $27M
// cap and later pumped "+1900%" on a pool GMGN measured at $507 against $684M.
//
// These tests drive the DexScreener parser and the real gates with payloads in
// DexScreener's own shape.
const test = require("node:test");
const assert = require("node:assert");

const ds = require("../src/dexscreener");
const al = require("../src/services/autoLister");
const q = require("../src/services/listingQuality");

const HOUR = 3_600_000;
const now = 1_800_000_000_000;
const CA = "0x78fC7E13BCCab8a7aedc5b8465C3442d6D7D9d64";

/** One DexScreener pair: our token is the base, WETH the quote at $3,000. */
const pair = (over = {}) => ({
  chainId: "robinhood",
  dexId: "uniswap",
  pairAddress: "0x1111111111111111111111111111111111111111",
  baseToken: { address: CA, name: "Nasduck", symbol: "NASDUCK" },
  quoteToken: { address: "0x4200000000000000000000000000000000000006", symbol: "WETH" },
  priceUsd: "0.0272",
  priceNative: String(0.0272 / 3000),
  liquidity: { usd: 3_000_000, base: 100_000_000, quote: 500 }, // $1.5M of WETH: balanced
  volume: { h24: 900_000 },
  txns: { h24: { buys: 1200, sells: 950 } },
  priceChange: { h1: 3, h6: 9, h24: 20 },
  marketCap: 27_000_000,
  pairCreatedAt: now - 72 * HOUR,
  info: { imageUrl: "https://dd.dexscreener.com/x.png" },
  ...over,
});

function stubFetch(t, body) {
  const real = global.fetch;
  global.fetch = async () => new Response(JSON.stringify(body), { status: 200 });
  t.after(() => (global.fetch = real));
}

// ── the parser ───────────────────────────────────────────────────────────────

test("the parser carries the pool's OTHER side in USD, its 24h buys/sells and the pool", async (t) => {
  stubFetch(t, { pairs: [pair()] });
  const { info } = await ds.fetchTokenInfoX("robinhood", CA);
  assert.ok(Math.abs(info.liqQuoteUsd - 1_500_000) < 1, `500 WETH at $3,000 is $1.5M, got ${info.liqQuoteUsd}`);
  assert.strictEqual(info.quoteSymbol, "WETH");
  assert.deepStrictEqual(info.txns24, { buys: 1200, sells: 950 });
  assert.strictEqual(info.poolAddress, "0x1111111111111111111111111111111111111111");
});

test("our token as the QUOTE of the pair: the other side is the base, at priceUsd", () => {
  const p = pair({
    baseToken: { address: "0xweth", symbol: "WETH" },
    quoteToken: { address: CA, symbol: "NASDUCK" },
    priceUsd: "3000",
    liquidity: { usd: 100, base: 2, quote: 5 },
  });
  assert.strictEqual(ds.otherSideUsd(p, CA), 6000);
});

test("an unpublished side or count is NULL — never a measured 0", () => {
  // Number(null) is 0: reading a missing `quote` as "the pool holds no WETH"
  // would refuse every token DexScreener simply did not break down.
  assert.strictEqual(ds.otherSideUsd(pair({ liquidity: { usd: 5e6 } }), CA), null);
  assert.strictEqual(ds.otherSideUsd(pair({ liquidity: { usd: 5e6, quote: null } }), CA), null);
  assert.strictEqual(ds.otherSideUsd(pair({ priceNative: undefined }), CA), null);
  assert.strictEqual(ds.otherSideUsd(pair({ baseToken: { address: "0xsomeoneelse" } }), CA), null, "not our pair");
  assert.strictEqual(ds.txnsOf(pair({ txns: { h24: { buys: 5 } } }), "h24"), null);
  assert.strictEqual(ds.txnsOf(pair({ txns: undefined }), "h24"), null);
});

test("base58 addresses are matched exactly; only 0x folds case", () => {
  const sol = pair({ baseToken: { address: "So1Mint" }, liquidity: { usd: 10, quote: 1 } });
  assert.ok(ds.otherSideUsd(sol, "So1Mint") > 0);
  assert.strictEqual(ds.otherSideUsd(sol, "so1mint"), null, "a lowercased mint is a different account");
  assert.ok(ds.otherSideUsd(pair(), CA.toLowerCase()) > 0, "0x addresses fold");
});

// ── the gate: the honeypot's three shapes are refused ────────────────────────

const LOGO = "https://dd.dexscreener.com/x.png";
const rec = (over) => ({ symbol: "NASDUCK", name: "Nasduck", logoUrl: LOGO, mcap: 27e6, liq: 3e6, liqQuoteUsd: 1.5e6, vol24: 9e5, txns24: { buys: 1200, sells: 950 }, ...over });

test("control: a balanced, two-way market at the same cap is NOT refused", () => {
  assert.strictEqual(q.qualityRefusal("robinhood", CA, rec()), null);
});

test("a $27M cap on $30k of liquidity is refused — the cap is not backed by a pool", () => {
  const why = q.qualityRefusal("robinhood", CA, rec({ liq: 30_000, liqQuoteUsd: null }));
  assert.match(String(why), /^liquidity too thin for its cap/);
});

test("deep 'liquidity' that is the token itself is refused: one-sided pool", () => {
  // $3M reported, $12k of it WETH — a seller can be paid from $12k.
  const why = q.qualityRefusal("robinhood", CA, rec({ liqQuoteUsd: 12_000, quoteSymbol: "WETH" }));
  assert.match(String(why), /^one-sided pool/);
  assert.match(String(why), /WETH/);
});

test("all buys and no sells is refused: the honeypot signature", () => {
  const why = q.qualityRefusal("robinhood", CA, rec({ txns24: { buys: 400, sells: 3 } }));
  assert.match(String(why), /^one-way market/);
});

test("one-way needs a real sample: a quiet token with 5 buys and 0 sells is not judged", () => {
  assert.strictEqual(q.oneWay(rec({ txns24: { buys: 5, sells: 0 } })), null);
  assert.strictEqual(q.oneWay(rec({ txns24: { buys: 100, sells: 30 } })), null, "a strong day is not a honeypot");
  assert.ok(q.oneWay(rec({ txns24: { buys: 100, sells: 9 } })));
});

// ── …and real tokens still list ──────────────────────────────────────────────

test("a pump.fun-size token with a normal pool passes", () => {
  assert.strictEqual(
    q.qualityRefusal("solana", "So1Mint", rec({ mcap: 1.2e6, liq: 180_000, liqQuoteUsd: 90_000, txns24: { buys: 900, sells: 700 } })),
    null,
  );
});

test("a genuine MAJOR with a pool thin against its cap but DEEP in dollars passes", () => {
  // SHIB's Ethereum pool is a fraction of a percent of its cap, and it is the
  // real SHIB — the board filler lists it. The deep-pool escape is what
  // separates it from a honeypot: millions of real money against $507.
  const shib = { symbol: "SHIB", name: "Shiba Inu", logoUrl: LOGO, mcap: 8e9, liq: 8e6, liqQuoteUsd: 4e6, vol24: 2e7 };
  assert.strictEqual(q.qualityRefusal("ethereum", "0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE", shib), null);
});

test("the floor scales with the cap: 2% to $10M, 0.5% from $1B", () => {
  assert.strictEqual(q.minLiqShare(1e6), 0.02);
  assert.strictEqual(q.minLiqShare(1e7), 0.02);
  assert.ok(q.minLiqShare(1e8) < 0.02 && q.minLiqShare(1e8) > 0.005);
  assert.strictEqual(q.minLiqShare(1e9), 0.005);
  assert.strictEqual(q.minLiqShare(5e10), 0.005);
});

test("a source that published nothing about the pool makes no LP claim", () => {
  const bare = { symbol: "NEW", name: "New", logoUrl: LOGO, mcap: 2e6 };
  assert.strictEqual(q.liquidityRefusal(bare), null);
  assert.strictEqual(q.realLiquidity(bare), null);
});

test("realLiquidity is min(reported, 2 × the other side)", () => {
  assert.strictEqual(q.realLiquidity({ liq: 3e6, liqQuoteUsd: 1.5e6 }), 3e6);
  assert.strictEqual(q.realLiquidity({ liq: 3e6, liqQuoteUsd: 10_000 }), 20_000);
  assert.strictEqual(q.realLiquidity({ liq: 3e6 }), 3e6, "no other side published → the reported figure");
});

// ── the scan's size gate reads REAL liquidity ────────────────────────────────

test("the minLiq floor is measured on real liquidity, and says both figures", () => {
  const cfg = { ...al.DEFAULTS };
  const info = { ...rec({ mcap: 1.3e6, liq: 400_000, liqQuoteUsd: 10_000 }), pairCreatedAt: now - 72 * HOUR };
  const why = al.rejectReason(info, cfg, 1_000_000, now, "robinhood", CA);
  assert.match(String(why), /^thin liquidity \(\$20,000 real, of \$400,000 reported\)/);
});

test("every new reason is ONE bucket on the scan line and cools for 12h, not 1h", () => {
  const reasons = [
    q.qualityRefusal("robinhood", CA, rec({ liq: 30_000, liqQuoteUsd: null })),
    q.qualityRefusal("robinhood", "0xother", rec({ liq: 31_000, liqQuoteUsd: null, mcap: 29e6 })),
  ];
  // reasonBucket is the scan's tally key — figures in parentheses are stripped.
  const bucket = (w) => {
    let t = String(w);
    for (let i = 0; i < 4 && /\([^()]*\)/.test(t); i++) t = t.replace(/\s*\([^()]*\)/g, "");
    return t.trim();
  };
  assert.strictEqual(bucket(reasons[0]), bucket(reasons[1]));
  const until = al.coolUntil(reasons[0], rec(), { ...al.DEFAULTS }, 1e6, now);
  assert.strictEqual(until, now + 12 * HOUR, "a scam signal is not re-priced every hour");
});

test("the door: createFromInfo refuses the honeypot BEFORE the site is called", async () => {
  const api = require("../src/api/dexvra");
  const real = api.createListing;
  let called = false;
  api.createListing = async () => ((called = true), { id: "x" });
  try {
    const made = await al.createFromInfo("robinhood", CA, rec({ txns24: { buys: 400, sells: 3 } }));
    assert.strictEqual(made, null);
    assert.strictEqual(called, false, "nothing reaches the site");
  } finally {
    api.createListing = real;
  }
});
