import test from "node:test";
import assert from "node:assert/strict";
import { readNativeUsd, readQuoteAssetUsd, peggedSymbols } from "./quoteUsd.ts";

// The ETH/USD reference under a Pons curve token's price used to be
// GeckoTerminal alone — the one metered source on the box — and every curve
// token read TBA whenever it was cooling down. The ladder puts the free
// sources FIRST and keeps every refusal, so the caller can say which nothing
// it got.

const never = async (): Promise<number> => {
  throw new Error("not asked");
};

test("Coinbase answers first, and the metered rungs are NOT asked", async () => {
  let ds = 0;
  let gt = 0;
  const r = await readNativeUsd({
    coinbase: async () => 4123.5,
    dexscreener: async () => { ds++; return 1; },
    geckoterminal: async () => { gt++; return 1; },
  });
  assert.equal(r.usd, 4123.5);
  assert.equal(r.source, "coinbase");
  assert.deepEqual(r.why, []);
  assert.equal(ds + gt, 0, "a free answer must not cost a metered request");
});

test("a rung that throws is passed over, and its reason travels", async () => {
  const r = await readNativeUsd({
    coinbase: async () => { throw new Error("Coinbase 503"); },
    dexscreener: async () => 3999,
    geckoterminal: never,
  });
  assert.equal(r.usd, 3999);
  assert.equal(r.source, "dexscreener");
  assert.deepEqual(r.why, ["coinbase: Coinbase 503"]);
});

test("GeckoTerminal is LAST — reached only when both free sources failed", async () => {
  const r = await readNativeUsd({
    coinbase: async () => { throw new Error("ENOTFOUND"); },
    dexscreener: async () => { throw new Error("DexScreener 403"); },
    geckoterminal: async () => 4001,
  });
  assert.equal(r.source, "geckoterminal");
  assert.deepEqual(r.why, ["coinbase: ENOTFOUND", "dexscreener: DexScreener 403"]);
});

test("⚠️ every rung failing is null WITH three named refusals — never a bare null", async () => {
  const r = await readNativeUsd({
    coinbase: async () => { throw new Error("Coinbase 503"); },
    dexscreener: async () => 0, // "answered 0" is a refusal too: 0 is not a price
    geckoterminal: async () => { throw new Error("GeckoTerminal reference price failed — rate limited"); },
  });
  assert.equal(r.usd, null);
  assert.equal(r.source, null);
  assert.equal(r.why.length, 3);
  assert.match(r.why[1], /dexscreener: answered 0/);
  assert.match(r.why[2], /rate limited/);
});

test("⚠️ a rung that HANGS is bounded, and the next rung still answers", async () => {
  // The whole ladder sits inside /api/pons, which the bot reads on a 5s clock.
  // An unbounded rung is the same TBA by a longer road.
  const r = await readNativeUsd({
    stepMs: 40,
    coinbase: () => new Promise<number>((res) => setTimeout(() => res(4000), 400)),
    dexscreener: async () => 3990,
    geckoterminal: never,
  });
  assert.equal(r.source, "dexscreener");
  assert.match(r.why[0], /coinbase: no answer inside 40ms/);
});

// ── An ERC-20 quote asset ($HAPPYCAT, "Paired USDG") ─────────────────────

test("a dollar stablecoin pair token is priced by its peg, and no market is asked", async () => {
  let asked = 0;
  const r = await readQuoteAssetUsd("robinhood", "0xcccc", "usdg", {
    dexscreener: async () => { asked++; return 1.01; },
    geckoterminal: async () => { asked++; return 1.01; },
  });
  assert.equal(r.usd, 1);
  assert.equal(r.source, "peg");
  assert.equal(asked, 0, "a peg costs no request");
});

test("a pair token that is NOT a dollar is priced off its own market, and a miss names every rung", async () => {
  const hit = await readQuoteAssetUsd("robinhood", "0xdddd", "NVDA", {
    dexscreener: async () => 182.4,
    geckoterminal: never,
  });
  assert.equal(hit.usd, 182.4);
  assert.equal(hit.source, "dexscreener");
  const miss = await readQuoteAssetUsd("robinhood", "0xdddd", "NVDA", {
    dexscreener: async () => { throw new Error("DexScreener 403"); },
    geckoterminal: async () => { throw new Error("rate limited"); },
  });
  assert.equal(miss.usd, null);
  assert.deepEqual(miss.why, ["dexscreener: DexScreener 403", "geckoterminal: rate limited"]);
});

test("PONS_USD_PEGGED replaces the set, `0` turns the rung off, blank is the shipped set", () => {
  assert.ok(peggedSymbols(undefined).has("USDG"));
  assert.ok(peggedSymbols("").has("USDC"));
  assert.deepEqual([...peggedSymbols("usdg, rusd")], ["USDG", "RUSD"]);
  assert.equal(peggedSymbols("0").size, 0);
  assert.equal(peggedSymbols("off").size, 0);
});

test("with the peg off, a stablecoin goes to the market like any other asset", async () => {
  const r = await readQuoteAssetUsd("robinhood", "0xcccc", "USDG", {
    pegged: new Set(),
    dexscreener: async () => 0.9998,
    geckoterminal: never,
  });
  assert.equal(r.source, "dexscreener");
});
