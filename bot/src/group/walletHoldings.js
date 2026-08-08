// How much of the tracked token does this buyer already hold?
//
// WHAT THIS IS, AND WHAT IT IS NOT
// It reads the buyer's balance OF THE TRACKED TOKEN, on chain, and values it at
// the pool price. It is NOT a portfolio valuation — this bot has no
// portfolio API, and every chain would need a different one.
//
// That distinction is the whole reason the alert says "Holds" and not "Wallet
// Balance". Printing a single-token figure under a label that promises a total
// is a wrong number presented as a right one, which is the failure mode this
// codebase has the longest history with. The signal a group actually wants —
// is this a big holder of OUR token? — is exactly what this measures.
//
// Chains without a reader here simply return null: whale detection is skipped
// and ordinary buy alerts are unaffected.
const { RPC } = require("../config/constants");
const log = require("../helpers/logger");

const TIMEOUT_MS = 6000;
// A wallet's holding barely moves between two buys seconds apart, and a busy
// pool would otherwise spend one RPC call per alert per wallet.
const CACHE_MS = 2 * 60 * 1000;
const CACHE_MAX = 2000;
// A failed lookup is remembered for much less time than a good one — long
// enough to stop a dead RPC costing a timeout per buy, short enough that a
// recovery is picked up quickly.
const FAIL_CACHE_MS = 60 * 1000;
// Token decimals never change, so they are worth remembering for the process.
const decimalsCache = new Map();
const holdCache = new Map(); // `${chain}:${token}:${wallet}` → { at, amount }

const EVM_FAMILY = new Set(["ethereum", "bsc", "base", "robinhood", "polygon", "arbitrum", "optimism", "avalanche", "berachain", "sonic", "hyperevm", "abstract", "apechain", "blast", "sei", "unichain", "plasma"]);

const withTimeout = (p, ms = TIMEOUT_MS) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms).unref?.())]);

// ── EVM ──────────────────────────────────────────────────────────────────────

const ERC20 = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
];

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

// ONE provider per chain, reused. Constructing one per lookup opens a fresh
// socket for every buy, and an unreachable RPC then leaves a pile of them
// waiting — enough to keep the process's event loop alive on its own.
const providers = new Map();
function evmProvider(ethers, chain, url) {
  if (!providers.has(chain)) providers.set(chain, new ethers.JsonRpcProvider(url));
  return providers.get(chain);
}

async function evmHolding(chain, token, wallet) {
  const ethers = ethersLib();
  const url = RPC[chain];
  if (!ethers || !url) return null;
  const provider = evmProvider(ethers, chain, url);
  const c = new ethers.Contract(token, ERC20, provider);
  const dKey = `${chain}:${token}`;
  let decimals = decimalsCache.get(dKey);
  if (decimals == null) {
    decimals = Number(await withTimeout(c.decimals()));
    if (!Number.isFinite(decimals)) return null;
    decimalsCache.set(dKey, decimals);
  }
  const raw = await withTimeout(c.balanceOf(wallet));
  return Number(raw) / 10 ** decimals;
}

// ── Solana ───────────────────────────────────────────────────────────────────

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

async function solanaHolding(_chain, mint, wallet) {
  const web3 = solLib();
  if (!web3 || !RPC.solana) return null;
  const conn = new web3.Connection(RPC.solana, "confirmed");
  const res = await withTimeout(
    conn.getParsedTokenAccountsByOwner(new web3.PublicKey(wallet), { mint: new web3.PublicKey(mint) }),
  );
  // A wallet can hold the same mint across several token accounts.
  let total = 0;
  for (const { account } of (res && res.value) || []) {
    const amt = account?.data?.parsed?.info?.tokenAmount?.uiAmount;
    if (Number.isFinite(amt)) total += amt;
  }
  return total;
}

// ── Public ───────────────────────────────────────────────────────────────────

function sweepCache(at) {
  if (holdCache.size <= CACHE_MAX) return;
  for (const [k, v] of holdCache) if (at - v.at > CACHE_MS) holdCache.delete(k);
  if (holdCache.size > CACHE_MAX) holdCache.clear();
}

/**
 * The buyer's balance of `token`, in whole tokens. null when we cannot read it —
 * an unsupported chain, a dead RPC, a malformed address. NEVER throws, and a
 * null must never stop an alert: not knowing how big a holder someone is is not
 * a reason to withhold the buy.
 */
async function holdingOf(chain, token, wallet, at = Date.now()) {
  if (!chain || !token || !wallet) return null;
  const key = `${chain}:${token}:${wallet}`;
  const hit = holdCache.get(key);
  if (hit && at - hit.at < CACHE_MS) return hit.amount;

  let amount = null;
  try {
    if (chain === "solana") amount = await solanaHolding(chain, token, wallet);
    else if (EVM_FAMILY.has(chain)) amount = await evmHolding(chain, token, wallet);
  } catch (e) {
    log.debug(`[buybot] holding lookup failed for ${chain}/${wallet}: ${e && e.message}`);
    amount = null;
  }
  if (amount == null || !Number.isFinite(amount)) {
    // Remember the MISS too, briefly. An unreachable RPC would otherwise cost a
    // six-second timeout on every qualifying buy, for as long as it stays down.
    holdCache.set(key, { at: at - (CACHE_MS - FAIL_CACHE_MS), amount: null });
    sweepCache(at);
    return null;
  }
  holdCache.set(key, { at, amount });
  sweepCache(at);
  return amount;
}

/** Is this chain one we can read holdings on at all? Lets the caller skip the
 *  work — and skip promising a feature it cannot deliver. */
const supports = (chain) => chain === "solana" || EVM_FAMILY.has(chain);

function _reset() {
  holdCache.clear();
  decimalsCache.clear();
}

function _reset2() {
  for (const p of providers.values()) {
    try {
      p.destroy?.();
    } catch {
      /* best effort */
    }
  }
  providers.clear();
}

module.exports = { holdingOf, supports, _reset, _resetProviders: _reset2, CACHE_MS, FAIL_CACHE_MS, EVM_FAMILY };
