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
  BUYBOT_PIN_WHALES,
  TRADEBOT_USERNAME,
  SITE_URL,
} = require("../config/constants");
const cfg = require("./config");
const whaleCfg = require("../services/whaleConfig");
const gt = require("./gtPairs");
const trades = require("./gtTrades");
const holdings = require("./walletHoldings");
const latch = require("./alertLatch");
const { isFatalChatError, describeChatError } = require("./fatalChatError");
const tpl = require("../templates");
const { payloadArgs } = require("../helpers/message");
const { fmtPrice, formatNumber, fmtPct, trimAmount } = require("../helpers/format");
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
  if (!raw || raw.v !== STATE_VERSION) return { v: STATE_VERSION, pools: {}, cursors: {}, pins: {} };
  return { v: STATE_VERSION, pools: raw.pools || {}, cursors: raw.cursors || {}, pins: raw.pins || {} };
}
const state = loadState();
const saveState = () => saveJSON(STATE_FILE, state).catch(() => {});

const deadLog = {}; // poolKey → last dead-pool log ts (throttle to 1/hour)
const pinWarned = new Set(); // chatIds already told they haven't granted "Pin messages"
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

// The same protection, for every poll AFTER the first — because the cursor is
// only advanced by a SUCCESSFUL poll, so it sits still through a GT outage, a
// metadata hold, or the process being down. On the first poll that works again
// the feed still hands back its full 24h, and without these two bounds all of
// it posts back-to-back: hours-old buys announced as if they had just happened,
// which then trips Telegram's flood limit and turns into a retry storm.
//
// A buy older than this is not news, so it is dropped rather than queued.
const MAX_ALERT_AGE_MS = 30 * 60 * 1000;
// A genuine burst is paced instead of dropped: the cursor stops at the last one
// posted, so the rest arrive on the next poll.
const MAX_PER_POLL = 8;

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
  const after = cursor.b > 0
    ? buys.filter((b) => b.blockNumber >= cursor.b)
    // Seeded on an empty feed: there is no block to compare against, so judge
    // by time. Without this, a pool that was idle when we first saw it would
    // look like first sight forever and replay its backlog the moment it trades.
    : buys.filter((b) => b.blockTimeMs && b.blockTimeMs >= (cursor.t || 0));

  return after
    // Anything the ESTIMATOR already announced during an outage. Without this
    // the group hears about the same money twice — once as "≈ $3,000 over 4
    // buys" while the feed was down, then again as four verified alerts when it
    // came back. The per-tx latch cannot help: an estimate has no tx to latch.
    .filter((b) => !cursor.e || !b.blockTimeMs || b.blockTimeMs > cursor.e)
    .filter((b) => !b.blockTimeMs || b.blockTimeMs >= at - MAX_ALERT_AGE_MS)
    .slice(0, MAX_PER_POLL); // oldest first, so a burst is paced in order
}

// ── Rendering ────────────────────────────────────────────────────────────────

/**
 * The size row: one icon per BUYBOT_EMOJI_STEP_USD, floored and capped.
 *
 * It only ever GROWS — that is the whole reason it is a row and not a
 * fill-meter. A meter renders what is missing, so a real buy comes out mostly
 * empty and reads as something failing rather than something good happening.
 */
function buyEmojiRow(usd, glyph) {
  const icon = glyph || buyBarStyle()[0];
  const step = BUYBOT_EMOJI_STEP_USD;
  const n = Math.max(BUYBOT_EMOJI_MIN, Math.min(BUYBOT_EMOJI_MAX, Math.round(usd / step)));
  return icon.repeat(n);
}

const BAR_WIDTH = 10;
const BAR_DEFAULT = ["🟢", "🐋"];

/** The row's two icons — normal buy | whale — falling back per position so a
 *  half-written override still renders a row rather than nothing. */
function buyBarStyle() {
  let raw = "";
  try {
    raw = String(tpl.t("group_buy_style") || "");
  } catch {
    return BAR_DEFAULT.slice();
  }
  const parts = raw.split("|").map((s) => s.trim());
  return BAR_DEFAULT.map((d, i) => parts[i] || d);
}

/**
 * A fill-meter, kept as the optional {bar} placeholder. NOT the default, and
 * that is deliberate: a meter renders the part that is MISSING, so a real buy
 * shows up mostly empty and reads as something failing rather than something
 * good happening. The row above only ever grows. Use this only if you actually
 * want progress-toward-mega semantics.
 */
function buySizeBar(usd) {
  const [on] = buyBarStyle();
  const frac = Math.max(0, Math.min(1, Number(usd) / BUYBOT_MEGA_USD));
  const filled = Math.max(usd > 0 ? 1 : 0, Math.round(frac * BAR_WIDTH));
  return on.repeat(filled) + "▱".repeat(BAR_WIDTH - filled);
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
  // Cents matter at the sizes most buys actually are — "$49" for a $48.97 buy
  // reads as a rounded guess sitting directly above a link to the transaction
  // that says otherwise. Whole dollars only once the cents stop mattering.
  if (abs >= 1000) return "$" + Math.round(n).toLocaleString("en-US");
  return "$" + n.toFixed(2);
}

/**
 * A token amount in full, with separators — "926,311.94".
 *
 * NOT the compact form used for market cap: "926.3K $RUSS" hides how many
 * tokens someone actually received, and this line sits beside a transaction
 * link that shows the exact figure.
 */
function tokenAmount(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return "—";
  if (n >= 1e12) return formatNumber(n); // beyond readable — compact it
  return n.toLocaleString("en-US", { maximumFractionDigits: n >= 1 ? 2 : 8 });
}

/** The three tier labels, admin-editable, with FIELD-BY-FIELD fallback so a
 *  half-filled override still renders a card instead of a blank label. */
function buyTiers() {
  const parts = String(tpl.t("group_buy_tiers") || "").split("|");
  const d = ["NEW BUY", "WHALE BUY", "MEGA BUY"];
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
/**
 * What the buyer actually SPENT, in the coin they spent it in — "(0.6646 SOL)".
 *
 * Taken from the trade's own from-token amount, NOT derived as usd/nativePrice.
 * A derived figure is invented precision: it disagrees with the explorer the
 * line right below it links to, and it silently absorbs any error in whichever
 * price feed answered. Rendered only when the pool's other side really is what
 * was paid with, and dropped entirely for a routed swap whose legs paid in
 * different tokens.
 */
function spentNative(buy, pool) {
  if (!pool || !buy || !(buy.spentAmount > 0) || !buy.spentToken) return "";
  if (!pool.counterSymbol || !gt.sameToken(buy.spentToken, pool.counterAddress)) return "";
  return ` (${trimAmount(Number(buy.spentAmount.toFixed(6)))} ${pool.counterSymbol})`;
}

function verifyRow(chain, buy) {
  const tx = txUrl(chain, buy.txHash);
  const who = buy.buyer ? accountUrl(chain, buy.buyer) : null;
  const bits = [];
  // The hash and the buyer address come from a THIRD-PARTY feed, and this row
  // is premium markup — so a value containing ")" would close the link early
  // and let the rest inject arbitrary markup into the group's alert. Neither
  // field should ever contain one; that is exactly why it is worth spending a
  // function call on being sure.
  // Buyer first, then the transaction: who, then the proof.
  //
  // The 👤 lives HERE rather than in the template so the whole line can vanish
  // on a chain we have no explorer for and no buyer address — a lone "👤" with
  // nothing after it is not a row, it is a rendering bug.
  if (who) bits.push(`[${premium.sanitizeVar(shortAddress(buy.buyer))}](${premium.sanitizeUrl(who)})`);
  else if (buy.buyer) bits.push(premium.sanitizeVar(shortAddress(buy.buyer)));
  if (tx) bits.push(`[View txn](${premium.sanitizeUrl(tx)})`);
  return bits.length ? `👤 **Buyer:** ${bits.join(" · ")}` : "";
}

/**
 * The buyer's own position in the token, directly under the buyer's address —
 * "💼 **Position:** 1,980,000 $RUSS · $95,523 (+3.82%)".
 *
 * Three facts in one row: how much of the token that wallet holds AFTER this
 * trade, what it is worth at the pool price, and how much this buy grew it. A
 * first-ever buy reads "(new position)" rather than an invented +100%.
 *
 * Returns "" — the whole row, emoji and label included — whenever the holding
 * could not be read: an unsupported chain, an RPC that did not answer, a buy
 * under the dust floor, or a group that turned holdings off. Same rule as
 * verifyRow above: a label with a dash after it is not a row, it is a rendering
 * bug, and the buy is worth alerting either way.
 */
function positionRow(g, pos) {
  if (!pos || !(pos.held > 0)) return "";
  const sym = premium.sanitizeVar(`$${String(g.sym || "").replace(/^\$/, "") || "TOKEN"}`);
  return `💼 **Bag:** ${tokenAmount(pos.held)} ${sym} · ${usdAmount(pos.holdsUsd)} (${pos.position})`;
}

/** Every value both buy cards share. Split out so the whale card cannot drift
 *  away from the ordinary one — the two are the same event, told differently.
 *  `pos` is the buyer's holding when it could be read, null otherwise. */
function alertVars(g, buy, pool, pos) {
  const sym = String(g.sym || "").replace(/^\$/, "") || "TOKEN";
  const price = (pool && pool.priceUsd) || (buy.tokenAmount > 0 ? buy.usd / buy.tokenAmount : null);
  const impact = pool && pool.liquidity > 0 ? (buy.usd / pool.liquidity) * 100 : null;
  return {
    bar: buySizeBar(buy.usd),
    emoji: buyEmojiRow(buy.usd),
    // The token's own name headlines the card. It is admin-supplied via
    // GeckoTerminal, so it goes through the same sanitiser as every other
    // untrusted value — a token literally named "[click](url)" is not far-fetched.
    name: premium.sanitizeVar(g.name || `$${sym}`),
    // The tier IS the header label — "NEW BUY" / "WHALE BUY" / "MEGA BUY" —
    // rather than a suffix bolted onto a fixed one, which read as two headings
    // fighting for the same line.
    tier: tierFor(buy.usd),
    native: spentNative(buy, pool),
    symbol: premium.sanitizeVar(`$${sym}`),
    usd: usdAmount(buy.usd),
    tokenAmt: tokenAmount(buy.tokenAmount),
    // The POOL's price, not the trade's effective one. They differ by fees and
    // slippage, and this figure sits next to the market cap — the two have to
    // come from the same place or the card contradicts itself.
    price: price ? fmtPrice(price) : "—",
    mcap: pool && pool.mcap ? "$" + formatNumber(pool.mcap) : "—",
    liq: pool && pool.liquidity ? "$" + formatNumber(pool.liquidity) : "—",
    impact: impact != null ? `${impact < 1 ? impact.toFixed(2) : impact.toFixed(1)}%` : "—",
    change: (pool && fmtPct(pool.change24h)) || "—",
    chain: chainOf(g.chain)?.label || g.chain,
    verify: verifyRow(g.chain, buy),
    // The prebuilt row, and its three parts on their own so an admin can lay
    // them out differently. All EMPTY rather than "—" when the holding could not
    // be read: a custom row built from them then collapses to nothing, which is
    // what the reader should see, instead of three dashes that look like a
    // wallet holding nothing.
    wallet: positionRow(g, pos),
    holds: pos ? tokenAmount(pos.held) : "",
    holdsUsd: pos ? usdAmount(pos.holdsUsd) : "",
    position: pos ? pos.position : "",
    tradeUrl: premium.sanitizeUrl(tradeDeepLink(g.chain, g.address)),
    coinUrl: premium.sanitizeUrl(`${SITE_URL}/token/${g.chain}/${g.address}`),
  };
}

const renderRealAlert = (g, buy, pool, pos) => tpl.render("group_buy_alert", alertVars(g, buy, pool, pos));

/**
 * The bar a group judges a holding against: its own `/setwhale`, else the
 * global one an operator set in @dexvraadminbot, else what .env ships.
 *
 * Read fresh, per group. Two groups can watch the SAME pool with different
 * bars, so this is deliberately not resolved once per buy alongside the holding.
 */
function whaleBarFor(g) {
  const own = Number(g && g.whaleWalletUsd);
  return own > 0 ? own : whaleCfg.get().walletUsd;
}

/**
 * What this buyer ALREADY HOLDS of the token — the enrichment BOTH cards use:
 * the whale verdict below, and the 💼 Position row on every ordinary buy.
 *
 * Returns null when we could not tell, which is never a reason to withhold the
 * buy — the caller renders the card without the row. One RPC call, gated behind
 * the dust floor and cached per wallet upstream.
 *
 * `whales: false` / the global off switch gate this because reading the holding
 * IS the cost of both features: one lever, not two. A group that opted out of
 * whale alerts is not billed an RPC call to decorate its ordinary ones.
 */
async function buyerPosition(g, buy, pool) {
  const wc = whaleCfg.get();
  if (!wc.enabled || g.whales === false) return null;
  if (!buy.buyer || !pool || !(pool.priceUsd > 0)) return null;
  if (buy.usd < wc.minBuyUsd) return null; // dust does not order an RPC call
  if (!holdings.supports(g.chain)) return null;

  const held = await holdings.holdingOf(g.chain, g.address, buy.buyer);
  if (held == null || !(held > 0)) return null;
  // How much this buy GREW the bag. `held` is the balance after the trade, so
  // the position before it is held - bought; a first-ever buy has no "before",
  // and calling that +∞ or +100% would both be inventions.
  const before = held - (buy.tokenAmount || 0);
  const position = before > 0 ? `+${((buy.tokenAmount / before) * 100).toFixed(2)}%` : "new position";
  return { held, holdsUsd: held * pool.priceUsd, position };
}

/**
 * Is this buyer a whale — by what they HOLD, not by what they just spent?
 *
 * Returns the enrichment the whale card needs, or null when they are not one /
 * we could not tell. Failing to read a holding is never a reason to withhold
 * the buy: the caller falls back to the ordinary alert.
 */
async function whaleCheck(g, buy, pool) {
  const pos = await buyerPosition(g, buy, pool);
  if (!pos) return null;
  // The bar this wallet actually cleared, carried through to the card. Without
  // it the template can only hardcode a number, which goes stale the moment an
  // operator retunes the threshold or a group sets its own.
  const threshold = whaleBarFor(g);
  return pos.holdsUsd >= threshold ? { ...pos, threshold } : null;
}

function renderWhaleAlert(g, buy, pool, whale) {
  const base = alertVars(g, buy, pool, whale);
  return tpl.render("group_whale_alert", {
    ...base,
    // Its own icon, so a whale reads as a whale at a glance in a scrolling chat.
    emoji: buyEmojiRow(buy.usd, buyBarStyle()[1]),
    holds: tokenAmount(whale.held),
    holdsUsd: usdAmount(whale.holdsUsd),
    position: whale.position,
    // The bar this wallet cleared — the group's own /setwhale, else the global
    // one set in @dexvraadminbot. Never a literal in the copy: it would go stale
    // the moment either is retuned, and a card that states the wrong entry
    // condition is worse than one that states none.
    whaleBar: whale.threshold > 0 ? usdAmount(whale.threshold) : "—",
  });
}

function renderEstimateAlert(g, est, pool) {
  const sym = String(g.sym || "").replace(/^\$/, "") || "TOKEN";
  const tokenAmt = pool && pool.priceUsd ? est.usd / pool.priceUsd : null;
  return tpl.render("group_buy_alert_est", {
    bar: buySizeBar(est.usd),
    emoji: buyEmojiRow(est.usd),
    symbol: premium.sanitizeVar(`$${sym}`),
    usd: usdAmount(est.usd),
    count: est.count,
    buysWord: est.count === 1 ? "buy" : "buys",
    // COMPACT here, unlike the verified card. "≈ 13,269,749.12" is false
    // precision: the whole figure is derived from a volume delta, and printing
    // it to the cent claims an accuracy this path does not have.
    tokenAmt: tokenAmt ? formatNumber(tokenAmt) : "—",
    price: pool && pool.priceUsd ? fmtPrice(pool.priceUsd) : "—",
    mcap: pool && pool.mcap ? "$" + formatNumber(pool.mcap) : "—",
    chain: chainOf(g.chain)?.label || g.chain,
    tradeUrl: premium.sanitizeUrl(tradeDeepLink(g.chain, g.address)),
    coinUrl: premium.sanitizeUrl(`${SITE_URL}/token/${g.chain}/${g.address}`),
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
/**
 * The GIF/video an admin uploaded in @dexvraadminbot → 🎨 Gambar Banner Channel.
 * One clip per kind, shared by every group, played above the alert with the
 * transaction details as its caption.
 *
 * Resolved per send rather than cached, because `mediaOverride` is a stat() of
 * one path and an admin swapping the clip has to take effect immediately — the
 * whole point of editing it at runtime. Nothing here can fail the alert: no
 * clip, or a clip Telegram rejects, falls back to the plain text card.
 */
const DEFAULT_CLIP_KIND = "default";

function buyClip(kind = "buy") {
  try {
    const bt = require("../bannerTemplate");
    const own = bt.mediaOverride(kind);
    if (own) return own;
    // The one FALLBACK slot — ⭐ Default GIF in the admin menu — and the only
    // one there is. A kind still never borrows ANOTHER kind's clip: whale does
    // not play the buy clip and buy does not play the whale clip. That rule is
    // what makes two uploads worth making, because the operator uploads them
    // precisely so a whale LOOKS different scrolling past, and cross-borrowing
    // would give both alerts identical artwork with only the wording changed.
    //
    // A shared default is a different thing: it is house artwork the operator
    // chose ONCE for "anything I haven't dressed individually", so an operator
    // who wants one clip everywhere uploads it once instead of twice, and every
    // alert has artwork out of the box. Leave it empty and behaviour is exactly
    // what it was — the alert posts as plain text.
    if (kind === DEFAULT_CLIP_KIND) return null; // already looked; don't ask twice
    return bt.mediaOverride(DEFAULT_CLIP_KIND);
  } catch {
    return null;
  }
}

async function sendAlert(tg, chatId, text, extra, kind = "buy") {
  const clip = buyClip(kind);
  if (clip) {
    // caption_entities, not entities — a caption carries its formatting under a
    // different key, and sending the wrong one drops every link silently.
    const caption = { caption: text, ...extra };
    if (extra.entities) {
      caption.caption_entities = extra.entities;
      delete caption.entities;
    }
    try {
      const send = clip.type === "video" ? tg.sendVideo : tg.sendAnimation;
      return await send.call(tg, chatId, { source: clip.source }, caption);
    } catch (e) {
      // A rejected clip must cost the ARTWORK, never the alert.
      log.warn(`[buybot] buy clip failed for ${chatId} (${e.message}) — sending the alert as text`);
    }
  }
  return tg.sendMessage(chatId, text, extra);
}

/**
 * Pin a whale alert, replacing the previous one.
 *
 * Unpinning the last one first is what keeps this a HIGHLIGHT: without it every
 * whale of the day accumulates in the group's pinned list, and a pin that is
 * one of thirty is not a pin. Needs "Pin messages"; a group that has not given
 * it is told once, not once per whale.
 */
async function pinAlert(tg, chatId, messageId) {
  const prev = state.pins[String(chatId)];
  try {
    await tg.pinChatMessage(chatId, messageId, { disable_notification: false });
  } catch (e) {
    if (!pinWarned.has(String(chatId))) {
      pinWarned.add(String(chatId));
      log.warn(
        `[buybot] can't pin the whale alert in ${chatId} (${e.message}) — ` +
          `give the bot "Pin messages" there, or turn it off with /buybot pin off`,
      );
    }
    return false;
  }
  if (prev && prev !== messageId) await tg.unpinChatMessage(chatId, prev).catch(() => {});
  state.pins[String(chatId)] = messageId;
  await saveState();
  return true;
}

async function deliver(tg, chatId, payload, dedupeId, opts = {}) {
  // Checked FIRST, and independently of dedupeId, because the estimated path
  // has no transaction to latch — without this a group that removed the bot is
  // retried on every poll forever whenever the feed happens to be down.
  if (latch.isChatMuted(chatId)) return false;
  if (dedupeId && !latch.claim(chatId, dedupeId)) return false;
  // Accepts a thunk so the caller can defer rendering until the claim is won.
  // With a `>=` block cursor a quiet pool re-reads its newest block on every
  // poll, so an already-delivered buy would otherwise be re-rendered for every
  // group, every 25 seconds, forever.
  const { text, extra } = payloadArgs(typeof payload === "function" ? payload() : payload, false);
  try {
    const sent = await sendAlert(tg, chatId, text, extra, opts.kind);
    if (!sent || !sent.message_id) {
      // Telegram answered without a message. Not delivered — so do NOT latch,
      // or this buy can never alert again in a group that never saw it.
      if (dedupeId) await latch.release(chatId, dedupeId);
      log.warn(`[buybot] alert to ${chatId} returned no message_id — not latched, will retry`);
      return false;
    }
    if (dedupeId) await latch.commit(chatId, dedupeId);
    // AFTER the latch, never before: a pin that throws must not undo a delivery
    // that succeeded, and the alert is the product — the pin is a nicety.
    if (opts.pin) await pinAlert(tg, chatId, sent.message_id).catch(() => {});
    return true;
  } catch (e) {
    if (isFatalChatError(e)) {
      // The bot is not in this chat, or may not speak in it. Mute the whole
      // chat: retrying can never succeed and burns Telegram calls plus the
      // GeckoTerminal budget shared with every healthy group. Muting the CHAT
      // rather than the transaction is what makes this work on the estimated
      // path too, where there is no transaction.
      if (dedupeId) await latch.commit(chatId, dedupeId);
      await latch.muteChat(chatId);
      log.warn(
        `[buybot] ${chatId} is unreachable (${describeChatError(e)}) — alerts paused for that group. ` +
          `Re-add the bot there, or run /buybot off.`,
      );
      return false;
    }
    if (dedupeId) {
      const attempts = await latch.release(chatId, dedupeId);
      if (attempts >= latch.MAX_ATTEMPTS) {
        // Permanent for the MESSAGE but not for the chat — an empty saved
        // template, or one whose HTML will not parse. Retrying is doomed, and
        // an undelivered buy holds the pool cursor back, so persisting here
        // would silence the group entirely.
        await latch.commit(chatId, dedupeId);
        log.warn(
          `[buybot] giving up on one alert for ${chatId} after ${attempts} attempts: ${e.message}. ` +
            `If this repeats, check the group_buy_alert template in @dexvraadminbot.`,
        );
        return false;
      }
    }
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
    // Carry `e` forward. Dropping it here was a one-buy leak in the estimator
    // watermark: the poll that filters everything out advanced the cursor with
    // no watermark, so the NEXT poll re-selected the newest block unfiltered —
    // and an estimate claims no latch, so that buy posted as a verified alert
    // after the group had already been told about it.
    state.cursors[entry.key] = { b: newest, t: now(), e: (cursor && cursor.e) || 0 };
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
    // Resolved ONCE per buy, not per group: the holding is a property of the
    // WALLET and the token, and several groups can track the same token — but
    // it is looked up on behalf of a group that actually wants it, so one group
    // running /setwhale off cannot suppress the lookup for the others sharing
    // this pool.
    const wants = entry.groups.find((x) => x.whales !== false) || entry.groups[0];
    const pos = await buyerPosition(wants, buy, pool).catch(() => null);
    for (const g of entry.groups) {
      if (buy.usd < (Number(g.minBuyUsd) || 0)) continue; // each group's own threshold
      // A group that turned holdings off gets neither the whale card nor the
      // 💼 Position row, even though a neighbour paid for the lookup.
      const gPos = g.whales === false ? null : pos;
      // The BAR is per group. Resolving the verdict once for everyone was
      // wrong the moment two groups on the same pool set different bars: the
      // second group got the first group's answer.
      const whale = gPos && gPos.holdsUsd >= whaleBarFor(g) ? { ...gPos, threshold: whaleBarFor(g) } : null;
      const isWhale = !!whale;
      const render = () => (isWhale ? renderWhaleAlert(g, buy, pool, whale) : renderRealAlert(g, buy, pool, gPos));
      const opts = { kind: isWhale ? "whale" : "buy", pin: isWhale && g.pin !== false && BUYBOT_PIN_WHALES };
      if (await deliver(tg, g.chatId, render, buy.txHash, opts)) {
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
  // Where the cursor lands, in order of precedence:
  //   hold      — an undelivered buy still needs retrying (see above)
  //   lastSent  — the batch was capped, so the rest come next poll
  //   newest    — everything in the feed is accounted for
  const lastSent = fresh[fresh.length - 1].blockNumber || 0;
  const capped = fresh.length === MAX_PER_POLL && lastSent < newest;
  const cursorBlock = hold !== null ? hold : capped ? lastSent : newest;
  state.cursors[entry.key] = { b: cursorBlock, t: now(), e: (cursor && cursor.e) || 0 };
  await saveState();
  if (capped) log.info(`[buybot] ${entry.key}: paced — more buys queued for the next poll`);
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
    await deliver(tg, g.chatId, () => renderEstimateAlert(g, est, pool), null);
  }
  // Mark everything up to now as already announced, so the real path does not
  // re-tell the group about the same money when the feed comes back. An
  // estimate carries no tx hash, so the latch cannot do this for us.
  const cur = state.cursors[entry.key] || { b: 0, t: now() };
  state.cursors[entry.key] = { ...cur, e: now() };
  await saveState();
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
  const needsLabel = entry.groups.some((g) => !g.sym || !g.name);
  if (!entry.pool || needsLabel) {
    const resolved = await gt.fetchPoolCached(entry.chain, entry.address);
    if (resolved && resolved.poolAddress) {
      if (!entry.pool) entry.pool = resolved.poolAddress;
      // The NAME needs its own lookup, so it is only made when something is
      // actually missing — never on the hot path.
      const info = needsLabel ? await gt.fetchTokenInfo(entry.chain, entry.address).catch(() => null) : null;
      for (const g of entry.groups) {
        const patch = {};
        if (!g.pairAddress) patch.pairAddress = resolved.poolAddress;
        // Backfills groups configured before these were captured, which would
        // otherwise be stuck reading "$TOKEN" forever.
        const sym = (info && info.symbol) || resolved.symbol;
        const name = (info && info.name) || resolved.name;
        if (!g.sym && sym) patch.sym = sym;
        if (!g.name && name) patch.name = name;
        if (Object.keys(patch).length) {
          Object.assign(g, patch);
          await cfg.upsert(g.chatId, patch);
        }
      }
      log.info(`[buybot] self-healed ${entry.chain}/${entry.address} → pool ${resolved.poolAddress} ${resolved.symbol || ""}`);
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
  buySizeBar,
  buyBarStyle,
  buyTiers,
  tierFor,
  groupByPool,
  verifyRow,
  spentNative,
  pinAlert,
  alertVars,
  positionRow,
  buyerPosition,
  whaleBarFor,
  whaleCheck,
  renderWhaleAlert,
  buyClip,
  DEFAULT_CLIP_KIND,
  sendAlert,
  deliver,
  renderRealAlert,
  renderEstimateAlert,
  _pollTrades: pollTrades,
  FIRST_SIGHT_MS,
  FIRST_SIGHT_MAX,
  _state: state,
};
