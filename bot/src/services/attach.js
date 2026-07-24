// Wires the background services onto the bot. Called by setupMonitoring().
const { PUMP_ENABLED, UPSELL_ENABLED, RANKUP_ENABLED } = require("../config/constants");
const log = require("../helpers/logger");

function attachServices(bot, services) {
  const tg = bot.telegram;

  services.push(require("./trendingSweeper").start());
  services.push(require("./trendingPoster").start(tg));
  services.push(require("./autoTrend").start()); // auto-fill trending between paid slots
  if (PUMP_ENABLED) services.push(require("./pumpChecker").start(tg));
  if (RANKUP_ENABLED) services.push(require("./rankUpChecker").start(tg));
  if (UPSELL_ENABLED) services.push(require("./trendingUpsell").start(tg));
  services.push(require("../broadcast/sender").start(tg)); // admin broadcast delivery
  if (require("../config/constants").MASS_DM_ENABLED) {
    services.push(require("../massdm/sender").start(tg)); // paid Mass DM delivery (approved jobs only)
  }
  if (require("../config/constants").GROUP_BUYBOT_ENABLED) {
    services.push(require("../group/buyMonitor").start(tg)); // group buy alerts
  }

  // One-shot recovery: re-fulfil paid orders + detect late-arriving payments.
  require("./recovery")
    .runRecovery(tg)
    .catch((e) => log.warn(`[recovery] ${e.message}`));
}

module.exports = { attachServices };
