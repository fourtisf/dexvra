// /start and /home — full session reset, then the main menu (editable `welcome`
// template + optional admin-uploaded banner image). Private-chat only.
const fss = require("node:fs");
const { sendCard, sendPhotoCard, answer } = require("../helpers/message");
const { mainMenu } = require("./menu");
const { escapeHtml } = require("../helpers/format");
const { DedupSet } = require("../helpers/persist");
const assets = require("../assets");
const tpl = require("../templates");
const log = require("../helpers/logger");

// Persisted /start audience — powers the 🆕 new-user badge (and a future
// broadcast audience).
const seenUsers = new DedupSet("users.json");

function resetSession(ctx) {
  ctx.session = {};
}

function bannerPhoto() {
  // Admin-uploaded banner wins; otherwise the bundled premium welcome banner.
  try {
    if (fss.existsSync(tpl.BANNER_PATH) && fss.statSync(tpl.BANNER_PATH).size > 0) {
      return { source: tpl.BANNER_PATH };
    }
  } catch {
    /* fall through to bundled default */
  }
  const bundled = assets.main();
  return bundled ? { source: bundled } : null;
}

// Channel links are filled from config so they're always correct without any
// manual template editing (change a channel via env → the link follows).
const tme = (h) => `https://t.me/${String(h).replace(/^@/, "")}`;
function channelVars() {
  const { CHANNELS, SITE_URL } = require("../config/constants");
  return {
    site: SITE_URL,
    announce: tme(CHANNELS.announce),
    listing: tme(CHANNELS.listing),
    trending: tme(CHANNELS.trending),
  };
}

// The "Official Links" footer is generated here (never in the editable template)
// so the links are ALWAYS present and correct — editing the welcome text can
// never lose them. Labels carry "Channel" for the Telegram channels; Website
// stays as-is. Config change (env) → the links follow automatically.
function officialLinksMarkup(v) {
  return (
    "\n\n**🔗 Official Links**\n" +
    `🌐 [Website](${v.site})\n` +
    `📢 [Announcements Channel](${v.announce})\n` +
    `🚨 [Listings Channel](${v.listing})\n` +
    `📈 [Trending Channel](${v.trending})`
  );
}
/** Append the generated linked footer to a rendered welcome payload
 *  ({text, entities} or legacy {html}), offsetting the block's entities. */
function withOfficialLinks(payload, v) {
  const premium = require("../premium");
  if (payload && payload.html != null) {
    const a = (label, url) => `<a href="${url}">${label}</a>`;
    return {
      html:
        payload.html +
        `\n\n🔗 <b>Official Links</b>\n🌐 ${a("Website", v.site)}\n📢 ${a("Announcements Channel", v.announce)}\n🚨 ${a("Listings Channel", v.listing)}\n📈 ${a("Trending Channel", v.trending)}`,
    };
  }
  const base = payload && payload.text != null ? payload : { text: String(payload || ""), entities: [] };
  const block = premium.parse(officialLinksMarkup(v));
  const off = base.text.length;
  return {
    text: base.text + block.text,
    entities: [...(base.entities || []), ...block.entities.map((e) => ({ ...e, offset: e.offset + off }))],
  };
}

async function showHome(ctx) {
  resetSession(ctx);
  const v = channelVars();
  const text = withOfficialLinks(tpl.render("welcome", v), v);
  const banner = bannerPhoto();
  if (banner) await sendPhotoCard(ctx, banner, text, mainMenu());
  else await sendCard(ctx, text, mainMenu());
}

async function startHandler(ctx) {
  if (ctx.chat && ctx.chat.type !== "private") {
    // In a group, /start (or /help) means "how do I set up the buy bot here?" —
    // give the exact steps instead of just bouncing them to DM.
    return groupStart(ctx);
  }
  // Full visitor report to the log channel (fourtis-style).
  try {
    const u = ctx.from || {};
    const isNew = await seenUsers.add(String(u.id));
    const usernameTag = u.username ? `@${u.username}` : "(none)";
    const fullName = `${u.first_name || ""} ${u.last_name || ""}`.trim();
    log.report(
      `${isNew ? "🆕 " : ""}<b>👤 /start</b>\n` +
        `<b>User:</b> ${escapeHtml(usernameTag)}\n` +
        `<b>ID:</b> <code>${u.id}</code>\n` +
        `<b>Name:</b> ${escapeHtml(fullName || "(none)")}\n` +
        (u.language_code ? `<b>Locale:</b> ${escapeHtml(u.language_code)}\n` : "") +
        `<b>Date:</b> ${new Date().toISOString()}`,
    );
  } catch (e) {
    log.debug(`[start] visitor log: ${e.message}`);
  }
  await showHome(ctx);
}

async function homeHandler(ctx) {
  await answer(ctx);
  if (ctx.chat && ctx.chat.type !== "private") return;
  await showHome(ctx);
}

// /start or /help inside a group → buy-bot setup steps for this group.
async function groupStart(ctx) {
  try {
    const { BOT_USERNAME } = require("../config/constants");
    const { payloadArgs } = require("../helpers/message");
    const { text, extra } = payloadArgs(tpl.render("group_start", { bot: `@${BOT_USERNAME}` }), false);
    await ctx.reply(text, { ...extra, disable_web_page_preview: true });
  } catch {
    /* ignore */
  }
}

// "🤖 Add Buy Bot to your group" — how-to + a one-tap "add to group" deep link.
async function buyBotHelp(ctx) {
  await answer(ctx);
  const { BOT_USERNAME } = require("../config/constants");
  const { Markup } = require("./menu");
  const kb = Markup.inlineKeyboard([
    [Markup.button.url("➕ Add to your group", `https://t.me/${BOT_USERNAME}?startgroup=true`)],
    [Markup.button.callback("🏠 Home", "home")],
  ]);
  await sendCard(ctx, tpl.render("buybot_help"), kb);
}

module.exports = { startHandler, homeHandler, showHome, resetSession, buyBotHelp, groupStart };
