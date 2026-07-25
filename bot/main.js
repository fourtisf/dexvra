// Entry point. Loads .env, installs non-fatal process guards (a stray RPC/HTTP
// rejection must never crash the bot), then boots.
const envFiles = require("./src/config/loadEnv").loadEnv();

const log = require("./src/helpers/logger");
// Named out loud: "which .env is this process actually reading" is the first
// question behind every setting that appears not to apply.
log.info(envFiles.length ? `[env] loaded ${envFiles.join(", ")}` : "[env] no .env found — using process env only");
require("./src/helpers/net").preferIPv4(); // before any socket opens

const NON_FATAL = /ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|fetch failed|network|timeout/i;

process.on("unhandledRejection", (reason) => {
  const msg = reason && reason.message ? reason.message : String(reason);
  if (NON_FATAL.test(msg)) log.warn(`unhandledRejection (non-fatal): ${msg}`);
  else log.error(`unhandledRejection: ${msg}`);
});

process.on("uncaughtException", (err) => {
  const msg = err && err.message ? err.message : String(err);
  if (NON_FATAL.test(msg)) log.warn(`uncaughtException (non-fatal): ${msg}`);
  else log.error(`uncaughtException: ${msg}`);
});

const { startBot } = require("./src/bot");

startBot().catch((e) => {
  log.error(`fatal boot error: ${e && e.message}`);
  process.exitCode = 1;
});
