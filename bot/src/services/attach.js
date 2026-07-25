// Wires the background services onto the bot. Called by setupMonitoring().
const { PUMP_ENABLED, UPSELL_ENABLED, RANKUP_ENABLED } = require("../config/constants");
const log = require("../helpers/logger");

function attachServices(bot, services) {
  const tg = bot.telegram;

  services.push(require("./trendingSweeper").start());
  services.push(require("./trendingPoster").start(tg));
  services.push(require("./autoTrend").start()); // auto-fill trending between paid slots
  services.push(require("./autoLister").start(tg)); // free listings for projects crossing ~$1M (off by default)
  if (PUMP_ENABLED) services.push(require("./pumpChecker").start(tg));
  if (RANKUP_ENABLED) services.push(require("./rankUpChecker").start(tg));
  if (UPSELL_ENABLED) services.push(require("./trendingUpsell").start(tg));
  services.push(require("./sweepRetry").start()); // recovers funds a failed sweep left in temp wallets
  services.push(require("./forcePostRunner").start()); // publishes adminbot's force-post requests
  services.push(require("../broadcast/sender").start(tg)); // admin broadcast delivery
  if (require("../config/constants").MASS_DM_ENABLED) {
    services.push(require("../massdm/sender").start(tg)); // paid Mass DM delivery (approved jobs only)
  }
  if (require("../config/constants").GROUP_BUYBOT_ENABLED) {
    services.push(require("../group/buyMonitor").start(tg)); // group buy alerts
  }

  // Boot recovery (re-fulfil paid orders) + a RECURRING late-payment scan.
  // Boot-only was not enough: sessions are in-memory, so a restart drops the
  // buyer's pendingPayment and a payment that lands afterwards is credited by
  // nobody until the next restart.
  services.push(require("./recovery").start(tg));
}

module.exports = { attachServices };
