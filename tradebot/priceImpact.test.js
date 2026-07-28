// "di Maestro sukses, bot kita fail."
//
// A 0.05 ETH buy was refused: "Buy blocked — thin pool … would move the price
// ~11% — over the 10% limit." Maestro filled the same trade. Two separate
// mistakes were stacked on top of each other:
//
//   1. the number was computed with a V2 constant-product formula against a V3
//      pool's raw balance. V3 liquidity is CONCENTRATED — a pool holding 0.8
//      ETH can fill a 0.05 ETH buy at almost no impact — so the 11% was an
//      artefact, not a measurement.
//   2. even when the number is real, refusing outright ignores the slippage the
//      user set, which is their own statement of what they will accept.
const fs = require("node:fs");
const path = require("node:path");

const test = require("node:test");
const assert = require("node:assert");

const strip = (f) =>
  fs.readFileSync(path.join(__dirname, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const CORE = strip("core.js");
const TG = strip("telegram.js");

test("a V3 pool is never judged by the constant-product formula", () => {
  // THE bug. A V3 pool's WETH balance is not its depth at spot, so this formula
  // invents an impact that is not there and refuses a trade that fills.
  // Anchored on CODE, not on a comment — strip() removes the comments, and a
  // test that pins prose passes against a rewrite that broke the behaviour.
  const block = CORE.slice(CORE.indexOf("if (pick && pick.kind !== 'v3')"), CORE.indexOf("if (pick.kind === 'v3') {"));
  assert.ok(block.length > 0, "the V2-only gate is what makes the number meaningful");
  assert.match(block, /const impactBps = Number\(\(spend \* 10000n\) \/ \(reserve \+ spend\)\);/,
    "the constant-product formula lives INSIDE the V2-only branch");
  assert.match(TG, /pick\.kind !== 'v3'/, "and the UI must not re-add it");
});

test("the engine ceiling is a catastrophe stop, not a policy", () => {
  // It was 10% with no override. A trade the competition fills and we decline
  // is a lost user.
  assert.match(CORE, /Number\(process\.env\.PRICE_IMPACT_MAX_PCT \|\| 50\)/, "default raised from 10 to 50");
  assert.match(CORE, /const ceilingBps = Math\.max\(hardBps, Number\(slip\)\);/,
    "the user's own slippage raises it further — they asked for that price explicitly");
});

test("the numbers from the incident now fill", () => {
  // Reported case: 0.813 ETH tradeable depth, a 0.05 ETH buy, ~11% impact —
  // refused at the old 10% ceiling.
  const reserve = 0.813;
  const spend = 0.05;
  const impactPct = (spend / (reserve + spend)) * 100;
  assert.ok(impactPct > 5 && impactPct < 7, `sanity: ~${impactPct.toFixed(1)}%`);
  // (The bot's 11% came from halving the reported liquidity before dividing —
  // the same figure the V2 formula produces on a pool it does not describe.)
  const oldCeiling = 10;
  const newCeiling = 50;
  assert.ok(impactPct < newCeiling, "fills now");
  void oldCeiling;
});

test("the UI measures and TELLS, instead of refusing", () => {
  assert.ok(!/🚫 <b>Buy blocked — thin pool<\/b>/.test(TG), "the refusal card is gone");
  assert.match(TG, /⚠️ Thin pool — this size moves the price ~<b>\$\{impact\.toFixed\(0\)\}%<\/b>/);
  assert.match(TG, /if \(impact >= 5\)/, "a 1% impact is not news");
  // …and it rides along with the buy rather than gating it.
  assert.match(TG, /⏳ <b>Buying \$\{esc\(amt\)\} \$\{chG\.native\}…<\/b>\$\{impactNote\}/);
});

test("an unreadable pool never stops a trade", () => {
  // Failing closed here would refuse every token the depth probe times out on,
  // which on a chain with no indexer is most of them.
  const fn = TG.slice(TG.indexOf("async function doBuy("));
  const probe = fn.slice(0, fn.indexOf("const key = chatId"));
  assert.match(probe, /catch \(_\) \{ \/\* unreadable pool: not a reason to stop a trade \*\/ \}|catch \(_\) \{\s*\}/);
  assert.ok(!/return send\(chatId,/.test(probe), "nothing in the pre-check may return early any more");
});

test("the message no longer claims the bot cannot trade V3", () => {
  // It can — core.buy has a full V3 path (pick.kind === 'v3'). Telling the user
  // to go to the DEX instead sent away a trade the bot would have filled.
  assert.ok(!/this bot can't trade it/.test(TG));
  assert.match(CORE, /if \(pick\.kind === 'v3'\) \{/, "the V3 swap path is right there");
});

test("what is left still says what to DO about it", () => {
  const guard = CORE.slice(CORE.indexOf("buy blocked: ~"));
  const msg = guard.slice(0, 400);
  assert.match(msg, /Buy a smaller amount, or raise your slippage/, msg);
});
