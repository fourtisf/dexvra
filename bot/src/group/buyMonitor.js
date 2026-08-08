// Group buy-bot monitor.
//
// TWO PATHS, AND WHICH ONE RUNS IS THE WHOLE DESIGN
//
//   REAL (gtTrades.js)  GeckoTerminal's per-pool trades feed gives every buy a
//                       transaction hash, a buyer address and GT's own USD
//                       figure. The alert is verifiable: the reader can open
//                       the transaction and see the same number.
//
//   ESTIMATE (below)    Kept ONLY for when the feed is unavailable. It diffs
//                       the rolling 24h volume between polls and apportions
//                       the delta by the buy/sell tx split, which is honest to
//                       within "≈" and no further — see estimateBuys().
//
// The switch between them is `fetchPoolBuys()` returning null (unavailable →
// estimate) versus [] (answered, quiet pool → stay silent). Treating those two
// as the same thing is the bug this file is shaped around: read an outage as
// silence and the group hears nothing for hours; read silence as an outage and
// every buy posts twice, once real and once estimated.
//
// Lessons carried from fourtis (don't regress):
//  - Direction comes from the TOKEN ADDRESSES, never GT's base-relative `kind`.
//  - Always resolve the pool on the token's OWN chain (gtPairs), never match a
//    pool by address across chains.
//  - Self-heal a MISSING pairAddress; never repoint one an admin resolved.
//  - Never diff a volume baseline across a GT↔DexScreener source switch.
//  - Never spend the dedupe budget before the message exists (alertLatch.js).
//  - Dead pools log once/hour instead of failing silently.
const {
  GROUP_BUYBOT_CHECK_MS,
  BUYBOT_POOL_MIN_MS,
  BUYBOT_EMOJI_STEP_USD,
  BUYBOT_EMOJI_MIN,
  BUYBOT_EMOJI_MAX,
  BUYBOT_WHALE_USD,
  BUYBOT_MEGA_USD,
  TRADEBOT_USERNAME,
  SITE_URL,
} = require("../config/constants");
const cfg = require("./config");
const gt = require("./gtPairs");
const trades = require("./gtTrades");
const latch = require("./alertLatch");
const { isFatalChatError, describeChatError } = require("./fatalChatError");
const tpl = require("../templates");
const { payloadArgs } = require("../helpers/message");
const { fmtPrice, formatNumber, fmtPct } = require("../helpers/format");
const { chainOf, txUrl, accountUrl, shortAddress } = require("../config/chains");
const premium = require("../premium");
const { loadJSONSync, saveJSON } = require("../helpers/persist");
const log = require("../helpers/logger");

const STATE_FILE = "buybot.json";
const STATE_VERSION = 2;

// v1 keyed volume snapshots by CHAT id; v2 keys them by POOL, because several
// groups can track the same token and the baseline belongs to the pool, not to
// whoever happens to be watching it. A v1 file is discarded rather than
// migrated — its worst case is one skipped estimate per pool on first poll,
// against the risk of misreading a chat id as a pool address.
function loadState() {
  const raw = loadJSONSync(STATE_FILE, null);
  if (!raw || raw.v !== STATE_VERSION) return { v: STATE_VERSION, pools: {}, cursors: {} };
  return { v: STATE_VERSION, pools: raw.pools || {}, cursors: raw.cursors || {} };
}
const state = loadState();
const saveState = () => saveJSON(STATE_FILE, state).catch(() => {});

const deadLog = {}; // poolKey → last dead-pool log ts (throttle to 1/hour)
const lastPoll = new Map(); // poolKey → ts of the last trades read

// NOTE: there is deliberately no second, pool-level "already seen" set here.
// An earlier cut had one, and it was worse than useless: it skipped a
// transaction whose delivery had FAILED TRANSIENTLY, so the retry that
// alertLatch.release() exists to allow could never happen — the alert was lost
// for the length of that set's TTL. alertLatch is the one gate, it already
// distinguishes "delivered" from "failed, try again", and its lookup is a hash
// hit. Do not add a faster check in front of it.

// Only trades from the last two minutes are alertable the first time we see a
// pool, and at most five of them. GT hands back 24 HOURS of trades — replaying
// that into a group is a wall of hundreds of alerts for buys that happened
// yesterday, which is how a new customer's first impression of the bot becomes
// "mute it".
const FIRST_SIGHT_MS = 120 * 1000;
const FIRST_SIGHT_MAX = 5;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Date.now();
const poolKeyOf = (chain, pool) => `${chain}:${String(pool).toLowerCase()}`;

/**
 * Estimate the buys that happened between two pool snapshots — THE DEGRADED
 * PATH. Only reached when the real trades feed could not be read.
 *
 * newBuys = buys24h delta; buy USD ≈ the positive volume delta apportioned by
 * the buy share of new transactions. Returns null when there's no new buy or
 * we can't estimate (first observation / counters rolled / SOURCE CHANGED).
 *
 * Source guard (fourtis lesson): never diff a volume baseline across a
 * GT↔DexScreener source switch — the two report different 24h windows, so a
 * switch would fabricate a phantom multi-thousand-dollar buy.
 */
function estimateBuys(prev, cur) {
  if (!prev) return null;
  if (prev.source && cur.source && prev.source !== cur.source) return null;
  const dBuys = (cur.buys24h || 0) - (prev.buys24h || 0);
  const dSells = (cur.sells24h || 0) - (prev.sells24h || 0);
  const dVol = (cur.volume24h || 0) - (prev.volume24h || 0);
  if (dBuys <= 0 || dVol <= 0) return null; // no new buys, or 24h window rolled
  const buyShare = dBuys + dSells > 0 ? dBuys / (dBuys + dSells) : 1;
  const buyUsd = dVol * buyShare;
  if (!(buyUsd > 0)) return null;
  return { count: dBuys, usd: buyUsd, avgUsd: buyUsd / dBuys };
}

/**
 * Which of these buys are new, given the stored cursor?
 *
 * The block comparison is `>=`, NOT `>`: several trades share a block, so a
 * strict `>` silently drops every same-block sibling of the last one posted.
 * The cost is that a quiet pool re-reads its newest block every poll — which
 * is exactly what the per-transaction dedupe below is for.
 */
function selectFresh(cursor, buys, at = now()) {
  if (!cursor) {
    const cutoff = at - FIRST_SIGHT_MS;
    return buys.filter((b) => b.blockTimeMs && b.blockTimeMs >= cutoff).slice(-FIRST_SIGHT_MAX);
  }
  if (cursor.b > 0) return buys.filter((b) => b.blockNumber >= cursor.b);
  // Seeded on an empty feed: there is no block to compare against, so judge by
  // time. Without this, a pool that was idle when we first saw it would look
  // like first sight forever and replay its whole backlog the moment it trades.
  return buys.filter((b) => b.blockTimeMs && b.blockTimeMs >= (cursor.t || 0));
}

// ── Rendering ────────────────────────────────────────────────────────────────

/** A row of emoji scaled to buy size — the classic buy-bot "hype meter". */
function buyEmojiRow(usd, glyph = "🟢") {
  const step = BUYBOT_EMOJI_STEP_USD;
  const n = Math.max(BUYBOT_EMOJI_MIN, Math.min(BUYBOT_EMOJI_MAX, Math.round(usd / step)));
  return glyph.repeat(n);
}

/**
 * The amount someone actually spent, in dollars they would recognise.
 *
 * NOT formatNumber(): that renders a $1,234 buy as "$1.2K", which is the right
 * call for a market cap and the wrong one here — the reader is about to open
 * the transaction and compare. Exact to the dollar up to seven figures, where
 * compact stops losing information anyone cares about.
 */
function usdAmount(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  if (abs >= 1e6) return "$" + (n / 1e6).toFixed(2) + "M";
  if (abs >= 1) return "$" + Math.round(n).toLocaleString("en-US");
  return "$" + n.toFixed(2);
}

/** The three tier labels, admin-editable, with FIELD-BY-FIELD fallback so a
 *  half-filled override still renders a card instead of a blank label. */
function buyTiers() {
  const parts = String(tpl.t("group_buy_tiers") || "").split("|");
  const d = ["New Buy", "Whale Buy", "Mega Buy"];
  return d.map((def, i) => (parts[i] || "").trim() || def);
}

const tierFor = (usd) => {
  const [normal, whale, mega] = buyTiers();
  if (usd >= BUYBOT_MEGA_USD) return mega;
  if (usd >= BUYBOT_WHALE_USD) return whale;
  return normal;
};

const tradeDeepLink = (chain, address) =>
  `https://t.me/${TRADEBOT_USERNAME}?start=ca_${String(chain).toLowerCase().replace(/[^a-z0-9]/g, "")}_${address}`;

/**
 * The "🔗 Txn · 👤 Buyer" row. Returns "" when the chain has no explorer we
 * know — a missing link must never cost the alert, and a bare hash rendered as
 * a relative URL is worse than no link at all.
 */
function verifyRow(chain, buy) {
  const tx = txUrl(chain, buy.txHash);
  const who = buy.buyer ? accountUrl(chain, buy.buyer) : null;
  const bits = [];
  // The hash and the buyer address come from a THIRD-PARTY feed, and this row
  // is premium markup — so a value containing ")" would close the link early
  // and let the rest inject arbitrary markup into the group's alert. Neither
  // field should ever contain one; that is exactly why it is worth spending a
  // function call on being sure.
  if (tx) bits.push(`🔗 [Txn](${premium.sanitizeUrl(tx)})`);
  if (who) bits.push(`👤 [${premium.sanitizeVar(shortAddress(buy.buyer))}](${premium.sanitizeUrl(who)})`);
  return bits.join(" · ");
}

function renderRealAlert(g, buy, pool) {
  const sym = String(g.sym || "").replace(/^\$/, "") || "TOKEN";
  const price = buy.tokenAmount > 0 ? buy.usd / buy.tokenAmount : pool && pool.priceUsd;
  const impact = pool && pool.liquidity > 0 ? (buy.usd / pool.liquidity) * 100 : null;
  return tpl.render("group_buy_alert", {
    emoji: buyEmojiRow(buy.usd),
    tier: tierFor(buy.usd),
    symbol: premium.sanitizeVar(`$${sym}`),
    usd: usdAmount(buy.usd),
    tokenAmt: formatNumber(buy.tokenAmount),
    price: price ? fmtPrice(price) : "—",
    mcap: pool && pool.mcap ? "$" + formatNumber(pool.mcap) : "—",
    liq: pool && pool.liquidity ? "$" + formatNumber(pool.liquidity) : "—",
    impact: impact != null ? `${impact < 1 ? impact.toFixed(2) : impact.toFixed(1)}%` : "—",
    change: (pool && fmtPct(pool.change24h)) || "—",
    chain: chainOf(g.chain)?.label || g.chain,
    verify: verifyRow(g.chain, buy),
    tradeUrl: premium.sanitizeUrl(tradeDeepLink(g.chain, g.address)),
    coinUrl: premium.sanitizeUrl(`${SITE_URL}/token/${g.chain}/${g.address}`),
  });
}

function renderEstimateAlert(g, est, pool) {
  const sym = String(g.sym || "").replace(/^\$/, "") || "TOKEN";
  const tokenAmt = pool && pool.priceUsd ? est.usd / pool.priceUsd : null;
  return tpl.render("group_buy_alert_est", {
    emoji: buyEmojiRow(est.usd),
    symbol: premium.sanitizeVar(`$${sym}`),
    usd: usdAmount(est.usd),
    count: est.count,
    buysWord: est.count === 1 ? "buy" : "buys",
    tokenAmt: tokenAmt ? formatNumber(tokenAmt) : "—",
    price: pool && pool.priceUsd ? fmtPrice(pool.priceUsd) : "—",
    mcap: pool && pool.mcap ? "$" + formatNumber(pool.mcap) : "—",
    chain: chainOf(g.chain)?.label || g.chain,
    tradeUrl: premium.sanitizeUrl(tradeDeepLink(g.chain, g.address)),
  });
}

// ── Delivery ─────────────────────────────────────────────────────────────────

/**
 * Send one alert, spending the dedupe budget ONLY if it actually lands.
 *
 * `dedupeId` is a transaction hash on the real path. On the estimated path
 * there is no hash — and no honest dedupe key either — so the caller passes
 * null and this claims nothing. That is not an oversight: a made-up key would
 * look like deduplication while deduplicating nothing.
 */
async function deliver(tg, chatId, payload, dedupeId) {
  if (dedupeId && !latch.claim(chatId, dedupeId)) return false;
  // Accepts a thunk so the caller can defer rendering until the claim is won.
  // With a `>=` block cursor a quiet pool re-reads its newest block on every
  // poll, so an already-delivered buy would otherwise be re-rendered for every
  // group, every 25 seconds, forever.
  const { text, extra } = payloadArgs(typeof payload === "function" ? payload() : payload, false);
  try {
    const sent = await tg.sendMessage(chatId, text, extra);
    if (!sent || !sent.message_id) {
      // Telegram answered without a message. Not delivered — so do NOT latch,
      // or this buy can never alert again in a group that never saw it.
      if (dedupeId) await latch.release(chatId, dedupeId);
      log.warn(`[buybot] alert to ${chatId} returned no message_id — not latched, will retry`);
      return false;
    }
    if (dedupeId) await latch.commit(chatId, dedupeId);
    return true;
  } catch (e) {
    if (isFatalChatError(e)) {
      // The bot is not in this chat, or may not speak in it. Latch anyway:
      // retrying every poll can never succeed and burns Telegram calls plus the
      // GeckoTerminal budget shared with every healthy group.
      if (dedupeId) await latch.commit(chatId, dedupeId);
      log.warn(
        `[buybot] ${chatId} is unreachable (${describeChatError(e)}) — alert dropped. ` +
          `Re-add the bot to that group, or run /buybot off there.`,
      );
      return false;
    }
    if (dedupeId) await latch.release(chatId, dedupeId);
    log.debug(`[buybot] post to ${chatId} failed (${e.message}) — claim released, will retry`);
    return false;
  }
}

// ── Polling ──────────────────────────────────────────────────────────────────

/** Groups that watch the same token share one pool read. */
function groupByPool(groups) {
  const byPool = new Map();
  for (const g of groups) {
    const key = poolKeyOf(g.chain, g.pairAddress || g.address);
    if (!byPool.has(key)) byPool.set(key, { key, chain: g.chain, address: g.address, pool: g.pairAddress || null, groups: [] });
    const entry = byPool.get(key);
    entry.groups.push(g);
    if (!entry.pool && g.pairAddress) entry.pool = g.pairAddress;
  }
  return [...byPool.values()];
}

function noteDeadPool(entry) {
  const last = deadLog[entry.key] || 0;
  if (now() - last <= 3_600_000) return;
  deadLog[entry.key] = now();
  log.warn(`[buybot] no pool data for ${entry.chain}/${entry.address} (${entry.groups.length} group(s))`);
}

/**
 * The REAL path. Returns true when it handled this pool (whether or not it
 * posted anything), false when the feed was unreadable and the caller should
 * fall back to the estimator.
 */
async function pollTrades(tg, entry) {
  const net = gt.networkOf(entry.chain);
  if (!net || !entry.pool) return false;

  const minUsd = Math.min(...entry.groups.map((g) => Number(g.minBuyUsd) || 0));
  const buys = await trades.fetchPoolBuys(net, entry.pool, entry.address, { minUsd }).catch(() => null);
  if (buys === null) return false; // unavailable — degrade

  // The feed works, so the volume baseline for this pool is going stale. Drop
  // it: if the feed later breaks and we fall back, a baseline from hours ago
  // would diff into one enormous phantom "buy". With no baseline the estimator
  // simply re-seeds and stays quiet for a poll.
  if (state.pools[entry.key]) {
    delete state.pools[entry.key];
    saveState();
  }

  const cursor = state.cursors[entry.key] || null;
  if (!buys.length) {
    // Still seed a cursor. Without one, an idle pool looks like first sight on
    // every poll and replays its entire backlog the moment it finally trades.
    if (!cursor) {
      state.cursors[entry.key] = { b: 0, t: now() };
      await saveState();
    }
    return true;
  }

  const fresh = selectFresh(cursor, buys);
  const newest = buys[buys.length - 1].blockNumber || 0;
  if (!fresh.length) {
    state.cursors[entry.key] = { b: newest, t: now() };
    await saveState();
    return true;
  }

  // Price / mcap / liquidity only DECORATE the alert, so they are fetched only
  // now — an idle pool costs exactly one GT request per poll, the trades read.
  const pool = await gt.fetchPoolCached(entry.chain, entry.address);
  if (!pool) {
    // HOLD the buys rather than drop them, and do NOT advance the cursor: they
    // are real, and the next poll can price them.
    log.debug(`[buybot] ${entry.key}: ${fresh.length} new buy(s) held — no pool metadata this cycle`);
    return true;
  }

  let posted = 0;
  // The lowest block still holding an undelivered buy. The cursor must not move
  // past it: a 429 on an OLDER buy while a NEWER one succeeds would otherwise
  // advance the cursor beyond the failure, and the retry that
  // alertLatch.release() exists to allow could never be selected again — the
  // alert is lost, silently, in a healthy group. Re-reading a few delivered
  // blocks costs nothing, because the latch skips them.
  let hold = null;
  for (const buy of fresh) {
    for (const g of entry.groups) {
      if (buy.usd < (Number(g.minBuyUsd) || 0)) continue; // each group's own threshold
      if (await deliver(tg, g.chatId, () => renderRealAlert(g, buy, pool), buy.txHash)) {
        posted++;
        continue;
      }
      // Not delivered AND not latched → still wanted. (A fatal chat error
      // latches, so a group that removed the bot never holds the cursor back.)
      if (!latch.isDelivered(g.chatId, buy.txHash) && buy.blockNumber) {
        hold = hold === null ? buy.blockNumber : Math.min(hold, buy.blockNumber);
      }
    }
  }
  state.cursors[entry.key] = { b: hold === null ? newest : hold, t: now() };
  await saveState();
  if (posted) {
    log.info(
      `[buybot] verified ${entry.chain} buys: feed=${buys.length} fresh=${fresh.length} posted=${posted} pool=${entry.pool}`,
    );
  }
  return true;
}

/** The DEGRADED path — volume-diff estimates, only when the feed is unreadable. */
async function pollEstimate(tg, entry, pool) {
  if (!pool) return;
  const prev = state.pools[entry.key];
  state.pools[entry.key] = {
    volume24h: pool.volume24h,
    buys24h: pool.buys24h,
    sells24h: pool.sells24h,
    source: pool.source,
    at: now(),
  };
  await saveState();

  const est = estimateBuys(prev, pool);
  if (!est) return;
  for (const g of entry.groups) {
    if (g.minBuyUsd && est.usd < g.minBuyUsd) continue;
    await deliver(tg, g.chatId, renderEstimateAlert(g, est, pool), null);
  }
  log.debug(`[buybot] volume-diff buy estimate for ${entry.key}: $${Math.round(est.usd)} over ${est.count}`);
}

async function pollPool(tg, entry) {
  // One read per pool per window, independent of how many groups watch it and
  // of how fast the outer loop runs. GT's free tier is ~30 requests/minute for
  // the whole process, shared with the listing and trending pipelines.
  const last = lastPoll.get(entry.key) || 0;
  if (now() - last < BUYBOT_POOL_MIN_MS) return;
  lastPoll.set(entry.key, now());

  // Self-heal ONLY a MISSING pool address. A transient GT/DS timeout looks
  // identical to a 404, so never repoint a pool an admin resolved just because
  // one poll produced a different (or no) result.
  if (!entry.pool) {
    const resolved = await gt.fetchPoolCached(entry.chain, entry.address);
    if (resolved && resolved.poolAddress) {
      entry.pool = resolved.poolAddress;
      for (const g of entry.groups) {
        if (!g.pairAddress) await cfg.upsert(g.chatId, { pairAddress: resolved.poolAddress });
      }
      log.info(`[buybot] self-healed pool for ${entry.chain}/${entry.address} → ${resolved.poolAddress}`);
    }
  }

  if (await pollTrades(tg, entry)) return;

  const pool = await gt.fetchPoolCached(entry.chain, entry.address).catch(() => null);
  if (!pool) return noteDeadPool(entry);
  await pollEstimate(tg, entry, pool);
}

async function scanOnce(tg) {
  for (const entry of groupByPool(cfg.active())) {
    await pollPool(tg, entry).catch((e) => log.debug(`[buybot] ${entry.key}: ${e.message}`));
    await sleep(300); // be polite to GT/DexScreener
  }
}

function start(tg) {
  // A scan that outruns its own interval must not stack: the pool throttle
  // would still bound the requests, but two scans interleaved would double
  // every claim/commit round trip for no benefit.
  let busy = false;
  const run = async () => {
    if (busy) return;
    busy = true;
    try {
      await scanOnce(tg);
    } catch (e) {
      log.debug(`[buybot] ${e.message}`);
    } finally {
      busy = false;
    }
  };
  const iv = setInterval(run, GROUP_BUYBOT_CHECK_MS);
  const kick = setTimeout(run, 25_000);
  return {
    stop: () => {
      clearInterval(iv);
      clearTimeout(kick);
    },
  };
}

module.exports = {
  start,
  scanOnce,
  estimateBuys,
  selectFresh,
  buyEmojiRow,
  buyTiers,
  tierFor,
  groupByPool,
  verifyRow,
  deliver,
  renderRealAlert,
  renderEstimateAlert,
  _pollTrades: pollTrades,
  FIRST_SIGHT_MS,
  FIRST_SIGHT_MAX,
  _state: state,
};
