'use strict';
/* Dexvra Trade Bot entrypoint — starts the Telegram UI + background watchers. */

// Process guards, installed BEFORE anything else can throw.
//
// Node's default is --unhandled-rejections=throw: one promise that rejects with
// no handler attached terminates the process. In a custodial trading bot that is
// not a crash, it is a total outage for every user at once — and it was
// reachable from a single Telegram message (an amount like 0.0000001 formats as
// "1e-7", which ethers refuses, rejecting core.buy()'s promise before its
// handler had been attached).
//
// That orphaned-promise bug is fixed at the source in telegram.js, but the guard
// stays: this process holds custody of user funds and must not be one unhandled
// rejection away from going dark. Dying is also not a clean failure here —
// the Telegram offset is in memory, so a restart re-polls the un-acked batch and
// an already-executed Buy callback can be REDELIVERED and charged twice.
//
// bot/main.js has had exactly this for the same reason; the trade bot never did.
const NON_FATAL = /ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|fetch failed|network|timeout|429|503/i;

process.on('unhandledRejection', (reason) => {
  const msg = reason && reason.message ? reason.message : String(reason);
  if (NON_FATAL.test(msg)) console.warn('[tradebot] unhandledRejection (non-fatal):', msg);
  else console.error('[tradebot] unhandledRejection:', msg, reason && reason.stack ? '\n' + reason.stack : '');
});

process.on('uncaughtException', (err) => {
  const msg = err && err.message ? err.message : String(err);
  // A last resort, not a licence to continue: logged loudly, and the process
  // keeps serving rather than dropping every user mid-trade. pm2 restarts it if
  // it genuinely becomes unhealthy.
  console.error('[tradebot] uncaughtException:', msg, err && err.stack ? '\n' + err.stack : '');
});

require('./telegram').start().catch((e) => { console.error('fatal', e); process.exit(1); });
