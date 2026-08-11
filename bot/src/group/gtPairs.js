// GeckoTerminal client for the group buy bot: one HTTP layer, one rate-limit
// cooldown, one pool cache — shared by the pool resolver below and by the
// per-transaction trades feed in gtTrades.js.
//
// SHARING IS THE POINT. GT's free tier is roughly 30 requests/minute for the
// whole process, and it is counted per IP, not per caller. Two modules with
// their own fetch and their own backoff means one of them keeps hammering
// through a 429 that the other has already noticed — so the cooldown lives
// here, above both, and a 429 from either one silences both. Give gtTrades.js
// its own client and this guarantee is gone.
//
// NEVER match a pool by address across chains — we always query the token on
// its OWN geckoNetwork, so a same-address deploy elsewhere cannot leak in.
// (fourtis published a "+100% pump" for a token that was down 62%, because a
// same-address token on another chain supplied the price.)
const { chainOf } = require("../config/chains");
const log = require("../helpers/logger");

// GeckoTerminal's free endpoint, and the Pro one an API key unlocks. The free
// tier is ~30 requests/minute for the WHOLE process, shared with the listing,
// trending and pump pipelines — and a 429 arms a process-wide cooldown during
// which the buy bot cannot read any pool's trades, so every group it serves
// goes quiet at once. That ceiling is the single thing most likely to make a
// busy deployment look broken, and a key is the only real way past it.
//
// Set GECKOTERMINAL_API_KEY to use the Pro base and send the key header.
// Unset — the default — nothing changes.
const GT_KEY = String(process.env.GECKOTERMINAL_API_KEY || "").trim();
const GT = String(process.env.GECKOTERMINAL_API_BASE || "").trim().replace(/\/+$/, "")
  || (GT_KEY ? "https://pro-api.coingecko.com/api/v3/onchain" : "https://api.geckoterminal.com/api/v2");
const HEADERS = GT_KEY
  ? { accept: "application/json;version=20230302", "x-cg-pro-api-key": GT_KEY }
  : { accept: "application/json;version=20230302" };
const TIMEOUT_MS = 8000;

// Chains DexScreener does NOT index — must go through GT (mirror marketdata's
// DS_CHAIN gaps). Kept as a set so the buy-bot never falls back to a source
// that returns nothing for these.
const GT_PRIMARY = new Set(["robinhood", "plasma"]);
const isGtPrimary = (chain) => GT_PRIMARY.has(chain);

const num = (x) => {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
};

const isHexAddress = (s) => /^0x[0-9a-fA-F]+$/.test(s);

/**
 * An address as it must appear IN A GECKOTERMINAL PATH.
 *
 * Hex is case-insensitive, so folding an EVM address is free. Everything else
 * is not: a Solana pool is base58, where `5P…` and `5p…` are different
 * addresses, and TON/Sui/Tron are the same. Lowercasing one produces a path
 * GeckoTerminal 404s — which the trades feed reads as "unavailable", which used
 * to mean the volume estimator posted instead, and now means the group is
 * simply silent. That is exactly what happened: every Solana group was being
 * served estimates it should never have needed, and the moment the estimator
 * was retired they went quiet while other bots on the same token kept posting.
 *
 * So: fold hex, never anything else. Mirrors tradebot/core.js `_idQ`.
 */
const gtAddr = (a) => (isHexAddress(String(a)) ? String(a).toLowerCase() : String(a));

/**
 * Do two token addresses refer to the same token?
 *
 * Lives here because gtTrades.js imports from this module (not the other way
 * round), and both need it. EVM addresses are hex and case-insensitive — GT
 * mixes checksummed and lowercased forms in one payload, so a bare === misses.
 * Solana mints, Tron and TON addresses are case-SENSITIVE base58/base64, so
 * lowercasing those to compare would be a correctness bug.
 */
function sameToken(a, b) {
  const x = String(a || "").trim();
  const y = String(b || "").trim();
  if (!x || !y) return false;
  if (x === y) return true;
  if (isHexAddress(x) && isHexAddress(y)) return x.toLowerCase() === y.toLowerCase();
  return false;
}

// GT relationship ids are "{network}_{address}".
const relAddress = (rel) => {
  const id = String((rel && rel.data && rel.data.id) || "");
  const i = id.indexOf("_");
  return i === -1 ? "" : id.slice(i + 1);
};

/**
 * The TRACKED token's ticker, from a GT pool.
 *
 * `attributes.name` is "BASE / QUOTE", so which half applies depends on which
 * side our token sits — and getting that backwards labels every buy alert with
 * the counterparty's ticker (WETH, SOL) instead of the customer's.
 */
function symbolFromGtPool(pool, tokenAddress) {
  return sidesOfGtPool(pool, tokenAddress).symbol;
}

/**
 * Both halves of a GT pool, from OUR token's point of view.
 *
 *   symbol / address        the tracked token
 *   counterSymbol/-Address  what it trades against
 *
 * The counterparty matters because a buy alert wants to say "$48.97 (0.6646
 * SOL)" — and the only honest source for that native figure is the amount the
 * trader actually SPENT, which is only a native amount when the other side of
 * the pool IS the native coin.
 */
function sidesOfGtPool(pool, tokenAddress) {
  const a = (pool && pool.attributes) || {};
  const rel = (pool && pool.relationships) || {};
  const parts = String(a.name || "").split("/").map((s) => s.trim());
  const quoteAddr = relAddress(rel.quote_token);
  const baseAddr = relAddress(rel.base_token);
  if (parts.length < 2) return { symbol: "", counterSymbol: "", address: "", counterAddress: "" };
  const tokenIsQuote = sameToken(quoteAddr, tokenAddress);
  return {
    symbol: (tokenIsQuote ? parts[1] : parts[0]) || "",
    counterSymbol: (tokenIsQuote ? parts[0] : parts[1]) || "",
    address: tokenIsQuote ? quoteAddr : baseAddr,
    counterAddress: tokenIsQuote ? baseAddr : quoteAddr,
  };
}

/**
 * The token's NAME ("The Nietzschean Dog"), which the pool listing does not
 * carry — its `name` is the PAIR ("HOPPY / WETH"). Called once at /settoken and
 * on self-heal, never per poll.
 */
async function fetchTokenInfo(chain, address) {
  const net = networkOf(chain);
  if (net) {
    const res = await gtGet(`/networks/${net}/tokens/${address}`);
    const a = res && res.ok && res.body && res.body.data && res.body.data.attributes;
    if (a && (a.name || a.symbol)) return { name: String(a.name || ""), symbol: String(a.symbol || "") };
  }
  if (!isGtPrimary(chain)) {
    try {
      const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${address}`, {
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (r.ok) {
        const j = await r.json();
        const p = (j.pairs || []).find((x) => x && (sameToken(x.baseToken?.address, address) || sameToken(x.quoteToken?.address, address)));
        const t = p && (sameToken(p.baseToken?.address, address) ? p.baseToken : p.quoteToken);
        if (t) return { name: String(t.name || ""), symbol: String(t.symbol || "") };
      }
    } catch {
      /* best effort — the alert falls back to the ticker */
    }
  }
  return null;
}

// ── Shared rate-limit cooldown ───────────────────────────────────────────────
// Armed by a 429 (or a 5xx run) and honoured by EVERY caller. While it is armed
// gtGet returns `{ ok: false }` without making a request — which the trades feed
// reads as "unavailable" and degrades on, rather than as "no buys".
const COOLDOWN_MS = 120 * 1000;
let cooldownUntil = 0;

const inCooldown = (at = Date.now()) => at < cooldownUntil;

function armCooldown(why, at = Date.now()) {
  if (inCooldown(at)) return;
  cooldownUntil = at + COOLDOWN_MS;
  // Louder than it used to need to be. When the volume estimator still existed
  // this cost a group some accuracy; now that a buy is only alerted with its
  // transaction, it costs them the alert entirely until the feed is back — so
  // the log has to say what to do about it, not just that it happened.
  log.warn(
    `[buybot] GeckoTerminal backing off for ${COOLDOWN_MS / 1000}s — ${why}. ` +
      (GT_KEY
        ? "Buy alerts are paused process-wide until it lifts."
        : "Buy alerts are paused process-wide until it lifts; set GECKOTERMINAL_API_KEY to raise the limit."),
  );
}

/**
 * One GET against GT. Never throws.
 * Returns { ok:true, status, body } or { ok:false, status, reason }.
 *
 * `ok:false` deliberately covers everything from a dead socket to a 404: the
 * only thing a caller can do with any of them is stop trusting the answer, and
 * collapsing them here keeps that decision in one place.
 */
async function gtGet(path, params) {
  if (inCooldown()) return { ok: false, status: 0, reason: "cooldown" };
  const qs = new URLSearchParams(params || {}).toString();
  const url = `${GT}${path}${qs ? `?${qs}` : ""}`;
  try {
    const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (res.status === 429) {
      armCooldown("HTTP 429 (rate limited)");
      return { ok: false, status: 429, reason: "rate limited" };
    }
    // A 5xx does NOT arm the cooldown. It is a per-request failure and says
    // nothing about our quota, whereas the cooldown is process-wide: arming it
    // here would let one bad moment on one pool stop every group's buy bot for
    // two minutes — and, because an unreadable feed degrades to the volume
    // estimator, replace real alerts with estimates while it did. 429 is the
    // only status that genuinely means "all of you, stop".
    if (res.status >= 500) return { ok: false, status: res.status, reason: "server error" };
    if (!res.ok) return { ok: false, status: res.status, reason: `HTTP ${res.status}` };
    return { ok: true, status: res.status, body: await res.json() };
  } catch (e) {
    // A timeout is not a rate limit — do NOT arm the shared cooldown for it, or
    // one slow pool takes every group's buy bot offline for two minutes.
    return { ok: false, status: 0, reason: (e && e.message) || "request failed" };
  }
}

const networkOf = (chain) => (chainOf(chain) && chainOf(chain).geckoNetwork) || null;

/**
 * Resolve the token's deepest pool on its chain into a snapshot:
 *   { poolAddress, priceUsd, mcap, volume24h, liquidity, buys24h, sells24h }
 * Returns null when neither GT nor DexScreener has the token.
 */
async function fetchPool(chain, address) {
  const net = networkOf(chain);
  if (net) {
    const gt = await fetchGtPool(net, address).catch(() => null);
    if (gt) return gt;
  }
  if (!isGtPrimary(chain)) {
    const ds = await fetchDsPool(chain, address).catch(() => null);
    if (ds) return ds;
  }
  return null;
}

// ── Pool metadata cache ──────────────────────────────────────────────────────
// Price / mcap / liquidity only decorate an alert; they are not what detects
// one. With the trades feed as the detector, an idle pool must cost exactly ONE
// request per poll (the trades call) — so metadata is fetched only when a buy
// actually needs rendering, and then reused for a minute.
const META_TTL_MS = 60 * 1000;
const metaCache = new Map(); // `${chain}/${address}` → { at, pool }

async function fetchPoolCached(chain, address, at = Date.now()) {
  const k = `${chain}/${address}`;
  const hit = metaCache.get(k);
  if (hit && at - hit.at < META_TTL_MS) return hit.pool;
  const pool = await fetchPool(chain, address).catch(() => null);
  // Only a SUCCESSFUL lookup is cached. Caching a miss would hold a whole
  // minute of alerts at "price —" because one request happened to time out.
  if (pool) metaCache.set(k, { at, pool });
  return pool || (hit ? hit.pool : null);
}

async function fetchGtPool(net, address) {
  const res = await gtGet(`/networks/${net}/tokens/${address}/pools`, { page: 1 });
  if (!res.ok) return null;
  const pools = (res.body && res.body.data) || [];
  if (!pools.length) return null;
  // deepest-liquidity pool wins
  pools.sort((a, b) => (num(b.attributes?.reserve_in_usd) || 0) - (num(a.attributes?.reserve_in_usd) || 0));
  const a = pools[0].attributes || {};
  const tx = (a.transactions && a.transactions.h24) || {};
  const sides = sidesOfGtPool(pools[0], address);
  return {
    poolAddress: a.address || null,
    symbol: sides.symbol,
    counterSymbol: sides.counterSymbol,
    counterAddress: sides.counterAddress,
    priceUsd: num(a.base_token_price_usd) ?? num(a.token_price_usd),
    mcap: num(a.market_cap_usd) ?? num(a.fdv_usd),
    volume24h: (a.volume_usd && num(a.volume_usd.h24)) || 0,
    liquidity: num(a.reserve_in_usd) || 0,
    buys24h: num(tx.buys) || 0,
    sells24h: num(tx.sells) || 0,
    change24h: num(a.price_change_percentage && a.price_change_percentage.h24),
    source: "gt",
  };
}

const DS_CHAIN = { solana: "solana", bsc: "bsc", ethereum: "ethereum", base: "base", tron: "tron", ton: "ton", sui: "sui" };

async function fetchDsPool(chain, address) {
  const dsChain = DS_CHAIN[chain];
  if (!dsChain) return null;
  const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${address}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) return null;
  const j = await res.json();
  const pairs = (j.pairs || []).filter((p) => p && p.chainId === dsChain);
  if (!pairs.length) return null;
  pairs.sort((a, b) => (num(b.liquidity?.usd) || 0) - (num(a.liquidity?.usd) || 0));
  const p = pairs[0];
  const tx = (p.txns && p.txns.h24) || {};
  const quoteSide = sameToken(p.quoteToken && p.quoteToken.address, address);
  const ours = (quoteSide ? p.quoteToken : p.baseToken) || {};
  const other = (quoteSide ? p.baseToken : p.quoteToken) || {};
  return {
    poolAddress: p.pairAddress || null,
    symbol: ours.symbol || "",
    name: ours.name || "",
    counterSymbol: other.symbol || "",
    counterAddress: other.address || "",
    priceUsd: num(p.priceUsd),
    mcap: num(p.marketCap) ?? num(p.fdv),
    volume24h: (p.volume && num(p.volume.h24)) || 0,
    liquidity: num(p.liquidity?.usd) || 0,
    buys24h: num(tx.buys) || 0,
    sells24h: num(tx.sells) || 0,
    change24h: num(p.priceChange && p.priceChange.h24),
    source: "ds",
  };
}

/** Test seam — clear the shared cooldown and the metadata cache. */
function _reset() {
  cooldownUntil = 0;
  metaCache.clear();
}

module.exports = {
  GT_BASE: GT,
  gtAddr,
  isHexAddress,
  hasApiKey: () => !!GT_KEY,
  inCooldown,
  fetchPool,
  fetchPoolCached,
  isGtPrimary,
  gtGet,
  sameToken,
  symbolFromGtPool,
  sidesOfGtPool,
  fetchTokenInfo,
  networkOf,
  inCooldown,
  armCooldown,
  _reset,
  GT,
  COOLDOWN_MS,
  META_TTL_MS,
};
