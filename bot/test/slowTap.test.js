// A 120s handler error that does not say WHICH BUTTON is a diagnostic about
// nothing.
//
// Reported 2026-09-07, three times in an hour:
//
//   🚨 [telegraf] callback_query handler error: Promise timed out after
//      120000 milliseconds
//
// True of all 26 registered callbacks. Every occurrence started a fresh hunt
// across the lot, and two of those hunts were guesses of mine — fulfilment had
// already been detached from that path, so it was never the cause.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-slowtap-"));

const test = require("node:test");
const assert = require("node:assert");

const SRC = fss.readFileSync(require.resolve("../src/bot.js"), "utf8");
const code = SRC.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");

test("the handler-error line names the tap and how long it took", () => {
  const fn = code.slice(code.indexOf("async function onHandlerError"), code.indexOf("async function startBot"));
  assert.match(fn, /tap=\$\{tapOf\(ctx\)\}/, "the error must name which button");
  assert.match(fn, /after=/, "…and how long, because 120s means the framework killed it");
});

test("⚠️ the tap is BOT-GENERATED data, never message text", () => {
  // The import-wallet step takes a private key as a plain message. Even a
  // truncated echo of `ctx.message.text` would land in pm2's log — the rule
  // the trade bot's own router already carries a scar for.
  const fn = code.slice(code.indexOf("function tapOf"), code.indexOf("async function onHandlerError"));
  assert.match(fn, /callbackQuery/, "callback data is what identifies a tap");
  assert.ok(!/message\s*&&|\.message\.text|ctx\.message/.test(fn), "message text may never reach the log");
});

test("a merely SLOW tap is reported before the framework kills it", () => {
  // Only the taps that reach handlerTimeout were ever reported, and by then
  // the promise is dead and the user has watched a spinner for two minutes.
  assert.match(code, /SLOW_HANDLER_MS/, "there must be a threshold");
  assert.match(code, /\[ui\] slow \$\{ctx\.updateType\} tap=/, "…and the warning must name the tap too");
  // Silent under it: a fast tap must not write a line per update into a log
  // the background loops already fill.
  assert.match(code, /if \(ms >= SLOW_HANDLER_MS\)/, "it must be conditional, not every update");
});

test("the timer wraps the WHOLE chain, so a hang is still measured", () => {
  // In a `finally`, not after an awaited next(): a handler that throws or is
  // killed must still report its elapsed time — that is the case this exists
  // for. Measured on the comment-stripped source, so the explanation above it
  // cannot make this pass on its own.
  const mw = code.slice(code.indexOf("ctx.__t0 = Date.now();"), code.indexOf("bot.use(session"));
  assert.match(mw, /try \{[\s\S]*return await next\(\);[\s\S]*\} finally \{/, mw);
});
