'use strict';
/*
 * Uniswap V4.
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
 * Reading and swapping are configured SEPARATELY, because they fail
 * differently. Pricing needs only the PoolManager; swapping needs the Universal
 * Router (and Permit2 to sell). A chain may have the first without the second,
 * and then the card prices the token and says it cannot fill a swap — which is
 * the honest state, not a broken one.
 *
 * NOTHING HERE GUESSES AN ADDRESS. Like the V3 config next to it, a wrong
 * address on a money path is worse than a disabled feature, so both halves stay
 * off until their env is set. scripts/v4-discover.js finds the PoolManager from
 * a pool's own Initialize log and verifies it by pricing the token back.
 *
 * AND NOTHING IS SIGNED UNSIGHTED. Every swap is eth_call'd first (simulate()):
 * the action encoding is the part most likely to differ on a fork, and a wrong
 * encoding has to cost a refused trade, never a sent one.
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
      // currency0/1 and hooks travel WITH the hit: the swap must be built from
      // the key whose id was actually found, never rebuilt from assumptions.
      if (st) found.push({ ...st, id, fee, tickSpacing, quote, tokenIsZero, currency0, currency1, hooks: NATIVE });
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

// ─────────────────────────────── swapping ───────────────────────────────────
//
// v4 has no router of its own. A swap goes through the Universal Router as one
// V4_SWAP command whose payload is a list of ACTIONS: do the swap, settle what
// you owe, take what you're due. The encoding below is that list.
//
// Every constant here is env-overridable. They are Uniswap's published values,
// but this bot has already been burned once by a canonical address that did not
// match a fork (the V3 quoter on Robinhood Chain), and an action byte that a
// deployment numbers differently would build a transaction that does something
// other than what it says. Overridable beats a redeploy when that happens.
const CMD_V4_SWAP = '0x10';
const ACT_SWAP_EXACT_IN_SINGLE = '06';
const ACT_SETTLE_ALL = '0c';
const ACT_TAKE_ALL = '0f';

const UR_ABI = ['function execute(bytes commands, bytes[] inputs, uint256 deadline) payable'];
const PERMIT2_ABI = [
  'function approve(address token, address spender, uint160 amount, uint48 expiration)',
  'function allowance(address user, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)',
];

/** Router config for a chain, or null. Separate from cfg(): reading v4 prices
 *  needs only the PoolManager, and a chain may have one without the other. */
function routerCfg(chainKey) {
  const P = String(chainKey).toUpperCase();
  const router = _env(`${P}_V4_UNIVERSAL_ROUTER`);
  if (!_isAddr(router)) return null;
  const permit2 = _env(`${P}_V4_PERMIT2`);
  const actions = _env(`${P}_V4_ACTIONS`);   // "06,0c,0f" — swap,settle,take
  const [a0, a1, a2] = actions ? actions.split(',').map((s) => s.trim().replace(/^0x/, '')) : [];
  return {
    router,
    permit2: _isAddr(permit2) ? permit2 : null,
    command: _env(`${P}_V4_COMMAND`) || CMD_V4_SWAP,
    swap: a0 || ACT_SWAP_EXACT_IN_SINGLE,
    settle: a1 || ACT_SETTLE_ALL,
    take: a2 || ACT_TAKE_ALL,
  };
}

const canSwap = (chainKey) => !!(cfg(chainKey) && routerCfg(chainKey));

/**
 * Calldata for one exact-input v4 swap.
 *
 * `pool` is what bestPool() returned, so the PoolKey is the one whose id was
 * actually found on-chain — never rebuilt from assumptions here.
 */
function swapCalldata(chainKey, pool, { tokenIn, amountIn, minOut, deadline }) {
  const rc = routerCfg(chainKey);
  if (!rc) return null;
  const { currency0, currency1 } = pool;
  const zeroForOne = String(tokenIn).toLowerCase() === String(currency0).toLowerCase();
  const currencyIn = zeroForOne ? currency0 : currency1;
  const currencyOut = zeroForOne ? currency1 : currency0;
  const poolKey = [currency0, currency1, pool.fee, pool.tickSpacing, pool.hooks || NATIVE];

  const actions = '0x' + rc.swap + rc.settle + rc.take;
  const params = [
    coder.encode(
      ['tuple(tuple(address,address,uint24,int24,address),bool,uint128,uint128,bytes)'],
      [[poolKey, zeroForOne, amountIn, minOut, '0x']],
    ),
    coder.encode(['address', 'uint256'], [currencyIn, amountIn]),     // SETTLE_ALL — what we owe
    coder.encode(['address', 'uint256'], [currencyOut, minOut]),      // TAKE_ALL — the floor we accept
  ];
  const input = coder.encode(['bytes', 'bytes[]'], [actions, params]);
  const data = new ethers.Interface(UR_ABI).encodeFunctionData('execute', [rc.command, [input], deadline]);
  // Native in is paid as msg.value; an ERC20 in is pulled through Permit2 and
  // the call carries nothing.
  return { to: rc.router, data, value: currencyIn === NATIVE ? BigInt(amountIn) : 0n, currencyIn, currencyOut, zeroForOne };
}

/**
 * Simulate the swap before anything is signed.
 *
 * This is the safety rail the whole feature rests on. The action bytes and the
 * parameter layout are the parts most likely to be wrong for a given
 * deployment, and a wrong encoding must cost a REFUSED trade, never a sent one.
 * eth_call it first: it reverts on a bad encoding exactly as the real send
 * would, for no gas and no funds.
 */
async function simulate(provider, from, call) {
  try {
    await provider.call({ to: call.to, data: call.data, value: call.value, from });
    return { ok: true };
  } catch (e) {
    return { ok: false, err: (e && (e.shortMessage || e.reason || e.message)) || String(e) };
  }
}

/** Permit2 allowance top-up, when selling an ERC20 into a v4 pool. Returns the
 *  calls that still need sending, in order — empty when nothing is needed. */
async function permit2Calls(provider, chainKey, token, owner, amount) {
  const rc = routerCfg(chainKey);
  if (!rc || !rc.permit2) return null;   // not configured → caller must refuse the sell
  const out = [];
  const erc20 = new ethers.Contract(token, ['function allowance(address,address) view returns (uint256)'], provider);
  const cur = await erc20.allowance(owner, rc.permit2).catch(() => 0n);
  if (BigInt(cur) < BigInt(amount)) {
    out.push({
      to: token,
      data: new ethers.Interface(['function approve(address,uint256)']).encodeFunctionData('approve', [rc.permit2, ethers.MaxUint256]),
      what: 'approve Permit2',
    });
  }
  const p2 = new ethers.Contract(rc.permit2, PERMIT2_ABI, provider);
  let have = 0n, exp = 0;
  try { const a = await p2.allowance(owner, token, rc.router); have = BigInt(a[0]); exp = Number(a[1]); } catch (_) {}
  const now = Math.floor(Date.now() / 1000);
  if (have < BigInt(amount) || exp <= now) {
    const MAX160 = (1n << 160n) - 1n;
    const EXPIRY = now + 30 * 24 * 3600;
    out.push({
      to: rc.permit2,
      data: new ethers.Interface(PERMIT2_ABI).encodeFunctionData('approve', [token, rc.router, MAX160, EXPIRY]),
      what: 'approve the router through Permit2',
    });
  }
  return out;
}

module.exports = {
  cfg, enabled, poolId, orderCurrencies, poolState, bestPool, price, priceNativeFromSqrt,
  routerCfg, canSwap, swapCalldata, simulate, permit2Calls,
  NATIVE, DEFAULT_TIERS, DEFAULT_POOLS_SLOT, CMD_V4_SWAP,
};
