// Uniswap V4 reader.
//
// $TLNCH on Robinhood Chain is what this is for: a live v4 pool with real
// liquidity that this bot answered with "❌ Couldn't price it" while Maestro
// showed the price. v4 has no pair contract and no per-pool contract — every
// pool is a mapping entry inside ONE PoolManager — so V2's getPair and V3's
// getPool both return nothing and there is no address to look up.
//
// The price math is the part that must not be wrong: a price out by 10^n is far
// worse than no price at all, so every conversion is checked against a hand
// worked value here.
const test = require("node:test");
const assert = require("node:assert");
const { ethers } = require("ethers");
const v4 = require("./v4");

const Q96 = 1n << 96n;
const TOKEN = "0x10472b42e3b22a5b98d0820a55cc6fd9034f4663";
const WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";

const withEnv = (vars, fn) => {
  const old = {};
  for (const k of Object.keys(vars)) { old[k] = process.env[k]; if (vars[k] == null) delete process.env[k]; else process.env[k] = vars[k]; }
  try { return fn(); } finally { for (const k of Object.keys(old)) { if (old[k] == null) delete process.env[k]; else process.env[k] = old[k]; } }
};

test("price: a 1:1 raw pool is 1 native per token at 18 decimals, either way round", () => {
  assert.strictEqual(v4.priceNativeFromSqrt(Q96, 18, true), 1);
  assert.strictEqual(v4.priceNativeFromSqrt(Q96, 18, false), 1);
});

test("price: decimals are undone, not ignored", () => {
  // 1 raw token == 1 wei, and the token has 6 decimals → one WHOLE token is
  // 1e6 wei = 1e-12 ETH. Getting this wrong is the 10^n class of error.
  assert.strictEqual(v4.priceNativeFromSqrt(Q96, 6, true), 1e-12);
});

test("price: the currency ordering is undone too", () => {
  // sqrtPriceX96 = 2 * 2^96 → P = 4 (raw currency1 per raw currency0).
  const sqrt = 2n * Q96;
  assert.strictEqual(v4.priceNativeFromSqrt(sqrt, 18, true), 4, "token is currency0 → 4 native per token");
  assert.strictEqual(v4.priceNativeFromSqrt(sqrt, 18, false), 0.25, "token is currency1 → the price inverts");
});

test("price: an uninitialised pool prices at zero, never at NaN", () => {
  assert.strictEqual(v4.priceNativeFromSqrt(0n, 18, true), 0);
});

test("currencies sort as v4 requires, and native is always currency0", () => {
  // v4 rejects a PoolKey whose currencies are not ascending, so a key built the
  // other way round is an id for a pool that cannot exist.
  const nat = v4.orderCurrencies(TOKEN, v4.NATIVE);
  assert.strictEqual(nat.currency0, v4.NATIVE, "address(0) sorts below everything");
  assert.strictEqual(nat.tokenIsZero, false);
  const w = v4.orderCurrencies(TOKEN, WETH);
  assert.ok(w.currency0 < w.currency1, "ascending");
  assert.strictEqual(w.tokenIsZero, w.currency0 === TOKEN);
});

test("poolId is keccak(abi.encode(PoolKey)) — the exact preimage v4 uses", () => {
  const id = v4.poolId(v4.NATIVE, TOKEN, 3000, 60);
  const expect = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
    ["address", "address", "uint24", "int24", "address"],
    [v4.NATIVE, TOKEN, 3000, 60, v4.NATIVE],
  ));
  assert.strictEqual(id, expect);
  // Any field change is a different pool.
  assert.notStrictEqual(v4.poolId(v4.NATIVE, TOKEN, 500, 10), id);
});

test("v4 stays OFF until a PoolManager is configured", () => {
  // Same rule as the V3 block next to it: a guessed address on a money path is
  // worse than a disabled feature, so there is no baked default.
  withEnv({ ROBINHOOD_V4_POOLMANAGER: undefined }, () => {
    assert.strictEqual(v4.cfg("robinhood"), null);
    assert.strictEqual(v4.enabled("robinhood"), false);
  });
  withEnv({ ROBINHOOD_V4_POOLMANAGER: "0x" + "ab".repeat(20) }, () => {
    const c = v4.cfg("robinhood");
    assert.ok(c);
    assert.strictEqual(c.poolsSlot, v4.DEFAULT_POOLS_SLOT);
    assert.deepStrictEqual(c.tiers, v4.DEFAULT_TIERS);
  });
});

test("a malformed PoolManager address disables v4 rather than half-enabling it", () => {
  withEnv({ ROBINHOOD_V4_POOLMANAGER: "0xnope" }, () => assert.strictEqual(v4.cfg("robinhood"), null));
  withEnv({ ROBINHOOD_V4_POOLMANAGER: ethers.ZeroAddress }, () => assert.strictEqual(v4.cfg("robinhood"), null));
});

test("fee tiers and the storage slot are overridable per chain", () => {
  // A fork is free to lay its storage out differently, and a wrong slot reads
  // zeros — indistinguishable from "no pool" unless it can be corrected.
  withEnv({ ROBINHOOD_V4_POOLMANAGER: "0x" + "ab".repeat(20), ROBINHOOD_V4_POOLS_SLOT: "9", ROBINHOOD_V4_FEE_TIERS: "400:8,3000:60" }, () => {
    const c = v4.cfg("robinhood");
    assert.strictEqual(c.poolsSlot, 9);
    assert.deepStrictEqual(c.tiers, [[400, 8], [3000, 60]]);
  });
});

test("bestPool sweeps native AND wrapped native, over every tier", async () => {
  // Native first is the point: v4 takes ETH directly as address(0), which is what
  // a v4-era launch pairs against. Checking only WETH would miss the common case.
  const asked = [];
  const deps = {
    chainOf: () => ({ key: "robinhood", weth: WETH, native: "ETH" }),
    providerFor: () => ({}),
    poolState: async (_p, _c, id) => { asked.push(id); return null; },
  };
  await withEnv({ ROBINHOOD_V4_POOLMANAGER: "0x" + "ab".repeat(20) }, async () => {
    const res = await v4.bestPool(TOKEN, "robinhood", deps);
    assert.strictEqual(res, null, "nothing found → null, not a throw");
  });
  assert.strictEqual(new Set(asked).size, v4.DEFAULT_TIERS.length * 2, "4 tiers × { native, WETH }");
});

test("the deepest pool wins when several tiers exist", async () => {
  const o = v4.orderCurrencies(TOKEN, v4.NATIVE);
  const deep = v4.poolId(o.currency0, o.currency1, 10000, 200);
  const deps = {
    chainOf: () => ({ key: "robinhood", weth: WETH }),
    providerFor: () => ({}),
    poolState: async (_p, _c, id) => ({ sqrtPriceX96: Q96, liquidity: id === deep ? 999n : 1n }),
  };
  await withEnv({ ROBINHOOD_V4_POOLMANAGER: "0x" + "ab".repeat(20) }, async () => {
    const best = await v4.bestPool(TOKEN, "robinhood", deps);
    assert.strictEqual(best.liquidity, 999n);
    assert.strictEqual(best.fee, 10000);
  });
});
