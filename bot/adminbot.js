// Entry for @dexvraadminbot (template editor). Separate process from the main
// bot; shares the same code + data/ dir. Started by PM2 as `dexvra-adminbot`.
require("dotenv").config();

const log = require("./src/helpers/logger");

process.on("unhandledRejection", (r) => log.warn(`[adminbot] unhandledRejection: ${r && r.message ? r.message : r}`));
process.on("uncaughtException", (e) => log.warn(`[adminbot] uncaughtException: ${e && e.message}`));

const { startAdminBot } = require("./src/admin/adminBot");

startAdminBot().catch((e) => {
  log.error(`[adminbot] fatal boot error: ${e && e.message}`);
  process.exitCode = 1;
});
