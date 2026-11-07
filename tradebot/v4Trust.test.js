// Who the v4 money path trusts, and how it picks a pool.
//
// Two exploits sat on this path. A contract that emitted forged Initialize and
// Swap logs could become a chain's PoolManager and its "router" (v4.test.js
// covers that half). And on the REAL PoolManager, a pool anyone initialised at
// their own price — with a one-tick position, so its raw `liquidity` dwarfs the
// honest pool's — won the depth ranking, and minOut was then computed from the
// attacker's own price. These tests are the second half.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "dexvra-v4trust-"));

const test = require("node:test");
const assert = require("node:assert");
const v4 = require("./v4");

const Q96 = 1n << 96n;
const TOKEN = "0x10472b42e3b22a5b98d0820a55cc6fd9034f4663";
const WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";
const CHAIN = { key: "robinhood", weth: WETH };
const ONE = 10n ** 18n;

// currency0 is native (address(0) sorts first), so sqrtPriceX96 is tokens per
// native: Q96 is 1:1, Q96/2 is a quarter of a token per native.
const pool = (sqrtPriceX96, liquidity, extra = {}) => ({
  currency0: v4.NATIVE, currency1: TOKEN, tokenIsZero: false, quote: v4.NATIVE,
  fee: 3000, tickSpacing: 60, hooks: v4.NATIVE, sqrtPriceX96, liquidity, ...extra,
});

const HONEST = pool(Q96, 10n ** 21n, { id: "honest" });
// Four times the price, a million times the "liquidity": the planted pool.
const PLANTED = pool(Q96 / 2n, 10n ** 27n, { id: "planted", fee: 100 });

test("a planted pool's raw liquidity no longer wins a BUY", () => {
  const byDepth = [PLANTED, HONEST];           // bestPool sorts by L, so this is its order
  assert.strictEqual(v4.pickForTrade(byDepth, TOKEN, CHAIN, null).id, "planted",
    "precondition: ranked by L alone, the planted pool is the answer");
  const pick = v4.pickForTrade(byDepth, TOKEN, CHAIN, { amountIn: ONE, side: "buy" });
  assert.strictEqual(pick.id, "honest", "the pool that pays the buyer more tokens wins");
});

test("…nor a SELL: the seller gets the pool that pays the most native", () => {
  // For a seller the bad pool is the one that values the token LOW — four
  // tokens per native here, against one.
  const lowball = pool(Q96 * 2n, 10n ** 27n, { id: "lowball", fee: 100 });
  const pick = v4.pickForTrade([lowball, HONEST], TOKEN, CHAIN, { amountIn: ONE, side: "sell" });
  assert.strictEqual(pick.id, "honest");
});

test("ETH and WETH pools are one class and are ranked together", () => {
  const wethPool = { ...HONEST, id: "weth", quote: WETH };
  const pick = v4.pickForTrade([PLANTED, wethPool], TOKEN, CHAIN, { amountIn: ONE, side: "buy" });
  assert.strictEqual(pick.id, "weth");
});

test("a pool in another quote currency is never ranked against the deepest one's", () => {
  // A payout in NVDA and a payout in ETH are not comparable numbers.
  const NVDA = "0x" + "77".repeat(20);
  const nvdaPool = { ...pool(Q96 * 4n, 10n ** 21n), id: "nvda", quote: NVDA };
  const pick = v4.pickForTrade([PLANTED, nvdaPool], TOKEN, CHAIN, { amountIn: ONE, side: "buy" });
  assert.strictEqual(pick.id, "planted", "same class only — the honest ETH pool would have to exist to win");
});

test("a BUY into a foreign-quoted pool keeps the deepest pool — its size is unknown until leg one", () => {
  const NVDA = "0x" + "77".repeat(20);
  const a = { ...pool(Q96, 10n ** 24n), id: "a", quote: NVDA };
  const b = { ...pool(Q96 * 4n, 10n ** 21n), id: "b", quote: NVDA };
  assert.strictEqual(v4.pickForTrade([a, b], TOKEN, CHAIN, { amountIn: ONE, side: "buy" }).id, "a");
});

// ── the divergence guard ────────────────────────────────────────────────────

const core = require("./core");

test("the v4 guard refuses a fill far worse than the indexer's price, in both directions", async () => {
  const ref = Promise.resolve(1);              // 1 native per token, per the indexer
  await assert.rejects(core._v4Guard(ref, 3, "buy", " Your ETH is safe."), (e) => {
    assert.match(e.message, /worse than the price shown/, "the wording i18n maps to err.diverged");
    assert.match(e.message, /Your ETH is safe\./, "and what the wallet is holding, when leg one already ran");
    assert.ok(e.divergence > 2.9 && e.divergence < 3.1);
    return true;
  });
  await assert.rejects(core._v4Guard(ref, 0.3, "sell"), /worse than the price shown/);
  await core._v4Guard(ref, 1.5, "buy");        // inside the 2x default
  await core._v4Guard(ref, 0.6, "sell");
});

test("a reference that cannot be read never blocks a trade", async () => {
  await core._v4Guard(Promise.resolve(0), 1000, "buy");
  await core._v4Guard(null, 1000, "buy");
  await core._v4Guard(new Promise(() => {}), 1000, "buy");   // never answers: bounded by GUARD_REF_WAIT_MS
});

// ── the wiring ──────────────────────────────────────────────────────────────

const code = (f) => fs.readFileSync(path.join(__dirname, f), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");

test("both trade paths hand bestPool the trade size, and both run the guard", () => {
  const src = code("core.js");
  const calls = src.match(/v4\.bestPool\([^;]*\)/g) || [];
  assert.ok(calls.length >= 2, "vacuity: the scan found the calls");
  const trading = calls.filter((c) => /side: '(buy|sell)'/.test(c));
  assert.strictEqual(trading.length, 2, "the buy and the sell each say how much they trade");
  assert.strictEqual((src.match(/await _v4Guard\(/g) || []).length, 2, "and each is checked before anything is approved or sent");
});
