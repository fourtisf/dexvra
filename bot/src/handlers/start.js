// /start and /home — full session reset, then the main menu. Private-chat only
// (the bot's purchase flows are 1:1). In groups it just points users to the DM.
const { sendCard, answer } = require("../helpers/message");
const { mainMenu, WELCOME } = require("./menu");
const log = require("../helpers/logger");

function resetSession(ctx) {
  // Wipe any in-flight listing/trend/banner state, keep nothing.
  ctx.session = {};
}

async function showHome(ctx) {
  resetSession(ctx);
  await sendCard(ctx, WELCOME, mainMenu());
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
  log.debug(`[start] ${ctx.from && ctx.from.id} @${ctx.from && ctx.from.username}`);
  await showHome(ctx);
}

async function homeHandler(ctx) {
  await answer(ctx);
  if (ctx.chat && ctx.chat.type !== "private") return;
  await showHome(ctx);
}

module.exports = { startHandler, homeHandler, showHome, resetSession };
