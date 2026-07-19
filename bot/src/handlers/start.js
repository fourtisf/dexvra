// /start and /home — full session reset, then the main menu (editable `welcome`
// template + optional admin-uploaded banner image). Private-chat only.
const fss = require("node:fs");
const { sendCard, sendPhotoCard, answer } = require("../helpers/message");
const { mainMenu } = require("./menu");
const tpl = require("../templates");
const log = require("../helpers/logger");

function resetSession(ctx) {
  ctx.session = {};
}

function bannerPhoto() {
  try {
    if (fss.existsSync(tpl.BANNER_PATH) && fss.statSync(tpl.BANNER_PATH).size > 0) {
      return { source: tpl.BANNER_PATH };
    }
  } catch {
    /* no banner */
  }
  return null;
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
  log.event(
    `👤 /start — @${(ctx.from && ctx.from.username) || (ctx.from && ctx.from.id)}` +
      (ctx.from && ctx.from.first_name ? ` (${ctx.from.first_name})` : ""),
  );
  await showHome(ctx);
}

async function homeHandler(ctx) {
  await answer(ctx);
  if (ctx.chat && ctx.chat.type !== "private") return;
  await showHome(ctx);
}

module.exports = { startHandler, homeHandler, showHome, resetSession };
