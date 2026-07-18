// Maintains a single "Dexvra Trending" message in @dexvratrending, edited in
// place (no new-post spam / no visible minute pattern). Persists the message id
// so a restart re-edits the same message. Skips when the text is unchanged.
const { TRENDING_POST_MS, CHANNELS, SITE_URL } = require("../config/constants");
const api = require("../api/dexvra");
const { chainOf, CHAIN_ORDER } = require("../config/chains");
const { escapeHtml } = require("../helpers/format");
const { loadJSONSync, saveJSON } = require("../helpers/persist");
const log = require("../helpers/logger");

const STATE_FILE = "trendpost.json";
let state = loadJSONSync(STATE_FILE, { messageId: null, lastText: null });

async function buildText() {
  const now = Date.now();
  const all = await api.getListings();
  const featured = all.filter(
    (r) => r.status === "approved" && r.trendingRank != null && (!r.trendExp || r.trendExp > now),
  );
  if (!featured.length) return null;

  const byChain = {};
  for (const r of featured) (byChain[r.chain] ||= []).push(r);

  const lines = ["🔥 <b>Dexvra Trending</b> — live featured slots\n"];
  for (const chain of CHAIN_ORDER) {
    const arr = byChain[chain];
    if (!arr || !arr.length) continue;
    lines.push(`\n<b>${escapeHtml(chainOf(chain).label)}</b>`);
    arr.slice(0, 10).forEach((r, i) => {
      const sym = String(r.sym || "").replace(/^\$/, "");
      lines.push(`${i + 1}. <a href="${SITE_URL}/token/${r.chain}/${r.address}">$${escapeHtml(sym)}</a>`);
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

module.exports = { start };
