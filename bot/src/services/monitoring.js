// Background service orchestrator. Real services (trending poster, trending
// sweeper, pump checker) are wired in Phase F; this keeps the boot contract.
const log = require("../helpers/logger");

function setupMonitoring(bot) {
  const services = [];
  // Phase F attaches: trendingPoster, trendingSweeper, pumpChecker.
  try {
    const attach = require("./attach");
    attach.attachServices(bot, services);
  } catch (e) {
    if (e.code !== "MODULE_NOT_FOUND") log.warn(`[monitoring] ${e.message}`);
  }
  log.info(`[monitoring] ${services.length} background service(s) started`);
  const cleanup = () => services.forEach((s) => s.stop && s.stop());
  process.once("SIGINT", cleanup);
  process.once("SIGTERM", cleanup);
  return { services, cleanup };
}

module.exports = { setupMonitoring };
