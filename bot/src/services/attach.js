// Wires the background services onto the bot. Called by setupMonitoring().
const { PUMP_ENABLED } = require("../config/constants");
const log = require("../helpers/logger");

function attachServices(bot, services) {
  const tg = bot.telegram;

  services.push(require("./trendingSweeper").start());
  services.push(require("./trendingPoster").start(tg));
  if (PUMP_ENABLED) services.push(require("./pumpChecker").start(tg));

  // One-shot recovery of paid-but-unfulfilled orders (restart safety).
  require("./recovery")
    .recoverPaidOrders(tg)
    .catch((e) => log.warn(`[recovery] ${e.message}`));
}

module.exports = { attachServices };
