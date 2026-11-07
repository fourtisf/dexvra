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
    const who = u.includes("/api/pons")
      ? "chain"
      : u.includes("dexscreener") ? "ds" : u.includes("geckoterminal") ? "gt" : u.includes("pump.fun") ? "pump" : "pad";
    asked.push(who);
    const body = router(who, u);
    if (body === "hang") return new Promise(() => {});
    if (body === "down") {
      const e = new TypeError("fetch failed");
      e.cause = { code: "ENOTFOUND" };
      throw e;
    }
    if (body && typeof body.then === "function") return body; // a response that arrives late
    if (body === null || body === undefined) return { ok: false, status: 404, text: async () => "", json: async () => ({}) };
    if (body && body.__status) return { ok: false, status: body.__status, text: async () => "", json: async () => ({}) };
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

// ── on a curve, WHICH liquidity ─────────────────────────────────────────────
//
// "liat ini": `post:check` on the box after the fix above read `$POKECITY mcap
// 2243 · liq 2646` — liquidity LARGER than the market cap — and `$APECHECK
// mcap 3462 · liq 2734`, beside pump.fun's own page at ~10%. Those are
// both-sides figures (the curve's unsold tokens at spot, plus its SOL), and the
// first cut of the fix took them ahead of the curve's own reserve.

/** pump.fun's curve: virtual SOL × virtual tokens is fixed at launch. */
const K = 30 * 1073000000; // SOL × tokens

test("⚠️ INVARIANT: a curve's published liquidity is its SOL — never more than ~27% of its market cap, anywhere on the curve", () => {
  // A both-sides figure breaks this immediately (it starts at ~100% of the cap),
  // so this is the guard against the definition sliding back to the AMM one.
  let worst = 0;
  for (let vsol = 30.5; vsol <= 115; vsol += 0.5) {
    const vtok = K / vsol;
    const mcapSol = (vsol / vtok) * 1e9;
    const usd = mcapSol * 150;
    const rec = P.pumpfunParse({ key: "pumpfun", label: "pump.fun" }, "solana", {
      mint: APE, complete: false, usd_market_cap: usd, market_cap: mcapSol,
      real_sol_reserves: Math.round((vsol - 30) * 1e9),
      real_token_reserves: Math.max(0, Math.round((793100000 - (1073000000 - vtok)) * 1e6)),
    }, Date.now());
    assert.ok(rec.curveLiqUsd > 0, `no figure at ${vsol} SOL`);
    worst = Math.max(worst, rec.curveLiqUsd / usd);
  }
  assert.ok(worst <= 0.27, `the curve's liquidity reached ${(worst * 100).toFixed(1)}% of its market cap`);
});

test("⚠️ the REPORTED numbers: an aggregator's both-sides figure (liq > mcap) loses to the curve's own reserve", async () => {
  // Jupiter publishes `liquidity` for curve tokens on the AMM definition.
  const jup = [{ id: APE, name: "APECHECK", symbol: "APECHECK", usdPrice: 0.000004717, mcap: 4717, liquidity: 5560, launchpad: "pump.fun", bondingCurve: 15 }];
  const { restore } = stubFetch((who, u) => (who === "ds" ? DS_CURVE : who === "pump" ? PUMP : /jup\.ag/.test(u) ? jup : null));
  try {
    const { live } = await fulfil._readPostMarket("solana", APE, "test", { tries: 1 });
    assert.ok(Math.abs(live.liq - LIQ) < 0.01, `printed ${live.liq} — the aggregator's both-sides figure, not pump.fun's "Total liquidity" (${LIQ})`);
    assert.strictEqual(live.liqFrom, "curve", "post:check must be able to say which liquidity it is");
  } finally {
    restore();
  }
});

test("⚠️ …and an INDEXER's figure on a curve token is replaced the same way — it is the same both-sides quantity", async () => {
  const withDepth = { pairs: [{ ...DS_CURVE.pairs[0], liquidity: { usd: 4100 }, info: { imageUrl: "https://cdn.dexscreener.com/ape.png" } }] };
  const { asked, restore } = stubFetch((who) => (who === "ds" ? withDepth : who === "pump" ? PUMP : null));
  try {
    const m = await market.fetchMarket("solana", APE, { cheap: true, need: ["priceUsd", "mcap", "liq"], budgetMs: 2000 });
    assert.ok(asked.includes("pump"), "the pad must be asked: an indexer's liquidity does not say whether the token is still a curve");
    assert.ok(Math.abs(m.liq - LIQ) < 0.01, `kept ${m.liq} — 87% of the cap, a number no curve can hold`);
    assert.strictEqual(m.liqFrom, "curve");
  } finally {
    restore();
  }
});

test("…while a GRADUATED token keeps its pool's depth — that IS exit liquidity", async () => {
  const withDepth = { pairs: [{ ...DS_CURVE.pairs[0], dexId: "pumpswap", liquidity: { usd: 41000 }, info: { imageUrl: "https://cdn.dexscreener.com/ape.png" } }] };
  const graduated = { ...PUMP, complete: true, pump_swap_pool: "Poo1Address11111111111111111111111111111111", real_sol_reserves: 0 };
  const { restore } = stubFetch((who) => (who === "ds" ? withDepth : who === "pump" ? graduated : null));
  try {
    const m = await market.fetchMarket("solana", APE, { cheap: true, need: ["priceUsd", "mcap", "liq"], budgetMs: 2000 });
    assert.strictEqual(m.liq, 41000);
    assert.strictEqual(m.liqFrom, undefined);
  } finally {
    restore();
  }
});

test("…and where no VERIFIED pad publishes a reserve (Robinhood), a figure in hand costs no pad request", async () => {
  const ponsChain = require("../src/ponsChain");
  ponsChain._reset();
  const T = "0xfCd4CdEabe055315b1036A189eA54ca627Df390a";
  const ds = { pairs: [{ chainId: "robinhood", priceUsd: "0.000004", marketCap: 4494, liquidity: { usd: 3100 }, pairAddress: "0xpair", info: { imageUrl: "https://cdn.dexscreener.com/w.png" }, baseToken: { address: T, name: "W", symbol: "W" } }] };
  const { asked, restore } = stubFetch((who) => (who === "ds" ? ds : who === "chain" ? null : null));
  try {
    const m = await market.fetchMarket("robinhood", T, { cheap: true, need: ["priceUsd", "mcap", "liq"], budgetMs: 2000 });
    assert.strictEqual(m.liq, 3100);
    assert.ok(!asked.includes("pad"), `a guessed pad host was asked for a figure already in hand: ${asked.join(", ")}`);
  } finally {
    restore();
    ponsChain._reset();
  }
});

test("curveLiqOf: the reserve counts only while the pad says the token is ON its curve", () => {
  assert.strictEqual(market._curveLiqOf({ onCurve: true, curveLiq: 360.9 }), 360.9);
  assert.strictEqual(market._curveLiqOf({ onCurve: null, curveLiq: 360.9 }), null);
  assert.strictEqual(market._curveLiqOf({ onCurve: false, curveLiq: 360.9 }), null);
  // …and inside one pad record the reserve outranks the record's own `liq`.
  assert.strictEqual(market._mergeCurve({ priceUsd: 1, mcap: 2 }, { onCurve: true, liq: 5560, curveLiq: 360.9 }).liq, 360.9);
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

// ── "bagaimana agar masalah ini tidak terjadi lgi" ──────────────────────────
//
// The fix above makes the dash rarer. It cannot make it impossible: pump.fun
// can rename a field, its host can refuse this box, the post can run out of
// time. And the watch that exists for exactly this — `postFigures` — and the
// check an operator runs before a buyer pays — `post:check` — both EXEMPTED a
// curve's missing liquidity, `post:check` with a green note reading "a bonding
// curve has no pool depth". So the operator was the detector, by screenshot.
//
// The exemption now covers only the state it was written for: every source
// ANSWERED and none publishes a reserve. A hole we could not ASK for, or a
// reserve we could not PRICE, pages — and those are the tests below.

const figures = require("../src/marketFigures");
const postFigures = require("../src/postFigures");
const { verdict } = require("../scripts/post-check.js");

const PAD = { info: null, ok: true, why: "", failed: [] };

test("padLiqWhy: every source answered with no reserve is HONEST — no reason, no retry", () => {
  assert.deepStrictEqual(market._padLiqWhy(PAD, true), { why: null, retry: false }, "no pad knows the token");
  const noReserve = { ...PAD, info: { onCurve: true, launchpad: "bonk.fun", liq: 0, curveLiq: null, raised: null } };
  assert.deepStrictEqual(market._padLiqWhy(noReserve, true), { why: null, retry: false }, "a pad that publishes no reserve");
});

test("⚠️ padLiqWhy: a reserve the pad REPORTED and nothing priced is pump.fun changing its shape — ours, and NOT retried", () => {
  const drift = { ...PAD, info: { launchpad: "pump.fun", liq: 0, curveLiq: null, raised: 3.49, nativeSym: "SOL" } };
  const r = market._padLiqWhy(drift, true);
  assert.match(String(r.why), /reported the curve's reserve \(3\.49 SOL\).*response shape has changed/);
  assert.strictEqual(r.retry, false, "a renamed field answers the same on the next read");
});

test("padLiqWhy: a pad we could not ASK is ours — but only where a VERIFIED pad covers the chain", () => {
  const late = { info: null, ok: false, why: "the launchpads did not answer within 900ms", failed: [], late: true };
  assert.deepStrictEqual(market._padLiqWhy(late, true), { why: late.why, retry: true });
  assert.deepStrictEqual(market._padLiqWhy(late, false), { why: null, retry: false }, "Robinhood's pads are all guesses — a slow guess is not a page");
  const down = { info: null, ok: false, why: "pump.fun: can't reach frontend-api-v3.pump.fun", failed: [] };
  assert.match(String(market._padLiqWhy(down, true).why), /could not be asked — pump\.fun: can't reach/);
  assert.strictEqual(market._padLiqWhy(down, false).why, null);
  const verifiedFailed = { ...PAD, failed: ["pump.fun: HTTP 503"] };
  const r = market._padLiqWhy(verifiedFailed, true);
  assert.match(String(r.why), /pump\.fun: HTTP 503/, "another pad answering must not hide the one that has the reserve");
  assert.strictEqual(r.retry, true);
});

test("chainLiqWhy: the Pons contract refused or unread is ours; an answer is not", () => {
  assert.ok(market._chainLiqWhy(null).why);
  assert.match(String(market._chainLiqWhy({ ok: false, why: "site answered 503" }).why), /503/);
  assert.match(String(market._chainLiqWhy({ ok: true, info: { readWhy: "rpc 429" } }).why), /rpc 429/);
  assert.strictEqual(market._chainLiqWhy({ ok: true, info: { priceUsd: 1 } }).why, null);
});

test("marketFigures: ONE owner of 'this liquidity hole is ours' — and only a flaky one is re-read", () => {
  const base = { priceUsd: 1, mcap: 2, liq: null };
  assert.strictEqual(figures.liqHoleIsOurs(base), false, "every source answered — honest");
  assert.strictEqual(figures.liqHoleIsOurs({ ...base, poolAddress: "pool" }), true, "a pool we could not read");
  assert.strictEqual(figures.liqHoleIsOurs({ ...base, poolAddress: "curve", onCurve: true }), false, "an indexer's 'pair' for a curve is the curve");
  assert.strictEqual(figures.needsAnotherRead({ ...base, poolAddress: "curve", onCurve: true }), false);
  assert.strictEqual(figures.liqHoleIsOurs({ ...base, liqWhy: "x" }), true, "a reserve we could not ask for or price");
  assert.strictEqual(figures.liqHoleIsOurs({ ...base, liq: 5, liqWhy: "x" }), false, "not a hole");
  assert.strictEqual(figures.needsAnotherRead({ ...base, liqWhy: "x", liqRetry: true }), true);
  assert.strictEqual(figures.needsAnotherRead({ ...base, liqWhy: "x", liqRetry: false }), false, "a renamed field is not worth the retry window");
  const merged = figures.mergeFigures({ ...base, liqWhy: "timed out", liqRetry: true }, { liq: 360.9 });
  assert.strictEqual(merged.liq, 360.9);
  assert.strictEqual(merged.liqWhy, undefined, "a stale reason beside a real figure is two cells disagreeing");
});

test("⚠️ the post's WATCH pages on a curve's liquidity we could not get — and stays silent on an honest one", () => {
  const live = { priceUsd: 0.000004717, mcap: 4717, liq: null };
  const args = { kind: "listing", chain: "solana", address: APE, sym: "$APECHECK", name: "APECHECK", live, why: null };
  assert.strictEqual(postFigures.figureAlert(args), null, "every source answered and none publishes depth — the post is honest");
  const why = "pump.fun reported the curve's reserve (3.49 SOL) but nothing to price it in dollars — its response shape has changed";
  const html = postFigures.figureAlert({ ...args, live: { ...live, liqWhy: why } });
  assert.ok(html, "the watch was silent over the $APECHECK dash — the operator was the detector");
  assert.match(html, /without liquidity/);
  assert.match(html, /response shape has changed/, "the alert must say WHY, not 'an indexer publishes none'");
  assert.ok(html.includes(`npm run launchpads:check -- ${APE}`), "the remedy carries the REAL mint, never a blank");
});

test("⚠️ post:check is RED over the same hole, and green-with-a-true-sentence over the honest one", () => {
  const A = (live) => ({ live, why: null, holes: ["liquidity"], lostArt: false });
  assert.strictEqual(verdict(A({ priceUsd: 1, mcap: 2, liq: null })), "ok");
  assert.strictEqual(verdict(A({ priceUsd: 1, mcap: 2, liq: null, liqWhy: "the launchpads did not answer within 900ms" })), "fault");
  const src = fss.readFileSync(path.join(__dirname, "..", "scripts", "post-check.js"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
  assert.ok(!/a bonding curve has no pool depth/.test(src), "the check reassures the operator with a sentence that is no longer true");
});

// ── driven end to end, through the read the post makes ──────────────────────

test("⚠️ DRIVEN: pump.fun renames a field → the post still goes out, the dash is not retried, and the watch PAGES", async () => {
  // The reserve is still there; both ways to price it are gone.
  const { market_cap, virtual_sol_reserves, virtual_token_reserves, total_supply, ...renamed } = PUMP;
  const { asked, restore } = stubFetch((who) => (who === "ds" ? DS_CURVE : who === "pump" ? renamed : null));
  try {
    const { live } = await fulfil._readPostMarket("solana", APE, "test", { tries: 3, pauseMs: 0 });
    assert.strictEqual(live.priceUsd, 0.000004717, "the price still publishes");
    assert.strictEqual(live.liq ?? null, null);
    assert.match(String(live.liqWhy), /response shape has changed/);
    assert.strictEqual(asked.filter((w) => w === "ds").length, 1, "a deterministic hole bought the whole retry window");
    assert.ok(postFigures.isKeyHole("liquidity", live), "…and the watch treats it as a fault");
  } finally {
    restore();
  }
});

test("⚠️ DRIVEN: pump.fun unreachable → the hole is named as ours and re-read once more", async () => {
  const { asked, restore } = stubFetch((who) => {
    if (who === "ds") return DS_CURVE;
    if (who === "pump") return "down";
    return null;
  });
  try {
    const { live } = await fulfil._readPostMarket("solana", APE, "test", { tries: 2, pauseMs: 0 });
    assert.strictEqual(live.mcap, 4717);
    assert.match(String(live.liqWhy), /could not be asked/, `got ${live.liqWhy}`);
    assert.strictEqual(asked.filter((w) => w === "ds").length, 2, "a hole we could not ASK for is worth the second read");
  } finally {
    restore();
  }
});

test("DRIVEN: the pad says it is a curve and publishes no reserve → honest: no reason, no retry, no page", async () => {
  // A pad that answers and simply does not report a reserve (bonk.fun-shaped):
  // the post's dash is the truth about what anybody publishes.
  const { real_sol_reserves, market_cap, virtual_sol_reserves, virtual_token_reserves, ...noReserve } = PUMP;
  const { asked, restore } = stubFetch((who) => (who === "ds" ? DS_CURVE : who === "pump" ? noReserve : null));
  try {
    const { live } = await fulfil._readPostMarket("solana", APE, "test", { tries: 3, pauseMs: 0 });
    assert.strictEqual(live.liqWhy, undefined);
    assert.strictEqual(live.onCurve, true, "the pad's word on the phase travels with the record");
    // ⚠️ DexScreener names the curve's address as a pair. Read as a POOL, that
    // bought three reads and a page over a number nobody publishes.
    assert.strictEqual(asked.filter((w) => w === "ds").length, 1, "the curve's 'pair' was read as a pool we failed to read");
    assert.ok(!postFigures.isKeyHole("liquidity", live));
  } finally {
    restore();
  }
});

test("…while a pair NO pad knows keeps the pool rule it always had ($SFX): re-read, and paged", async () => {
  const { asked, restore } = stubFetch((who) => (who === "ds" ? DS_CURVE : null));
  try {
    const { live } = await fulfil._readPostMarket("solana", APE, "test", { tries: 2, pauseMs: 0 });
    assert.strictEqual(live.onCurve, undefined, "nobody said it is a curve");
    assert.strictEqual(asked.filter((w) => w === "ds").length, 2);
    assert.ok(postFigures.isKeyHole("liquidity", live));
  } finally {
    restore();
  }
});

test("⚠️ an UNVERIFIED pad that is down is not a page — only a pad whose shape we have measured counts", async () => {
  // moonshot's host is retired and four.meme refuses datacenter IPs: on the box
  // those fail on every read. Counting them would page every Solana listing
  // with an honest dash, for ever — the permanently-red check nobody reads.
  const { real_sol_reserves, market_cap, virtual_sol_reserves, virtual_token_reserves, ...noReserve } = PUMP;
  const { asked, restore } = stubFetch((who) => (who === "ds" ? DS_CURVE : who === "pump" ? noReserve : "down"));
  try {
    const { live } = await fulfil._readPostMarket("solana", APE, "test", { tries: 3, pauseMs: 0 });
    assert.ok(asked.includes("pad"), "the unverified pads must actually have been asked and failed");
    assert.strictEqual(live.liqWhy, undefined, `an unverified pad's failure paged: ${live.liqWhy}`);
    assert.ok(!postFigures.isKeyHole("liquidity", live));
  } finally {
    restore();
  }
});

test("⚠️ DRIVEN (Robinhood): a Pons curve whose CONTRACT read failed names that read — the one source that cannot be unreachable", async () => {
  // Robinhood's pads are both guesses, so their silence pages nobody; the
  // contract is the authority there, and a 503 from the reader is ours.
  const ponsChain = require("../src/ponsChain");
  ponsChain._reset();
  const WROTE = "0xfCd4CdEabe055315b1036A189eA54ca627Df390a";
  const ds = { pairs: [{ chainId: "robinhood", priceUsd: "0.000004", marketCap: 4494, pairAddress: "0xcurve", baseToken: { address: WROTE, name: "Wallet Route", symbol: "WROTE" } }] };
  const { restore } = stubFetch((who) => (who === "ds" ? ds : who === "chain" ? { __status: 503 } : null));
  try {
    const m = await market.fetchMarket("robinhood", WROTE, { cheap: true, need: ["priceUsd", "mcap", "liq"], budgetMs: 2000 });
    assert.strictEqual(m.priceUsd, 0.000004);
    assert.match(String(m.liqWhy), /the curve read failed/, `got ${m.liqWhy}`);
    assert.ok(postFigures.isKeyHole("liquidity", m));
  } finally {
    restore();
    ponsChain._reset();
  }
});

test("post:check SAYS which liquidity it printed — a curve's reserve is not a pool's depth", () => {
  const { report } = require("../scripts/post-check.js");
  const run = (live) => {
    const lines = [];
    const orig = console.log;
    console.log = (m) => lines.push(String(m));
    try {
      report({ chain: "solana", address: APE, sym: "$APECHECK", name: "APECHECK", logoUrl: null },
        { live, holes: [], why: null, logoUrl: null, art: null });
    } finally {
      console.log = orig;
    }
    return lines.join("\n");
  };
  assert.match(run({ priceUsd: 1e-6, mcap: 3610, liq: 360.9, liqFrom: "curve" }), /liq 360\.9 \(the curve's SOL reserve/);
  assert.doesNotMatch(run({ priceUsd: 1e-6, mcap: 3610, liq: 9100 }), /curve's SOL reserve/, "a pool's depth labelled as a curve reserve");
});

// ── "liat ini mengapa seperti ini" — the override's code ran on the box, and
// `$APECHECK` still printed liq 3421 (98% of its cap) with nothing saying why ─

test("the SOL price is still derived when the answer omits BOTH `market_cap` and `total_supply`", () => {
  // Every pump.fun mint is 1B tokens at 6dp — a protocol constant, like the
  // curve's 793.1M — so the virtual reserves alone are enough.
  const { market_cap, total_supply, ...lean } = PUMP;
  const rec = P.pumpfunParse({ key: "pumpfun", label: "pump.fun" }, "solana", lean, Date.now());
  assert.ok(rec.curveLiqUsd > 0, "a leaner pump.fun answer lost the curve's liquidity");
});

test("withCurveMiss: says WHY the reserve did not replace the figure — and only the unpriced reserve is a fault", () => {
  const out = { priceUsd: 1, mcap: 3477, liq: 3421 };
  const late = market._withCurveMiss(out, { info: null, ok: false, why: "the launchpads did not answer within 900ms", failed: [], late: true });
  assert.match(late.curveWhy, /did not answer/);
  assert.strictEqual(late.curveDrift, undefined, "a slow pad on one read is not an incident");
  const noReserve = market._withCurveMiss(out, { info: { onCurve: true, raised: null }, ok: true, failed: [] });
  assert.match(noReserve.curveWhy, /none published its reserve/);
  assert.strictEqual(noReserve.curveDrift, undefined);
  const drift = market._withCurveMiss(out, { info: { onCurve: true, raised: 3.49, nativeSym: "SOL", launchpad: "pump.fun" }, ok: true, failed: [] });
  assert.strictEqual(drift.curveDrift, true);
  assert.match(drift.curveWhy, /reported the curve's reserve \(3\.49 SOL\)/);
  const graduated = market._withCurveMiss(out, { info: { onCurve: false, raised: null }, ok: true, failed: [] });
  assert.deepStrictEqual(graduated, out, "a graduated token's pool depth needs no explaining");
});

test("⚠️ DRIVEN: a reserve we HAD and could not price is a WRONG FIGURE — post:check is red and the watch pages", async () => {
  const { market_cap, virtual_sol_reserves, virtual_token_reserves, total_supply, ...renamed } = PUMP;
  const withDepth = { pairs: [{ ...DS_CURVE.pairs[0], liquidity: { usd: 3421.16 }, info: { imageUrl: "https://cdn.dexscreener.com/ape.png" } }] };
  const { restore } = stubFetch((who) => (who === "ds" ? withDepth : who === "pump" ? renamed : null));
  try {
    const { live } = await fulfil._readPostMarket("solana", APE, "test", { tries: 1 });
    assert.strictEqual(live.liq, 3421.16, "the indexer's figure is what was left to print");
    assert.strictEqual(live.curveDrift, true);
    assert.strictEqual(verdict({ live, why: null, holes: [], lostArt: false }), "fault", "post:check was green over a number ~10× pump.fun's");
    const html = postFigures.figureAlert({ kind: "listing", chain: "solana", address: APE, sym: "$APECHECK", live, why: null });
    assert.ok(html, "the watch was silent over the wrong figure");
    assert.match(html, /wrong liquidity figure/);
    assert.ok(html.includes(`npm run launchpads:check -- ${APE}`));
  } finally {
    restore();
  }
});

test("post:check prints why the curve's reserve was not used — 'pump.fun did not answer' is not 'it publishes none'", () => {
  const { report } = require("../scripts/post-check.js");
  const lines = [];
  const orig = console.log;
  console.log = (m) => lines.push(String(m));
  try {
    report({ chain: "solana", address: APE, sym: "$APECHECK", name: "APECHECK", logoUrl: null },
      { live: { priceUsd: 1e-6, mcap: 3477, liq: 3421, curveWhy: "the launchpads did not answer — the launchpads did not answer within 900ms" }, holes: [], why: null, logoUrl: null, art: null });
  } finally {
    console.log = orig;
  }
  assert.match(lines.join("\n"), /curve reserve not used — the launchpads did not answer/);
});
