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
let state = loadJSONSync(STATE_FILE, { messageId: null, lastText: null });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Board priority: paid tier first (Diamond=1 … Bronze=5), then Xpress/none last.
const tierPrio = (tier) => {
  const r = tierRank(tier);
  return r > 0 ? r : 99;
};
// Full comma number + "$" (fourtis style: 23,868,066$).
const mcapStr = (n) => (Number.isFinite(n) && n > 0 ? `${Math.round(n).toLocaleString("en-US")}$` : "");
const pctStr = (n) => (Number.isFinite(n) ? `${n >= 0 ? "+" : ""}${n.toFixed(2)}%` : "");
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

  const lines = ["🔥 **Dexvra Trending** — live featured slots"];
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
      // {badge} {+%} | $TICKER(→TG) | {mcap}$(→Dexvra)  — parts drop cleanly if missing
      const segs = [board.rankBadge(i + 1), pct, "|", link];
      if (mcLink) segs.push("|", mcLink);
      lines.push(segs.filter(Boolean).join(" "));
    });
  }
  lines.push(`\n🌐 [View all on Dexvra](${mkUrl(SITE_URL + "/trending")})`);
  return lines.join("\n");
}

// Edit (or, on any failure, re-post) the board through ONE transport. A message
// can only be edited by the account that sent it, so the transport that owns the
// current message must match; otherwise we post fresh and record the new owner.
async function postVia(tg, transport, payload, markup) {
  const editIt = () =>
    transport === "gramjs"
      ? gramjs.editChannelMessage(CHANNELS.trending, state.messageId, payload)
      : tg.editMessageText(CHANNELS.trending, state.messageId, undefined, payload.text, {
          entities: payload.entities,
          disable_web_page_preview: true,
        });
  const sendFresh = async () => {
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
  };

  if (state.messageId && state.transport === transport) {
    try {
      await editIt();
    } catch (e) {
      if (/not modified/i.test(e.message || "")) {
        state.lastText = markup;
        return;
      }
      log.debug(`[trendposter] ${transport} edit failed (${e.message}) — posting fresh`);
      state.messageId = null;
      await sendFresh();
    }
  } else {
    await sendFresh();
  }
  state.lastText = markup;
  await saveJSON(STATE_FILE, state);
}

function start(tg) {
  const run = async () => {
    try {
      const markup = await buildText();
      if (!markup || markup === state.lastText) return;
      const parsed = premium.parse(markup);
      // Bot API can't render custom (premium) emoji from a non-owner bot — drop
      // those entities so it shows the unicode fallback; GramJS keeps them.
      const botEntities = parsed.entities.filter((e) => e.type !== "custom_emoji");

      // Prefer the GramJS premium account (premium emoji render). On ANY GramJS
      // failure fall back to the Bot API for this cycle (fallback unicode).
      if (gramjs.available()) {
        try {
          await postVia(tg, "gramjs", { text: parsed.text, entities: parsed.entities }, markup);
          return;
        } catch (e) {
          log.debug(`[trendposter] gramjs path failed (${e.message}) → bot api`);
        }
      }
      await postVia(tg, "bot", { text: parsed.text, entities: botEntities }, markup);
    } catch (e) {
      log.debug(`[trendposter] ${e.message}`);
    }
  };
  const iv = setInterval(run, TRENDING_POST_MS);
  const kick = setTimeout(run, 8000);
  return {
    stop: () => {
      clearInterval(iv);
      clearTimeout(kick);
    },
  };
}

module.exports = { start, buildText };
