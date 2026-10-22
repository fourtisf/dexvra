// "MASA DEXVRA TIDAK DETECT LP NYA INI TOKEN DEPLOY BY PUMPFUN" — $APECHECK,
// a pump.fun token 15% along its bonding curve, went out as a paid listing
// reading `💧 Liquidity: —` while pump.fun's own page, in the same minute,
// read "Pool information — Paired with SOL — Total liquidity $360.91 (3.49 SOL)".
//
// Two holes, and either alone would have printed the dash:
//
//   1. pump.fun's answer carries the curve's SOL reserve (`real_sol_reserves`)
//      and the registry parsed it into "Raised 3.49 / 85 SOL" and never into a
//      dollar figure anything could print as liquidity.
//   2. DexScreener indexes pump.fun curves as ordinary pairs and publishes their
//      price and cap but no depth, so the post's market read left by a door
//      with both of the figures the launchpad leg is gated on — and the pad,
//      the one source that HAD the reserve, was never asked.
//
// ⚠️ POSITIVE TESTS. A source wired to nothing refuses beautifully: a suite
// that only drove the refusals would pass on the unwired code.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-pumpliq-"));
// A short post budget, so the "a hanging pad cannot cost the price" test runs in
// two seconds instead of eight. Read at require time — set before anything
// loads the constants.
process.env.MARKET_BUDGET_MS = "2000";

const test = require("node:test");
const assert = require("node:assert");
const P = require("../../shared/launchpads/pads");
const lpRegistry = require("../../shared/launchpads");
const launchpads = require("../src/launchpads");
const market = require("../src/marketdata");
const fulfil = require("../src/fulfillment");

// The operator's own token, off the screenshot — a made-up mint is refused by
// the registry before it makes any request, which reads exactly like a pad leg
// that was never wired.
const APE = "FMqh25isHFLt6bFACBKwSZ66xkUpbpCi4Gdiik1Gpump";

/** What pump.fun answers for $APECHECK at 15% — the reported state. */
const PUMP = {
  mint: APE,
  name: "APECHECK",
  symbol: "APECHECK",
  image_uri: "https://ipfs.io/ipfs/bafyapecheck",
  complete: false,
  usd_market_cap: 3610,
  market_cap: 34.91, // SOL — pump.fun publishes the cap in both units
  real_sol_reserves: 3490000000, // 3.49 SOL
  real_token_reserves: 674135000000000,
  virtual_sol_reserves: 33490000000,
  virtual_token_reserves: 961185000000000,
  total_supply: 1000000000000000,
};
const SOL_USD = 3610 / 34.91;
const LIQ = Math.round(3.49 * SOL_USD * 100) / 100; // ≈ $360.90 — pump.fun's own "Total liquidity"

/** DexScreener's pump.fun curve pair: price and cap, and NO liquidity. */
const DS_CURVE = {
  pairs: [
    {
      chainId: "solana",
      dexId: "pumpfun",
      pairAddress: "4kPZdZzbt1FzY7vZ3EHaeZ8DQGa4mgnBUMm2C8ygpump",
      priceUsd: "0.000004717",
      marketCap: 4717,
      fdv: 4717,
      volume: { h24: 512 },
      priceChange: { h24: 12.5 },
      baseToken: { address: APE, name: "APECHECK", symbol: "APECHECK" },
    },
  ],
};

/**
 * Classify every request by WHO is asked. `router(who)` returns a body, `null`
 * for a 404, or `"hang"` for a host that never answers.
 */
function stubFetch(router) {
  const orig = global.fetch;
  const asked = [];
  global.fetch = async (url) => {
    const u = String(url);
    const who = u.includes("dexscreener") ? "ds" : u.includes("geckoterminal") ? "gt" : u.includes("pump.fun") ? "pump" : "pad";
    asked.push(who);
    const body = router(who, u);
    if (body === "hang") return new Promise(() => {});
    if (body && typeof body.then === "function") return body; // a response that arrives late
    if (body === null || body === undefined) return { ok: false, status: 404, text: async () => "", json: async () => ({}) };
    return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body };
  };
  return { asked, restore: () => (global.fetch = orig) };
}

// The registry caches a pad's answer per token and benches a pad after three
// transport failures — both persist across tests in one process. Stated, never
// inherited: a cached or benched pad reads exactly like one never asked.
test.beforeEach(() => lpRegistry.reload());

// ── 1. the registry turns the reserve into a figure ─────────────────────────

test("pump.fun's curve reserve becomes its liquidity — the number pump.fun's own page prints", () => {
  const rec = P.pumpfunParse({ key: "pumpfun", label: "pump.fun" }, "solana", PUMP, Date.now());
  assert.strictEqual(rec.raisedNative, 3.49, "the reserve is still the 'Raised' fact");
  assert.ok(Math.abs(rec.curveLiqUsd - LIQ) < 0.01, `expected ≈ $${LIQ}, got ${rec.curveLiqUsd}`);
  assert.ok(Math.abs(rec.curveLiqUsd - 360.91) < 1, "pump.fun printed $360.91 for 3.49 SOL");
  assert.strictEqual(rec.liqUsd, null, "pool depth stays unknown — a curve reserve is not `liqUsd`");
});

test("…and with no SOL-denominated cap, the SOL price is DERIVED the way pump.fun derives it", () => {
  const { market_cap, ...noSolCap } = PUMP;
  const rec = P.pumpfunParse({ key: "pumpfun", label: "pump.fun" }, "solana", noSolCap, Date.now());
  // virtual reserves → price per token in SOL, times the supply → the cap in SOL
  const inSol = (33490000000 / 1e9) * (1000000000000000 / 961185000000000);
  const want = Math.round(3.49 * (3610 / inSol) * 100) / 100;
  assert.ok(rec.curveLiqUsd > 0, "a response without `market_cap` lost the figure");
  assert.ok(Math.abs(rec.curveLiqUsd - want) < 0.01, `expected ${want}, got ${rec.curveLiqUsd}`);
});

test("⚠️ a ratio that says both caps are in ONE unit is not a SOL price", () => {
  // `market_cap` renamed into dollars (or the dollars copied into it): the ratio
  // is ~1, and multiplying the reserve by it would print 3.49 SOL as $3.49.
  const rec = P.pumpfunParse({ key: "pumpfun", label: "pump.fun" }, "solana", { ...PUMP, market_cap: 3610 }, Date.now());
  assert.strictEqual(rec.curveLiqUsd, null);
  assert.strictEqual(P._solUsdOf({ usd_market_cap: 3610, market_cap: 3610 }), null);
  assert.ok(Math.abs(P._solUsdOf(PUMP) - SOL_USD) < 1e-9);
});

test("no dollar figure in the answer → no liquidity, never a guess (the on-chain curve read)", () => {
  // solanaMeta hands this parser the curve ACCOUNT, which carries reserves and
  // no dollars at all. "Unknown" is the only honest answer there.
  const { usd_market_cap, ...noUsd } = PUMP;
  const rec = P.pumpfunParse({ key: "pumpfun", label: "pump.fun" }, "solana", noUsd, Date.now());
  assert.strictEqual(rec.raisedNative, 3.49);
  assert.strictEqual(rec.curveLiqUsd, null);
});

test("⚠️ a GRADUATED token has no curve liquidity — its reserve moved into a pool the indexers measure", () => {
  const rec = P.pumpfunParse({ key: "pumpfun", label: "pump.fun" }, "solana", { ...PUMP, complete: true }, Date.now());
  assert.strictEqual(rec.graduated, true);
  assert.strictEqual(rec.curveLiqUsd, null);
});

test("⚠️ the merge drops a curve figure when another pad proves the token MIGRATED", () => {
  const pump = P.pumpfunParse({ key: "pumpfun", label: "pump.fun" }, "solana", PUMP, Date.now());
  assert.ok(pump.curveLiqUsd > 0);
  const migrated = { ...P.blank({ key: "jupiter", label: "Jupiter" }, "solana", APE), graduated: true, onCurve: false, migratedPool: "Poo1Address11111111111111111111111111111111", progressPct: 100, progressSource: "graduated" };
  const both = lpRegistry._test.merge([migrated, pump]);
  assert.strictEqual(both.graduated, true);
  assert.strictEqual(both.curveLiqUsd, null, "a curve reserve beside a migration pool is two answers to one question");
  // …and on its own, the curve's figure travels through the merge.
  assert.ok(lpRegistry._test.merge([pump]).curveLiqUsd > 0, "the merge dropped the field");
});

// ── 2. the bot's shim carries it, under its own name ────────────────────────

test("the shim carries the reserve as `curveLiq` — and the auto-lister's `liq` gate still reads NO pool depth", async () => {
  const { restore } = stubFetch((who) => (who === "pump" ? PUMP : null));
  try {
    const info = await launchpads.fetchTokenInfo("solana", APE);
    assert.ok(info, "pump.fun's answer must come back");
    assert.ok(Math.abs(info.curveLiq - LIQ) < 0.01, `curveLiq: ${info.curveLiq}`);
    assert.strictEqual(info.liq, 0, "`liq` is what `minLiq` reads — a $360 curve reserve must not pass a pool-depth floor");
  } finally {
    restore();
  }
});

// ── 3. the paid post reads it ───────────────────────────────────────────────

test("⚠️ the reported state: DexScreener prices the curve with no depth, and the POST still prints pump.fun's liquidity", async () => {
  const { asked, restore } = stubFetch((who) => (who === "ds" ? DS_CURVE : who === "pump" ? PUMP : null));
  try {
    const { live } = await fulfil._readPostMarket("solana", APE, "test", { tries: 3, pauseMs: 0 });
    assert.ok(live, "the post must get a market");
    assert.strictEqual(live.priceUsd, 0.000004717, "DexScreener's price is an ANSWER and stays");
    assert.strictEqual(live.mcap, 4717, "…and so is its cap");
    assert.ok(Math.abs(live.liq - LIQ) < 0.01, `the post printed "💧 Liquidity: —" — got ${live.liq}; asked ${asked.join(", ")}`);
    assert.ok(asked.includes("pump"), "pump.fun — the one source with the reserve — was never asked");
    // One pad answer fills BOTH holes the curve token left: DexScreener had no
    // artwork for it either.
    assert.match(String(live.logoUrl), /bafyapecheck/, "the same pump.fun answer carries the logo");
    assert.strictEqual(asked.filter((w) => w === "pump").length, 1, "one pump.fun request for both holes");
    // ⚠️ AND NOT RETRIED. DexScreener names the curve's address as a pool, so a
    // liquidity hole used to buy the whole retry window from two indexers that
    // do not publish the number.
    assert.strictEqual(asked.filter((w) => w === "ds").length, 1, "the post re-read the market for a hole the first read could fill");
  } finally {
    restore();
  }
});

test("…while a BACKGROUND caller grows no pump.fun round trip for a figure it does not render", async () => {
  const { asked, restore } = stubFetch((who) => (who === "ds" ? DS_CURVE : who === "pump" ? PUMP : null));
  try {
    const m = await market.fetchMarket("solana", APE, { cheap: true, need: ["priceUsd", "mcap", "liq"] }); // no budgetMs
    assert.strictEqual(m.priceUsd, 0.000004717);
    assert.strictEqual(m.liq, null);
    assert.ok(!asked.includes("pump") && !asked.includes("pad"), `nine pipelines just grew a launchpad request each: ${asked.join(", ")}`);
  } finally {
    restore();
  }
});

test("…and an indexer's own depth is an ANSWER: the curve never replaces it, and the pad is not asked for it", async () => {
  // With its logo too: an artwork hole asks the pad on its own (logoFromCurve),
  // and this test is about whether the LIQUIDITY does.
  const withDepth = { pairs: [{ ...DS_CURVE.pairs[0], liquidity: { usd: 9100 }, info: { imageUrl: "https://cdn.dexscreener.com/ape.png" } }] };
  const { asked, restore } = stubFetch((who) => (who === "ds" ? withDepth : who === "pump" ? PUMP : null));
  try {
    const m = await market.fetchMarket("solana", APE, { cheap: true, need: ["priceUsd", "mcap", "liq"], budgetMs: 2000 });
    assert.strictEqual(m.liq, 9100);
    assert.ok(!asked.includes("pump"), "a pad request was spent on a figure the indexer had answered");
  } finally {
    restore();
  }
});

test("⚠️ a HANGING pad cannot cost the post the price and the cap DexScreener already answered", async () => {
  const { MARKET_BUDGET_MS } = require("../src/config/constants");
  assert.strictEqual(MARKET_BUDGET_MS, 2000, "the test budget did not take — this would measure the production clock");
  // GT never answers (the shared queue), every pad host hangs. The read is
  // bounded at the SAME budget the hole-fill measures against, so a pad wait
  // that runs to the budget edge loses the race to that bound — and the caller
  // discards the ENTIRE record, a price and a cap answered at t≈0, for a
  // liquidity figure.
  const { asked, restore } = stubFetch((who) => {
    if (who === "ds") return DS_CURVE;
    if (who === "gt") {
      // Unref'd: nothing awaits it once the bound fires, and a reffed timer
      // would hold this file's event loop open after the test has passed.
      return new Promise((r) => {
        const t = setTimeout(() => r({ ok: false, status: 504, json: async () => ({}) }), 30_000);
        if (typeof t.unref === "function") t.unref();
      });
    }
    return "hang";
  });
  try {
    const t0 = Date.now();
    const { live } = await fulfil._readPostMarket("solana", APE, "test", { tries: 1 });
    const elapsed = Date.now() - t0;
    assert.ok(live, `the whole market record was thrown away for a liquidity figure (took ${elapsed}ms)`);
    assert.strictEqual(live.priceUsd, 0.000004717);
    assert.strictEqual(live.mcap, 4717);
    assert.ok(elapsed < MARKET_BUDGET_MS, `the read must finish inside the post's budget, took ${elapsed}ms`);
    assert.ok(asked.includes("pump"), "the pad was still asked — only the WAIT is bounded");
  } finally {
    restore();
  }
});
