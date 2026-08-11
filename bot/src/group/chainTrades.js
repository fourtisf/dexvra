// Per-transaction buys read STRAIGHT FROM THE CHAIN, with no indexer in front.
//
// WHY THIS EXISTS
// The buy bot read its trades from GeckoTerminal, and GeckoTerminal refuses
// this server. Not by volume — a diagnostic run tracking ONE pool, needing 2.4
// requests a minute against a 25/minute budget, was 429'd on its second call
// from a fresh process. That is an IP-level refusal, standard for datacenter
// ranges, and no amount of pacing or prioritising can argue with it. DexScreener
// answers the same server fine, which is why prices kept working while every
// group went silent.
//
// So this reads the swaps itself. The chain is the source that cannot rate-limit
// us out of our own product, it is free, and it is the only feed that is
// genuinely realtime rather than realtime-once-an-index-catches-up.
//
// THE RETURN CONTRACT IS gtTrades.fetchPoolBuys's, deliberately, so the caller
// can try one and fall back to the other:
//
//   null  unreadable — every endpoint failed, or the pool's shape is not one we
//         decode. The caller must NOT read this as "no buys".
//   []    read fine, nothing new.
//
// USD is not on the chain. Amounts here are exact; the dollar figure is the
// pool's own price applied to them, passed in by the caller, so it agrees with
// the price printed on the same card.
const { rpcRead } = require("../config/rpc");
const { chainOf } = require("../config/chains");
const log = require("../helpers/logger");

const TIMEOUT_MS = 9000;
const BUDGET_MS = 20000;
// A poll that finds more than this is a pool we have fallen far behind on —
// buyMonitor caps what it will post anyway (MAX_PER_POLL), and reading a
// thousand transactions to throw away 992 of them is how a free RPC key gets
// spent by lunchtime.
const MAX_TX = 40;
// How far back a FIRST sight looks. buyMonitor applies its own first-sight
// window on top; this only bounds the work.
const FIRST_SIGHT_BLOCKS = 500;
const FIRST_SIGHT_SIGS = 25;

// ── lazy libs ────────────────────────────────────────────────────────────────
let ethersMod = null;
function ethersLib() {
  if (ethersMod === null) {
    try {
      ethersMod = require("ethers").ethers;
    } catch {
      ethersMod = false;
    }
  }
  return ethersMod || null;
}
let solMod = null;
function solLib() {
  if (solMod === null) {
    try {
      solMod = require("@solana/web3.js");
    } catch {
      solMod = false;
    }
  }
  return solMod || null;
}

// One provider/connection per ENDPOINT, reused. Same reasoning as
// walletHoldings: a fresh one per poll opens a socket per poll, and an
// unreachable node then leaves a pile of them retrying forever — enough to hold
// the event loop open on its own.
const providers = new Map();
function evmProvider(ethers, url) {
  if (!providers.has(url)) providers.set(url, new ethers.JsonRpcProvider(url));
  return providers.get(url);
}
const connections = new Map();
function solConnection(web3, url) {
  if (!connections.has(url)) connections.set(url, new web3.Connection(url, "confirmed"));
  return connections.get(url);
}
function dropEndpoint(url) {
  const p = providers.get(url);
  providers.delete(url);
  connections.delete(url);
  try {
    p?.destroy?.();
  } catch {
    /* best effort — the point is to stop the retry loop, not to succeed at it */
  }
}

// config/chains describes a chain by `family`, not by a chainId/kind pair — the
// shape this first assumed. Guessing it wrong is silent: supports() returns
// false for every chain and the reader is never called at all, which looks
// exactly like the reader not working.
const isEvm = (chain) => (chainOf(chain) || {}).family === "evm";
const isSvm = (chain) => (chainOf(chain) || {}).family === "solana";

/** Does this chain have a reader at all? Callers use it to decide whether the
 *  chain path is even worth trying before falling back to an indexer. */
const supports = (chain) => isEvm(chain) || isSvm(chain);

// ── EVM ──────────────────────────────────────────────────────────────────────
//
// Uniswap V2 and V3 pools emit different Swap events and the difference is not
// cosmetic: V2 gives four UNSIGNED amounts (in0,in1,out0,out1) and V3 gives two
// SIGNED ones, where negative means "left the pool", i.e. went to the trader.
// Reading a V3 log with V2's shape does not fail, it silently reports the wrong
// direction — which on a buy bot means posting a green alert on a dump.
const V2_SWAP = "Swap(address,uint256,uint256,uint256,uint256,address)";
const V3_SWAP = "Swap(address,address,int256,int256,uint160,uint128,int24)";

const token0Cache = new Map(); // `${chain}:${pool}` → token0 address, lowercased
const decimalsCache = new Map(); // `${chain}:${token}` → decimals

/**
 * A token's decimals, from the token itself.
 *
 * NOT from the pool snapshot: that comes from an indexer and does not carry
 * them, so trusting a default of 18 puts a 6-decimal token out by a factor of a
 * trillion — and the number it lands on is still a plausible-looking amount, so
 * nothing about the alert says it is wrong. Cached only after a node has
 * actually answered, so a NaN from a half-broken endpoint is not remembered.
 */
async function evmDecimals(chain, token) {
  const key = `${chain}:${String(token).toLowerCase()}`;
  if (decimalsCache.has(key)) return decimalsCache.get(key);
  const ethers = ethersLib();
  if (!ethers) return null;
  const { value } = await rpcRead(
    chain,
    async (url) => {
      const c = new ethers.Contract(token, ["function decimals() view returns (uint8)"], evmProvider(ethers, url));
      const d = Number(await c.decimals());
      return Number.isFinite(d) ? d : null;
    },
    { timeoutMs: TIMEOUT_MS, budgetMs: BUDGET_MS, onFail: dropEndpoint },
  );
  if (Number.isFinite(value)) decimalsCache.set(key, value);
  return Number.isFinite(value) ? value : null;
}

async function evmToken0(chain, pool) {
  const key = `${chain}:${String(pool).toLowerCase()}`;
  if (token0Cache.has(key)) return token0Cache.get(key);
  const ethers = ethersLib();
  if (!ethers) return null;
  const { value } = await rpcRead(
    chain,
    async (url) => {
      const c = new ethers.Contract(pool, ["function token0() view returns (address)"], evmProvider(ethers, url));
      return String(await c.token0()).toLowerCase();
    },
    { timeoutMs: TIMEOUT_MS, budgetMs: BUDGET_MS, onFail: dropEndpoint },
  );
  if (value) token0Cache.set(key, value);
  return value || null;
}

/**
 * One Swap log → a buy of `token`, or null.
 *
 * `tokenIsZero` decides which side of the pool is ours, and it comes from the
 * pool's own token0() rather than from address ordering — a pool is free to be
 * created either way round and guessing costs a reversed alert.
 */
function decodeEvmSwap(ethers, ifaceV2, ifaceV3, logEntry, tokenIsZero) {
  let tokenOut = 0n;
  let spent = 0n;
  try {
    if (logEntry.topics[0] === ethers.id(V2_SWAP)) {
      const d = ifaceV2.parseLog(logEntry);
      if (!d) return null;
      const [, a0In, a1In, a0Out, a1Out] = d.args;
      tokenOut = tokenIsZero ? BigInt(a0Out) : BigInt(a1Out);
      spent = tokenIsZero ? BigInt(a1In) : BigInt(a0In);
    } else if (logEntry.topics[0] === ethers.id(V3_SWAP)) {
      const d = ifaceV3.parseLog(logEntry);
      if (!d) return null;
      const a0 = BigInt(d.args[2]);
      const a1 = BigInt(d.args[3]);
      // Negative = out of the pool, into the trader's hands.
      const ours = tokenIsZero ? a0 : a1;
      const other = tokenIsZero ? a1 : a0;
      if (ours >= 0n) return null; // our token went INTO the pool — a sell
      tokenOut = -ours;
      spent = other > 0n ? other : 0n;
    } else {
      return null;
    }
  } catch {
    return null;
  }
  if (tokenOut <= 0n) return null; // not a buy of our token
  return { tokenOut, spent };
}

async function evmBuys(chain, pool, token, { sinceBlock, counterAddress }) {
  const ethers = ethersLib();
  if (!ethers) return null;
  const tok0 = await evmToken0(chain, pool);
  if (!tok0) return null;
  const tokenIsZero = tok0 === String(token).toLowerCase();
  const decimals = await evmDecimals(chain, token);
  // No decimals, no amounts worth printing. Returning null sends the caller to
  // the indexer rather than posting a figure that is wrong by orders of
  // magnitude and looks perfectly reasonable.
  if (decimals == null) return null;
  // The counter side is usually wrapped native (18) but can be USDC (6). Only
  // the "(3.46 SOL)" style suffix depends on it, so a failure here costs that
  // and not the alert.
  const counterDecimals = counterAddress ? await evmDecimals(chain, counterAddress).catch(() => null) : null;

  const ifaceV2 = new ethers.Interface([
    "event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)",
  ]);
  const ifaceV3 = new ethers.Interface([
    "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)",
  ]);

  const { value } = await rpcRead(
    chain,
    async (url) => {
      const provider = evmProvider(ethers, url);
      const head = await provider.getBlockNumber();
      const from = sinceBlock > 0 ? Math.max(0, Number(sinceBlock)) : Math.max(0, head - FIRST_SIGHT_BLOCKS);
      if (from > head) return [];
      const logs = await provider.getLogs({
        address: pool,
        fromBlock: from,
        toBlock: head,
        topics: [[ethers.id(V2_SWAP), ethers.id(V3_SWAP)]],
      });
      const recent = logs.slice(-MAX_TX);
      const out = [];
      // Block timestamps come from a per-block cache: a burst of buys shares
      // blocks, and asking for the same one per log is the difference between
      // three requests and thirty.
      const blockTimes = new Map();
      for (const l of recent) {
        const hit = decodeEvmSwap(ethers, ifaceV2, ifaceV3, l, tokenIsZero);
        if (!hit) continue;
        if (!blockTimes.has(l.blockNumber)) {
          const b = await provider.getBlock(l.blockNumber).catch(() => null);
          blockTimes.set(l.blockNumber, b && b.timestamp ? b.timestamp * 1000 : 0);
        }
        // The BUYER is the transaction's sender, not the Swap event's
        // `to`/`recipient`: on any routed swap those are the router, and a buy
        // bot that names the router names the same wallet on every alert.
        const tx = await provider.getTransaction(l.transactionHash).catch(() => null);
        out.push({
          txHash: l.transactionHash,
          buyer: (tx && tx.from) || "",
          tokenAmount: Number(ethers.formatUnits(hit.tokenOut, decimals)),
          spentAmount: Number(ethers.formatUnits(hit.spent, counterDecimals ?? 18)),
          blockNumber: Number(l.blockNumber),
          blockTimeMs: blockTimes.get(l.blockNumber) || 0,
        });
      }
      return out;
    },
    { timeoutMs: TIMEOUT_MS, budgetMs: BUDGET_MS, onFail: dropEndpoint },
  );
  return value || null;
}

// ── Solana ───────────────────────────────────────────────────────────────────
//
// Read the BALANCE DELTA, never the instruction. Solana has a dozen DEX
// programs and a routed swap can touch several in one transaction; decoding
// each program's instruction layout is a maintenance treadmill that breaks
// every time one of them ships a new version. The signer's token balance going
// UP is the same fact on every one of them, and it is what a block explorer
// shows the user anyway.
async function solanaBuys(chain, pool, token, { sinceSig, sinceSlot }) {
  const web3 = solLib();
  if (!web3) return null;
  const { value } = await rpcRead(
    chain,
    async (url) => {
      const conn = solConnection(web3, url);
      const poolKey = new web3.PublicKey(pool);
      const sigs = await conn.getSignaturesForAddress(poolKey, {
        limit: sinceSig ? MAX_TX : FIRST_SIGHT_SIGS,
        ...(sinceSig ? { until: sinceSig } : {}),
      });
      if (!sigs.length) return [];
      // getSignaturesForAddress returns NEWEST first; alerts must post in the
      // order the buys happened.
      const ordered = sigs.slice(0, MAX_TX).reverse().filter((s) => !s.err);
      const out = [];
      for (const s of ordered) {
        if (sinceSlot && s.slot <= sinceSlot) continue;
        const tx = await conn
          .getTransaction(s.signature, { maxSupportedTransactionVersion: 0 })
          .catch(() => null);
        if (!tx || !tx.meta) continue;
        const keys = tx.transaction.message.staticAccountKeys
          ? tx.transaction.message.staticAccountKeys.map((k) => k.toBase58())
          : (tx.transaction.message.accountKeys || []).map((k) => (k.toBase58 ? k.toBase58() : String(k)));
        const payer = keys[0] || "";
        if (!payer) continue;
        // The fee payer's balance of OUR mint, before and after. Anyone else's
        // delta in the same transaction is the pool's or the router's.
        const mine = (list) =>
          (list || []).find(
            (b) => b.mint === token && (b.owner === payer || keys[b.accountIndex] === payer),
          );
        const pre = mine(tx.meta.preTokenBalances);
        const post = mine(tx.meta.postTokenBalances);
        const before = Number((pre && pre.uiTokenAmount && pre.uiTokenAmount.uiAmount) || 0);
        const after = Number((post && post.uiTokenAmount && post.uiTokenAmount.uiAmount) || 0);
        const gained = after - before;
        if (!(gained > 0)) continue; // a sell, or not a trade of this token
        // What they paid, in SOL: the lamport delta, with the fee added back so
        // the figure matches the swap rather than the swap plus gas.
        const idx = keys.indexOf(payer);
        const solBefore = Number((tx.meta.preBalances || [])[idx] || 0);
        const solAfter = Number((tx.meta.postBalances || [])[idx] || 0);
        const lamports = solBefore - solAfter - Number(tx.meta.fee || 0);
        out.push({
          txHash: s.signature,
          buyer: payer,
          tokenAmount: gained,
          spentAmount: lamports > 0 ? lamports / 1e9 : 0,
          blockNumber: Number(s.slot) || 0,
          blockTimeMs: s.blockTime ? s.blockTime * 1000 : 0,
        });
      }
      return out;
    },
    { timeoutMs: TIMEOUT_MS, budgetMs: BUDGET_MS, onFail: dropEndpoint },
  );
  return value || null;
}

/**
 * Buys of `token` in `pool`, read from the chain.
 *
 * `priceUsd` prices them — the chain knows amounts, not dollars — and it is the
 * POOL's price, so the alert's USD figure and the price printed beside it come
 * from the same number instead of disagreeing.
 */
async function fetchPoolBuys(chain, pool, token, opts = {}) {
  if (!pool || !token || !supports(chain)) return null;
  const { minUsd = 0, priceUsd = 0, counterSymbol, counterAddress } = opts;
  let raw = null;
  try {
    raw = isSvm(chain)
      ? await solanaBuys(chain, pool, token, { sinceSig: opts.sinceSig, sinceSlot: opts.sinceBlock })
      : await evmBuys(chain, pool, token, { sinceBlock: opts.sinceBlock, counterAddress });
  } catch (e) {
    log.debug(`[chaintrades] ${chain}/${pool}: ${e && e.message}`);
    return null;
  }
  if (raw == null) return null;
  const out = [];
  for (const b of raw) {
    const usd = priceUsd > 0 ? b.tokenAmount * priceUsd : 0;
    // An UNPRICED buy is dropped, exactly as the indexer path drops one: an
    // alert that cannot say what was spent is not worth posting, and letting it
    // through as $0 would put it under every group's floor anyway.
    if (!(usd > 0)) continue;
    if (usd < minUsd) continue;
    out.push({
      ...b,
      usd,
      priceUsd,
      spentToken: counterAddress || "",
      counterSymbol: counterSymbol || "",
    });
  }
  return out.sort((a, b) => a.blockNumber - b.blockNumber || a.blockTimeMs - b.blockTimeMs);
}

module.exports = {
  fetchPoolBuys,
  supports,
  decodeEvmSwap,
  V2_SWAP,
  V3_SWAP,
  MAX_TX,
  _reset: () => {
    token0Cache.clear();
    decimalsCache.clear();
    providers.clear();
    connections.clear();
  },
};
