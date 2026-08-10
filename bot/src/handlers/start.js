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
  const { CHANNELS, SITE_URL, X_LISTING_URL } = require("../config/constants");
  return {
    site: SITE_URL,
    announce: tme(CHANNELS.announce),
    listing: tme(CHANNELS.listing),
    trending: tme(CHANNELS.trending),
    // Listing alerts are tweeted from here. Must be filled everywhere the
    // channel links are, or {xlisting} renders as a literal in the card.
    xlisting: X_LISTING_URL,
  };
}

async function showHome(ctx) {
  resetSession(ctx);
  const text = tpl.render("welcome", channelVars());
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

/**
 * The buttons under the group welcome — the whole point being that nobody has
 * to type a command to start.
 *
 * The card used to list `/settoken <CA>`, `/setminbuy 50`, `/setwhale 50000`
 * and `/raid` as text. Every one of those still works, and none of them is
 * discoverable: a group admin who has just added a bot is not reading syntax,
 * they are looking for something to press. Two features were sitting behind
 * commands nobody ran.
 *
 * Labels are pipe-separated and admin-editable (`group_start_buttons`), with
 * FIELD-BY-FIELD fallback so a half-typed override still renders a keyboard
 * rather than a row of blanks — same rule as `group_buy_tiers`.
 */
const START_BUTTON_DEFAULTS = ["🤖 Buy Bot", "🚀 Raid", "⚙️ Settings", "🔥 Listing / Trending", "📢 Channel"];
function groupStartKeyboard() {
  const parts = String(tpl.t("group_start_buttons") || "").split("|");
  const [buybot, raid, settings, listing, channel] = START_BUTTON_DEFAULTS.map(
    (def, i) => (parts[i] || "").trim() || def,
  );
  const { SITE_URL, CHANNELS } = require("../config/constants");
  const rows = [
    [{ text: buybot, callback_data: "bs_buybot" }],
    [
      { text: raid, callback_data: "gs_raid" },
      { text: settings, callback_data: "bs_home" },
    ],
  ];
  // URL buttons only when there is a real URL to point at. Telegram rejects the
  // whole message for a malformed one, which would take the welcome card down
  // over a link — the same failure mode {bot} caused below.
  const site = String(SITE_URL || "").trim();
  if (/^https?:\/\//i.test(site)) rows.push([{ text: listing, url: site.replace(/\/+$/, "") }]);
  const ch = String((CHANNELS && CHANNELS.announce) || "").trim();
  if (/^@[A-Za-z0-9_]{4,}$/.test(ch)) rows.push([{ text: channel, url: `https://t.me/${ch.slice(1)}` }]);
  return { inline_keyboard: rows };
}

// /start or /help inside a group → buy-bot setup steps for this group.
async function sendGroupTemplate(ctx, key) {
  try {
    const { payloadArgs } = require("../helpers/message");
    // NO { bot } override. baseVars() already supplies it as a t.me URL, and
    // passing "@dexvrabot" here beat it — so a template using {bot} as a LINK
    // TARGET produced entity URL '@dexvrabot', which Telegram rejects outright:
    // "400: Wrong HTTP URL", and the whole message failed to send. Use
    // {botName} when the @handle is wanted as text.
    const { text, extra } = payloadArgs(tpl.render(key), false);
    await ctx.reply(text, {
      ...extra,
      disable_web_page_preview: true,
      reply_markup: groupStartKeyboard(),
    });
  } catch (e) {
    // LOUD. This used to swallow silently, and a swallowed failure here is
    // /start doing nothing at all, forever, with nothing in the logs to say
    // why — a saved template whose markup will not parse looks exactly like a
    // bot that has stopped working.
    log.warn(`[group] ${key} failed in ${ctx.chat && ctx.chat.id}: ${e && e.message}`);
  }
}

async function groupStart(ctx) {
  // Adding the bot through the ➕ deep link fires BOTH: the greeting, on the
  // my_chat_member update, and a /start Telegram injects into the group right
  // behind it — two different welcomes stacked on each other.
  //
  // The injected one is told apart by its PAYLOAD: ?startgroup=true makes
  // Telegram send "/start true", and a person typing sends /start or
  // /start@bot with nothing after it. So only the injected one can ever be
  // suppressed.
  //
  // The first cut of this gated on a 20-SECOND WINDOW instead, and that was
  // wrong in the way that matters: a human typing /start is an explicit
  // request, and for twenty seconds after the bot joined — exactly when
  // somebody is setting it up and pressing things — it answered nothing at all
  // and logged nothing either. /start must always answer.
  const injected = !!(ctx.startPayload && String(ctx.startPayload).trim());
  if (injected && justGreeted(ctx.chat && ctx.chat.id)) return;
  return sendGroupTemplate(ctx, "group_start");
}

// chatId → ms of the last "thanks for adding me". In memory only: it guards a
// window of seconds, and a restart inside that window is not worth a disk write
// — the worst case is one duplicate welcome, once.
const greeted = new Map();
const GREET_QUIET_MS = 20 * 1000;

function justGreeted(chatId, at = Date.now()) {
  if (!chatId) return false;
  for (const [k, t] of greeted) if (at - t > GREET_QUIET_MS) greeted.delete(k);
  const t = greeted.get(String(chatId));
  return !!t && at - t <= GREET_QUIET_MS;
}

/**
 * The bot was just added to a group — ask for the permissions it actually uses.
 *
 * Fires on my_chat_member, so it lands whether the group was joined through the
 * ➕ deep link or by someone adding the bot by hand. Before this, a hand-added
 * bot sat silent until somebody thought to type /start, and every operator who
 * did that first hit "not enough rights to pin a message" later.
 *
 * Guarded on the status TRANSITION, not on the new status alone: Telegram sends
 * my_chat_member for every permission change too, and greeting on each one
 * means a fresh welcome every time an admin adjusts a checkbox.
 */
async function botAddedToGroup(ctx) {
  const u = ctx.myChatMember;
  if (!u || !ctx.chat || (ctx.chat.type !== "group" && ctx.chat.type !== "supergroup")) return;
  const was = (u.old_chat_member && u.old_chat_member.status) || "";
  const now = (u.new_chat_member && u.new_chat_member.status) || "";
  const wasIn = was === "member" || was === "administrator" || was === "creator";
  const isIn = now === "member" || now === "administrator" || now === "creator";
  if (wasIn || !isIn) return; // a permission change, a demotion, or a removal
  greeted.set(String(ctx.chat.id), Date.now());
  log.info(`[group] added to ${ctx.chat.id} (${ctx.chat.title || "?"}) as ${now}`);
  return sendGroupTemplate(ctx, "group_added");
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

module.exports = {
  groupStartKeyboard, startHandler, homeHandler, showHome, resetSession, buyBotHelp, groupStart, botAddedToGroup, justGreeted, _greeted: greeted };
