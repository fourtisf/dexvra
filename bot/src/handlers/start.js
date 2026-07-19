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

async function showHome(ctx) {
  resetSession(ctx);
  const text = tpl.t("welcome");
  const banner = bannerPhoto();
  if (banner) await sendPhotoCard(ctx, banner, text, mainMenu());
  else await sendCard(ctx, text, mainMenu());
}

async function startHandler(ctx) {
  if (ctx.chat && ctx.chat.type !== "private") {
    try {
      await ctx.reply("👋 DM me to list your token: open a private chat and tap Start.");
    } catch {
      /* ignore */
    }
    return;
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

module.exports = { startHandler, homeHandler, showHome, resetSession };
