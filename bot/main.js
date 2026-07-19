// Entry point. Loads .env, installs non-fatal process guards (a stray RPC/HTTP
// rejection must never crash the bot), then boots.
// override:true — bot/.env is the source of truth. PM2 snapshots the env at
// the FIRST `pm2 start` and re-injects it on every restart (--update-env only
// overlays the current shell), so without override a stale snapshot silently
// beats an edited .env (live incident: POST_BANNERS=0 survived every restart).
require("dotenv").config({ override: true });

const log = require("./src/helpers/logger");

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
