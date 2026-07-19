// Group buy-bot monitor. Polls each active group's token pool and posts a buy
// alert when new buy transactions appear since the last poll. Because the free
// GT/DexScreener REST APIs give no per-transaction feed (only rolling 24h
// aggregates), buy amounts are ESTIMATES derived from the volume + tx-count
// delta between polls — no tx-hash or buyer links (same limitation fourtis
// documents for every non-Solana chain). Honest copy: "≈ $X".
//
// Lessons carried from fourtis (don't regress):
//  - Always resolve the pool on the token's OWN chain (gtPairs), never match a
//    pool by address across chains.
//  - GT-primary chains (robinhood/plasma) are queried via GT, never DexScreener.
//  - Self-heal a missing pairAddress by re-resolving and persisting it.
//  - Dead pools log once/hour instead of failing silently.
const { GROUP_BUYBOT_CHECK_MS, CHANNELS } = require("../config/constants");
const cfg = require("./config");
const gt = require("./gtPairs");
const tpl = require("../templates");
const { payloadArgs } = require("../helpers/message");
const { fmtPrice, formatNumber } = require("../helpers/format");
const { chainOf } = require("../config/chains");
const premium = require("../premium");
const { loadJSONSync, saveJSON } = require("../helpers/persist");
const log = require("../helpers/logger");

const STATE_FILE = "buybot.json";
// { [chatId]: { volume24h, buys24h, sells24h, at } }
const state = loadJSONSync(STATE_FILE, {});
const deadLog = {}; // chatId → last dead-pool log ts (throttle to 1/hour)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Date.now();

/**
 * Estimate the buys that happened between two pool snapshots.
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

async function pollGroup(tg, g) {
  let pool = await gt.fetchPool(g.chain, g.address).catch(() => null);
  // self-heal ONLY a MISSING pool address — a transient GT/DS timeout looks
  // identical to a 404, so never repoint an admin-resolved pool just because a
  // single poll produced a different (or no) result (fourtis lesson).
  if (pool && pool.poolAddress && !g.pairAddress) {
    await cfg.upsert(g.chatId, { pairAddress: pool.poolAddress });
  }
  if (!pool) {
    const last = deadLog[g.chatId] || 0;
    if (now() - last > 3_600_000) {
      deadLog[g.chatId] = now();
      log.warn(`[buybot] no pool data for ${g.chain}/${g.address} (chat ${g.chatId})`);
    }
    return;
  }

  const prev = state[g.chatId];
  state[g.chatId] = { volume24h: pool.volume24h, buys24h: pool.buys24h, sells24h: pool.sells24h, source: pool.source, at: now() };
  await saveJSON(STATE_FILE, state).catch(() => {});

  const est = estimateBuys(prev, pool);
  if (!est) return;
  if (g.minBuyUsd && est.usd < g.minBuyUsd) return; // below the group's threshold

  const sym = String(g.sym || "").replace(/^\$/, "") || "TOKEN";
  const tokenAmt = pool.priceUsd ? est.usd / pool.priceUsd : null;
  const payload = tpl.render("group_buy_alert", {
    symbol: premium.sanitizeVar(`$${sym}`),
    usd: "$" + formatNumber(est.usd),
    count: est.count,
    buysWord: est.count === 1 ? "buy" : "buys",
    tokenAmt: tokenAmt ? formatNumber(tokenAmt) : "—",
    price: pool.priceUsd ? fmtPrice(pool.priceUsd) : "—",
    mcap: pool.mcap ? "$" + formatNumber(pool.mcap) : "—",
    chain: chainOf(g.chain)?.label || g.chain,
    emoji: buyEmojiRow(est.usd),
  });
  const { text, extra } = payloadArgs(payload, false);
  try {
    await tg.sendMessage(g.chatId, text, extra);
  } catch (e) {
    log.debug(`[buybot] post to ${g.chatId} failed: ${e.message}`);
  }
}

// A row of emoji scaled to buy size — the classic buy-bot "hype meter".
function buyEmojiRow(usd) {
  const n = Math.max(1, Math.min(60, Math.round(usd / 25))); // 1 emoji per ~$25, capped
  return "🟢".repeat(n);
}

async function scanOnce(tg) {
  const groups = cfg.active();
  for (const g of groups) {
    await pollGroup(tg, g).catch((e) => log.debug(`[buybot] ${g.chatId}: ${e.message}`));
    await sleep(300); // be polite to GT/DexScreener
  }
}

function start(tg) {
  const run = () => scanOnce(tg).catch((e) => log.debug(`[buybot] ${e.message}`));
  const iv = setInterval(run, GROUP_BUYBOT_CHECK_MS);
  const kick = setTimeout(run, 25_000);
  return {
    stop: () => {
      clearInterval(iv);
      clearTimeout(kick);
    },
  };
}

module.exports = { start, scanOnce, estimateBuys, buyEmojiRow };
