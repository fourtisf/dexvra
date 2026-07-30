// Maintains a single "Dexvra Trending" message in @dexvratrending, edited in
// place (no new-post spam / no visible minute pattern). Persists the message id
// so a restart re-edits the same message. Skips when the text is unchanged.
const { TRENDING_POST_MS, CHANNELS, SITE_URL } = require("../config/constants");
const api = require("../api/dexvra");
const { chainOf, CHAIN_ORDER } = require("../config/chains");
const { tierRank } = require("../config/packages");
const { fetchMarket } = require("../marketdata");
const board = require("./trendingBoard");
const gramjs = require("../gramjs");
const premium = require("../premium");
const { loadJSONSync, saveJSON } = require("../helpers/persist");
const log = require("../helpers/logger");

const STATE_FILE = "trendpost.json";
const MAX_PER_CHAIN = 10;
// lastMode = how the last successful post RENDERED ("premium" = custom-emoji
// entities went out via the premium account, "plain" = unicode fallbacks). It's
// part of the skip check: without it a board whose text never changes would stay
// stuck on unicode forever after the premium account finally came online.
let state = loadJSONSync(STATE_FILE, { messageId: null, lastText: null, lastMode: null });

// After Telegram REFUSES our custom emoji (account isn't Premium / dead emoji
// id) stop paying for the doomed premium attempt for a while. It expires on its
// own, so the board upgrades itself once the account is fixed — no restart.
const PREMIUM_RETRY_MS = 30 * 60 * 1000;
let premiumBlockedUntil = 0;
// This loop runs every few minutes — warn at most hourly per distinct reason.
const warnedAt = new Map();
function warnOnce(key, msg) {
  const now = Date.now();
  if (now - (warnedAt.get(key) || 0) < 60 * 60 * 1000) return;
  warnedAt.set(key, now);
  log.warn(msg);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Board priority: paid tier first (Diamond=1 … Bronze=5), then Xpress/none last.
const tierPrio = (tier) => {
  const r = tierRank(tier);
  return r > 0 ? r : 99;
};
// Full comma number + "$" (fourtis style: 23,868,066$).
const mcapStr = (n) => (Number.isFinite(n) && n > 0 ? `${Math.round(n).toLocaleString("en-US")}$` : "");
// Last line of defence before a number reaches a PINNED public board. A six-
// digit percentage is always broken upstream data (a pool created hours ago
// measured against a near-zero opening tick) — printing nothing is honest,
// printing "+521366.00%" is not. marketdata.js filters these at the source;
// this is here because the board is what subscribers actually read.
const SANE_PCT = 5000;
const pctStr = (n) =>
  Number.isFinite(n) && Math.abs(n) <= SANE_PCT ? `${n >= 0 ? "+" : ""}${n.toFixed(2)}%` : "";
// Normalize a token's Telegram (handle / t.me / full url) into a t.me URL, or null.
function tgUrl(tg) {
  if (!tg) return null;
  let s = String(tg).trim();
  if (/^https?:\/\//i.test(s)) return s;
  s = s.replace(/^@/, "").replace(/^t\.me\//i, "");
  return s ? `https://t.me/${s}` : null;
}
// Normalize a token's X/Twitter (handle / url) into an x.com URL, or null.
function xUrl(x) {
  if (!x) return null;
  let s = String(x).trim();
  if (/^https?:\/\//i.test(s)) return s;
  s = s.replace(/^@/, "").replace(/^(x\.com|twitter\.com)\//i, "");
  return s ? `https://x.com/${s}` : null;
}
// Normalize a website (bare domain or url) into an absolute URL, or null.
function webUrl(w) {
  if (!w) return null;
  const s = String(w).trim();
  if (/^https?:\/\//i.test(s)) return s;
  return s.includes(".") ? `https://${s}` : null;
}

// The board is built in PREMIUM MARKUP (**bold**, [text](url), and rank/logo
// fragments that may be premium-emoji markup "[🥇](emoji/ID)"). premium.parse()
// turns it into {text, entities} — the ONLY way custom (premium) emoji render,
// sent by the GramJS premium account. Dynamic text/urls are sanitized so a
// token symbol or link can't break the [..](..) / [..](emoji/id) markup.
const mkText = (s) => String(s == null ? "" : s).replace(/[[\]()`*]/g, "").replace(/\s+/g, " ").trim();
const mkUrl = (u) => String(u == null ? "" : u).replace(/[)\s]/g, "");

async function buildText() {
  const now = Date.now();
  const all = await api.getListings();
  const featured = all.filter(
    (r) => r.status === "approved" && r.trendingRank != null && (!r.trendExp || r.trendExp > now),
  );
  if (!featured.length) return null;

  const byChain = {};
  for (const r of featured) (byChain[r.chain] ||= []).push(r);

  // Title emoji is admin-settable (@dexvraadminbot → Trending board) so the
  // operator can make it a premium, animated fire without a redeploy.
  const lines = [`${board.titleEmoji()} **Dexvra Trending** — live featured slots`];
  let newCount = 0;
  for (const chain of CHAIN_ORDER) {
    const arr = byChain[chain];
    if (!arr || !arr.length) continue;
    // Pull live 24h change + market cap for each token (polite to GeckoTerminal).
    const enriched = [];
    for (const r of arr) {
      const m = await fetchMarket(r.chain, r.address).catch(() => null);
      await sleep(300);
      enriched.push({
        r,
        change: m && Number.isFinite(m.change24h) ? m.change24h : null,
        mcap: m && Number.isFinite(m.mcap) ? m.mcap : null,
      });
    }
    // Rank by PACKAGE tier first (top-tier buyers on top), then by 24h performance.
    enriched.sort((a, b) => {
      const d = tierPrio(a.r.tier) - tierPrio(b.r.tier);
      if (d !== 0) return d;
      return (b.change ?? -Infinity) - (a.change ?? -Infinity);
    });
    lines.push(`\n${board.chainLogo(chain)} **${mkText(chainOf(chain).label.toUpperCase())} - Trending**`);
    enriched.slice(0, MAX_PER_CHAIN).forEach((e, i) => {
      const sym = mkText(String(e.r.sym || "").replace(/^\$/, ""));
      const dexUrl = `${SITE_URL}/token/${e.r.chain}/${e.r.address}`;
      // $TICKER prefers Telegram → then X → then Website; only if the token has
      // none of those does it fall back to its Dexvra page (never a dead link).
      // MARKET CAP → the Dexvra token page (its CA).
      const tickerHref = tgUrl(e.r.telegram) || xUrl(e.r.twitter) || webUrl(e.r.website) || dexUrl;
      const link = `[$${sym}](${mkUrl(tickerHref)})`;
      const pct = pctStr(e.change);
      const mc = mcapStr(e.mcap);
      const mcLink = mc ? `[${mc}](${mkUrl(dexUrl)})` : "";
      // {badge} {🌩} {+%} | $TICKER(→TG) | {mcap}$(→Dexvra) — parts drop cleanly
      // if missing. The 🌩 marks a slot that STARTED in the last few hours: the
      // board is edited in place, so without it the message looks identical at
      // 09:00 and 15:00 and a returning reader cannot see what just entered.
      const isNew = board.isNewlyTrending(e.r, now);
      if (isNew) newCount++;
      const segs = [board.rankBadge(i + 1), isNew ? board.newEmoji() : "", pct, "|", link];
      if (mcLink) segs.push("|", mcLink);
      lines.push(segs.filter(Boolean).join(" "));
    });
  }
  // No footer link. Every $TICKER and market cap on the board is already a link
  // (to the token's socials and its Dexvra page), so a trailing "View all on
  // Dexvra" only added a line of chrome to a board that is edited in place and
  // read at a glance — operator's call, 2026-07-25.
  //
  // The legend is the exception, and only when it has something to explain: a
  // symbol nobody defined is noise, and printing "🌩 = newly entered" on a board
  // with no 🌩 on it is worse — it sends the reader hunting for a mark that is
  // not there.
  if (newCount > 0) {
    const h = board.newHours();
    lines.push(`\n${board.newEmoji()} = Newly Entered Trending (slot started in the last ${h} hour${h === 1 ? "" : "s"})`);
  }
  return lines.join("\n");
}

// Remove a superseded board message so the channel never accumulates duplicate
// boards (the visible symptom of a transport flip). Only the identity that POSTED
// a message may delete it, so this routes by the recorded owner. Best-effort.
async function dropMessage(tg, owner, messageId) {
  try {
    if (owner === "gramjs") await gramjs.deleteChannelMessage(CHANNELS.trending, messageId);
    else await tg.deleteMessage(CHANNELS.trending, messageId);
    log.info(`[trendposter] removed superseded board message #${messageId} (${owner})`);
  } catch (e) {
    log.debug(`[trendposter] could not delete old board #${messageId}: ${e.message}`);
  }
}

// Make sure the board we maintain is the message readers actually see pinned.
// A duplicate board left by an older run (transport flip used to strand one) can
// otherwise stay pinned forever while we quietly edit a DIFFERENT message — the
// pinned board then "never changes" no matter how well posting works. Once per
// process, best-effort; re-pinning an already-pinned message is a no-op.
let pinnedThisRun = false;
async function ensurePinned(tg, transport) {
  if (pinnedThisRun || !state.messageId) return;
  pinnedThisRun = true;
  try {
    if (transport === "gramjs") await gramjs.pinChannelMessage(CHANNELS.trending, state.messageId);
    else await tg.pinChatMessage(CHANNELS.trending, state.messageId, { disable_notification: true });
    log.info(`[trendposter] board #${state.messageId} pinned (${transport})`);
  } catch (e) {
    log.debug(`[trendposter] pin #${state.messageId}: ${e.message}`);
  }
}

// Edit (or, on failure, re-post) the board through ONE transport. A message can
// only be edited by the account that sent it, so the transport that owns the
// current message must match; otherwise we post fresh, record the new owner and
// delete the old message — posting FIRST so the channel is never boardless.
//
// A premium-emoji rejection is rethrown untouched: re-posting would fail
// identically, and flipping transport would strand a duplicate board. The caller
// retries on this same transport with the custom emoji stripped, which then just
// EDITS the existing message.
async function postVia(tg, transport, payload, markup, mode) {
  const editIt = () =>
    transport === "gramjs"
      ? gramjs.editChannelMessage(CHANNELS.trending, state.messageId, payload)
      : tg.editMessageText(CHANNELS.trending, state.messageId, undefined, payload.text, {
          entities: payload.entities,
          disable_web_page_preview: true,
        });
  const sendFresh = async () => {
    const prev = state.messageId ? { id: state.messageId, owner: state.transport } : null;
    let msg;
    if (transport === "gramjs") {
      msg = await gramjs.sendToChannel(CHANNELS.trending, { text: payload.text, entities: payload.entities, pin: true });
    } else {
      msg = await tg.sendMessage(CHANNELS.trending, payload.text, {
        entities: payload.entities,
        disable_web_page_preview: true,
      });
      tg.pinChatMessage(CHANNELS.trending, msg.message_id, { disable_notification: true }).catch(() => {});
    }
    state.messageId = msg.message_id;
    state.transport = transport;
    if (prev) await dropMessage(tg, prev.owner, prev.id);
  };
  const settle = async (how) => {
    state.lastText = markup;
    state.lastMode = mode;
    await saveJSON(STATE_FILE, state);
    // ONE line per publish, at info: transport, render mode and how many premium
    // emoji actually went out. Without it "the board never changes" is
    // unanswerable from pm2 logs — a silent success and a silent failure look
    // exactly the same in the channel.
    const nPrem = (payload.entities || []).filter((e) => e.type === "custom_emoji").length;
    log.info(`[trendposter] board ${how} via ${transport} — ${mode}, ${nPrem} premium emoji → #${state.messageId}`);
    await ensurePinned(tg, transport);
  };

  if (state.messageId && state.transport === transport) {
    try {
      await editIt();
      return settle("edited");
    } catch (e) {
      if (/not modified/i.test(e.message || "")) return settle("unchanged");
      if (transport === "gramjs" && gramjs.isPremiumEmojiError(e)) throw e; // caller degrades in place
      log.debug(`[trendposter] ${transport} edit failed (${e.message}) — posting fresh`);
    }
  }
  await sendFresh(); // throws with state.messageId untouched, so no phantom id
  return settle("posted");
}

// One refresh cycle. Exported so the premium / degrade paths are testable
// without waiting on the interval. Never throws — a bad cycle just skips.
async function runOnce(tg) {
  try {
    const markup = await buildText();
    if (!markup) return;
    const parsed = premium.parse(markup);
    // Bot API can't render custom (premium) emoji from a non-owner bot — drop
    // those entities so it shows the unicode fallback; GramJS keeps them.
    const botEntities = parsed.entities.filter((e) => e.type !== "custom_emoji");
    const hasPremiumEmoji = parsed.entities.length !== botEntities.length;

    const premiumUsable = hasPremiumEmoji && gramjs.available() && Date.now() >= premiumBlockedUntil;
    const mode = premiumUsable ? "premium" : "plain";
    // Re-render when the TEXT changed OR when the board can render in a different
    // MODE than last time (premium account just came online / just went away).
    if (markup === state.lastText && mode === state.lastMode) return;

    // Prefer the GramJS premium account — the ONLY way custom emoji render.
    if (premiumUsable) {
      try {
        await postVia(tg, "gramjs", { text: parsed.text, entities: parsed.entities }, markup, "premium");
        return;
      } catch (e) {
        if (gramjs.isPremiumEmojiError(e)) {
          // Telegram refused the emoji themselves — the account almost certainly
          // isn't Telegram Premium (or an id is dead). Degrade IN PLACE on the
          // same transport (same message, no duplicate) and back off.
          premiumBlockedUntil = Date.now() + PREMIUM_RETRY_MS;
          gramjs.recordEmojiRefusal(e.message); // surfaces in /premium (admin bot)
          warnOnce(
            "premium-refused",
            `[trendposter] Telegram REFUSED the premium emoji (${e.message}) — is the GramJS account actually Telegram Premium? Board renders UNICODE; retrying in ${Math.round(PREMIUM_RETRY_MS / 60000)}min. Diagnose with /premium in @dexvraadminbot.`,
          );
          try {
            await postVia(tg, "gramjs", { text: parsed.text, entities: botEntities }, markup, "plain");
            return;
          } catch (e2) {
            log.warn(`[trendposter] gramjs unicode post also failed → bot-api fallback: ${e2.message}`);
          }
        } else {
          log.warn(`[trendposter] premium (gramjs) post FAILED → bot-api fallback (unicode): ${e.message}`);
        }
      }
    } else if (hasPremiumEmoji && !gramjs.available()) {
      warnOnce(
        "premium-offline",
        "[trendposter] board has premium emoji but the premium account is NOT connected — posting UNICODE. Run: node scripts/gramjs-login.js (diagnose with /premium in @dexvraadminbot)",
      );
    }
    await postVia(tg, "bot", { text: parsed.text, entities: botEntities }, markup, "plain");
  } catch (e) {
    // A cycle that dies here publishes NOTHING, and at debug level that is
    // invisible — "the board just never changes" with no trace in pm2 logs.
    // Throttled so a persistent outage doesn't flood the log channel.
    warnOnce("cycle-failed", `[trendposter] refresh cycle FAILED: ${e.message}`);
    log.debug(`[trendposter] ${e.stack || e.message}`);
  }
}

function start(tg) {
  const run = () => runOnce(tg);
  const iv = setInterval(run, TRENDING_POST_MS);
  const kick = setTimeout(run, 8000);
  return {
    stop: () => {
      clearInterval(iv);
      clearTimeout(kick);
    },
  };
}

module.exports = { start, runOnce, buildText };
// Exposed for tests: reset the in-memory post state between cases.
module.exports._resetState = () => {
  state = { messageId: null, lastText: null, lastMode: null };
  premiumBlockedUntil = 0;
  pinnedThisRun = false;
  warnedAt.clear();
};
