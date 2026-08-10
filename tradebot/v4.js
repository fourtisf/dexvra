'use strict';
/*
 * Uniswap V4 — READ ONLY.
 *
 * v4 has no pair contract and no per-pool contract. Every pool in a deployment
 * lives inside ONE PoolManager, in a mapping keyed by
 *
 *     poolId = keccak256(abi.encode(currency0, currency1, fee, tickSpacing, hooks))
 *
 * so there is nothing for V2's getPair or V3's getPool to return, and a v4-only
 * token is invisible to both. That is exactly what happened to $TLNCH on
 * Robinhood Chain: a live pool with real liquidity, and the bot answered
 * "couldn't price it" while Maestro showed the price, because Maestro reads the
 * PoolManager directly.
 *
 * TWO THINGS THIS DELIBERATELY DOES NOT DO:
 *
 *  1. It does not trade. Routing v4 means the Universal Router, Permit2, and
 *     encoded Actions — real-money surface that belongs in its own change with
 *     its own tests. Everything here is a `view` call.
 *  2. It does not guess the PoolManager address. Like the V3 config next to it,
 *     a wrong address on a money path is worse than a disabled feature, so v4 is
 *     off until <CHAIN>_V4_POOLMANAGER is set. scripts/v4-discover.js finds the
 *     real one from a pool's own Initialize log.
 */
const { ethers } = require('ethers');

// Uniswap's canonical fee/tickSpacing pairings. A pool may use any combination,
// but every deployment's UI creates these four, so a sweep of them finds the
// pool a normal launch made. Widen with <CHAIN>_V4_FEE_TIERS if a deployment
// uses something else: "fee:tickSpacing,fee:tickSpacing".
const DEFAULT_TIERS = [[100, 1], [500, 10], [3000, 60], [10000, 200]];

// Storage slot of PoolManager's `_pools` mapping. v4-periphery's StateView reads
// it at 6; kept as an env override because a fork is free to lay its storage out
// differently, and a wrong slot reads zeros — which is indistinguishable from
// "no pool" and would send us back to the same dead end with no clue why.
const DEFAULT_POOLS_SLOT = 6;
// Pool.State: slot0, feeGrowthGlobal0X128, feeGrowthGlobal1X128, liquidity.
const LIQUIDITY_OFFSET = 3n;

const EXTSLOAD_ABI = ['function extsload(bytes32 slot) view returns (bytes32)'];
const STATEVIEW_ABI = [
  'function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)',
  'function getLiquidity(bytes32 poolId) view returns (uint128 liquidity)',
];

const NATIVE = '0x0000000000000000000000000000000000000000';
const coder = ethers.AbiCoder.defaultAbiCoder();

const _env = (k) => (process.env[k] || '').trim();
const _isAddr = (a) => { try { return !!a && ethers.isAddress(a) && a !== ethers.ZeroAddress; } catch (_) { return false; } };

/** v4 config for a chain, or null when it isn't set up. */
function cfg(chainKey) {
  const P = String(chainKey).toUpperCase();
  const poolManager = _env(`${P}_V4_POOLMANAGER`);
  if (!_isAddr(poolManager)) return null;
  const stateView = _env(`${P}_V4_STATEVIEW`);
  // NOT Number(_env(...)) alone: an unset var is "", Number("") is 0, and 0 is
  // finite and >= 0 — so the default slot silently became 0, which reads the
  // wrong storage word and returns zeros, which is indistinguishable from
  // "no pool here". An empty string means unset, not zero.
  const slotStr = _env(`${P}_V4_POOLS_SLOT`);
  const slotRaw = slotStr === '' ? NaN : Number(slotStr);
  const tiersRaw = _env(`${P}_V4_FEE_TIERS`);
  const tiers = tiersRaw
    ? tiersRaw.split(',').map((s) => s.split(':').map(Number)).filter((t) => t.length === 2 && t.every(Number.isFinite))
    : DEFAULT_TIERS;
  return {
    poolManager,
    stateView: _isAddr(stateView) ? stateView : null,
    poolsSlot: Number.isFinite(slotRaw) && slotRaw >= 0 ? slotRaw : DEFAULT_POOLS_SLOT,
    tiers: tiers.length ? tiers : DEFAULT_TIERS,
  };
}

/** poolId for a PoolKey. currency0 MUST sort below currency1 — v4 rejects a key
 *  that doesn't, and the id would be for a pool that cannot exist. */
function poolId(currency0, currency1, fee, tickSpacing, hooks = NATIVE) {
  return ethers.keccak256(coder.encode(
    ['address', 'address', 'uint24', 'int24', 'address'],
    [currency0, currency1, fee, tickSpacing, hooks],
  ));
}

/** The two currencies of a token↔native pool, in v4's required order. */
function orderCurrencies(token, quote) {
  const a = String(token).toLowerCase();
  const b = String(quote).toLowerCase();
  return a < b ? { currency0: a, currency1: b, tokenIsZero: true } : { currency0: b, currency1: a, tokenIsZero: false };
}

/** slot0 + liquidity for a poolId. Zero sqrtPrice = the pool does not exist. */
async function poolState(provider, c, id) {
  if (c.stateView) {
    try {
      const sv = new ethers.Contract(c.stateView, STATEVIEW_ABI, provider);
      const [sqrtPriceX96] = await sv.getSlot0(id);
      if (!sqrtPriceX96 || sqrtPriceX96 === 0n) return null;
      const liquidity = await sv.getLiquidity(id).catch(() => 0n);
      return { sqrtPriceX96: BigInt(sqrtPriceX96), liquidity: BigInt(liquidity || 0n) };
    } catch (_) { return null; }
  }
  // No StateView deployed — read the PoolManager's storage directly. This is
  // what StateView itself does; it is only sugar over extsload.
  try {
    const pm = new ethers.Contract(c.poolManager, EXTSLOAD_ABI, provider);
    const base = BigInt(ethers.keccak256(coder.encode(['bytes32', 'uint256'], [id, c.poolsSlot])));
    const word = await pm.extsload(ethers.toBeHex(base, 32));
    const raw = BigInt(word);
    const sqrtPriceX96 = raw & ((1n << 160n) - 1n);   // slot0 packs sqrtPriceX96 in the low 160 bits
    if (sqrtPriceX96 === 0n) return null;
    let liquidity = 0n;
    try { liquidity = BigInt(await pm.extsload(ethers.toBeHex(base + LIQUIDITY_OFFSET, 32))); } catch (_) {}
    return { sqrtPriceX96, liquidity };
  } catch (_) { return null; }
}

const Q192 = 1n << 192n;
const NAT = 10n ** 18n;   // native decimals — every chain in the registry is 18
const WAD = 10n ** 18n;   // precision scale for the BigInt→Number handoff

/**
 * Native per ONE WHOLE token, from sqrtPriceX96.
 *
 * v4 inherits v3's convention: (sqrtPriceX96 / 2^96)^2 is the price of currency0
 * in currency1, in RAW units. Decimals and the currency ordering both have to be
 * undone or the answer is out by 10^n — a silently wrong price being far worse
 * than no price, this is done in BigInt and only converted at the end.
 */
function priceNativeFromSqrt(sqrtPriceX96, tokenDecimals, tokenIsZero) {
  const px192 = BigInt(sqrtPriceX96) * BigInt(sqrtPriceX96);
  if (px192 <= 0n) return 0;
  const tokUnit = 10n ** BigInt(tokenDecimals);
  // tokenIsZero: price(1 token in native) = P · 10^dec / 10^18
  // else:        price(1 token in native) = 10^dec / (P · 10^18)   [P inverted]
  const scaled = tokenIsZero
    ? (px192 * tokUnit * WAD) / (Q192 * NAT)
    : (tokUnit * Q192 * WAD) / (px192 * NAT);
  return Number(scaled) / Number(WAD);
}

/**
 * The deepest v4 pool for `ca` against native ETH or wrapped native.
 *
 * Native first: v4 supports ETH as a currency directly (address(0)), which is
 * what a v4-era launch actually pairs against — checking only WETH would miss
 * the common case entirely.
 */
async function bestPool(ca, chainKey, deps) {
  const c = cfg(chainKey);
  if (!c) return null;
  const chain = deps.chainOf(chainKey);
  if (!chain) return null;
  const provider = deps.providerFor(chainKey);
  // Explicit seam: the storage read is the one part that needs a live chain, so
  // tests substitute it. Patching the module export instead would not work —
  // this function calls the local binding.
  const read = deps.poolState || poolState;
  const quotes = [NATIVE];
  if (_isAddr(chain.weth)) quotes.push(String(chain.weth).toLowerCase());

  const found = [];
  await Promise.all(quotes.flatMap((quote) => {
    const { currency0, currency1, tokenIsZero } = orderCurrencies(ca, quote);
    return c.tiers.map(async ([fee, tickSpacing]) => {
      const id = poolId(currency0, currency1, fee, tickSpacing);
      const st = await read(provider, c, id).catch(() => null);
      if (st) found.push({ ...st, id, fee, tickSpacing, quote, tokenIsZero });
    });
  }));
  if (!found.length) return null;
  // Deepest by in-range liquidity. A pool that is initialised but empty prices
  // at whatever it was initialised to, which is not a market.
  found.sort((a, b) => (a.liquidity > b.liquidity ? -1 : a.liquidity < b.liquidity ? 1 : 0));
  return found[0];
}

/** { priceEth, liquidity, fee, … } for the deepest v4 pool, or null. */
async function price(ca, chainKey, decimals, deps) {
  const p = await bestPool(ca, chainKey, deps);
  if (!p) return null;
  const priceEth = priceNativeFromSqrt(p.sqrtPriceX96, decimals, p.tokenIsZero);
  if (!(priceEth > 0)) return null;
  return { priceEth, fee: p.fee, tickSpacing: p.tickSpacing, quote: p.quote, liquidity: p.liquidity, poolId: p.id };
}

const enabled = (chainKey) => !!cfg(chainKey);

module.exports = {
  cfg, enabled, poolId, orderCurrencies, poolState, bestPool, price, priceNativeFromSqrt,
  NATIVE, DEFAULT_TIERS, DEFAULT_POOLS_SLOT,
};
