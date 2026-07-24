// Maintains a single "Dexvra Trending" message in @dexvratrending, edited in
// place (no new-post spam / no visible minute pattern). Persists the message id
// so a restart re-edits the same message. Skips when the text is unchanged.
const { TRENDING_POST_MS, CHANNELS, SITE_URL } = require("../config/constants");
const api = require("../api/dexvra");
const { chainOf, CHAIN_ORDER } = require("../config/chains");
const { tierRank } = require("../config/packages");
const { fetchMarket } = require("../marketdata");
const board = require("./trendingBoard");
const { escapeHtml } = require("../helpers/format");
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

async function buildText() {
  const now = Date.now();
  const all = await api.getListings();
  const featured = all.filter(
    (r) => r.status === "approved" && r.trendingRank != null && (!r.trendExp || r.trendExp > now),
  );
  if (!featured.length) return null;

  const byChain = {};
  for (const r of featured) (byChain[r.chain] ||= []).push(r);

  const lines = ["🔥 <b>Dexvra Trending</b> — live featured slots"];
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
    lines.push(`\n${board.chainLogo(chain)} <b>${escapeHtml(chainOf(chain).label.toUpperCase())} - Trending</b>`);
    enriched.slice(0, MAX_PER_CHAIN).forEach((e, i) => {
      const sym = String(e.r.sym || "").replace(/^\$/, "");
      const link = `<a href="${SITE_URL}/token/${e.r.chain}/${e.r.address}">$${escapeHtml(sym)}</a>`;
      const pct = pctStr(e.change);
      const mc = mcapStr(e.mcap);
      // {badge} {+%} | $TICKER | {mcap}$   (fourtis layout; parts drop cleanly if missing)
      const segs = [board.rankBadge(i + 1), pct, "|", link];
      if (mc) segs.push("|", mc);
      lines.push(segs.filter(Boolean).join(" "));
    });
  }
  lines.push(`\n🌐 <a href="${SITE_URL}/trending">View all on Dexvra</a>`);
  return lines.join("\n");
}

function start(tg) {
  const run = async () => {
    try {
      const text = await buildText();
      if (!text || text === state.lastText) return;

      if (state.messageId) {
        try {
          await tg.editMessageText(CHANNELS.trending, state.messageId, undefined, text, {
            parse_mode: "HTML",
            disable_web_page_preview: true,
          });
          state.lastText = text;
          await saveJSON(STATE_FILE, state);
          return;
        } catch (e) {
          if (/not modified/i.test(e.message)) {
            state.lastText = text;
            return;
          }
          log.debug(`[trendposter] edit failed (${e.message}) — posting fresh`);
          state.messageId = null;
        }
      }
      const msg = await tg.sendMessage(CHANNELS.trending, text, {
        parse_mode: "HTML",
        disable_web_page_preview: true,
      });
      state.messageId = msg.message_id;
      state.lastText = text;
      tg.pinChatMessage(CHANNELS.trending, msg.message_id, { disable_notification: true }).catch(() => {});
      await saveJSON(STATE_FILE, state);
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
