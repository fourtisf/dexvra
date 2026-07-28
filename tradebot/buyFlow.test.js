// What a buy should tell you, in the order you want it:
//   1. going out  — how much, and at what market cap you are entering
//   2. filled     — what you spent, what you got, at what entry
//   3. then       — a live position that keeps updating itself
//
// It used to say "⏳ Buying 0.05 ETH…" and then a receipt, and the live monitor
// sat behind a 📍 button nobody taps. "At what MC did I get in" is the first
// thing anyone asks after a fill, and afterwards it can only be reconstructed.
const fs = require("node:fs");
const path = require("node:path");

const test = require("node:test");
const assert = require("node:assert");

const TG = fs
  .readFileSync(path.join(__dirname, "telegram.js"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");
const BUY = TG.slice(TG.indexOf("async function doBuy("), TG.indexOf("const SELL_ESCALATION"));
const SINGLE = BUY.slice(BUY.indexOf("if (targets.length <= 1)"), BUY.indexOf("} else {"));

test("the 'going out' message names the market cap", () => {
  assert.match(SINGLE, /const atMc = eMc > 0 \? ` at MC <b>\$\$\{fmt\(eMc\)\}<\/b>` : '';/);
  assert.match(SINGLE, /⏳ <b>Buying \$\{esc\(amt\)\} \$\{chG\.native\}<\/b>\$\{atMc\}…/);
});

test("…and going without one is never a reason to wait", () => {
  // A token with no readable price must not hold the message hostage. The line
  // goes out with a blank where the MC would be.
  assert.match(SINGLE, /Promise\.race\(\[entryP, new Promise\(\(res\) => setTimeout\(res, ENTRY_MC_WAIT_MS, null\)\)\]\)/);
  assert.match(TG, /const ENTRY_MC_WAIT_MS = 1200;/);
  assert.match(SINGLE, /const eMc = entry \? \(entry\.mcapUsd \|\| \(entry\.mcapEth \|\| 0\) \* eRate\) : 0;/);
});

test("that wait is not execution latency — the trade is already in flight", () => {
  // The whole point of the ordering work. If the snapshot were awaited BEFORE
  // core.buy, this message would have cost the user 1.2s of fill time.
  const iBuy = SINGLE.indexOf("const buying = core.buy(");
  const iSnap = SINGLE.indexOf("const entryP = withTmo(core.tokenSnapshot(");
  const iRace = SINGLE.indexOf("const entry = await Promise.race(");
  assert.ok(iBuy > -1 && iSnap > iBuy, "the snapshot starts after the buy is already going");
  assert.ok(iRace > iSnap, "and only then is anything awaited");
  assert.ok(SINGLE.indexOf("const r = await buying;") > iRace, "the fill is awaited last");
});

test("the receipt answers all three questions at once", () => {
  // Spent how much · got how many · at what entry and market cap.
  assert.match(SINGLE, /Spent: <b>\$\{spent\.toFixed\(6\)\} \$\{r\.native\}<\/b>/);
  assert.match(SINGLE, /Got: <b>\$\{fmt\(got\)\} \$\$\{esc\(r\.sym\)\}<\/b>/);
  assert.match(SINGLE, /Entry: <b>\$\$\{pxUsd\.toPrecision\(3\)\}<\/b>\$\{mcUsd > 0 \? ` · MC <b>\$\$\{fmt\(mcUsd\)\}<\/b>` : ''\}/);
});

test("one snapshot serves both, and it is the honest entry", () => {
  // It used to fetch a SECOND time after the fill — slower, and a price taken
  // seconds after the trade is not the price you entered at.
  assert.match(SINGLE, /const snap = await entryP;/);
  assert.strictEqual(
    (SINGLE.match(/core\.tokenSnapshot\(/g) || []).length,
    1,
    "exactly one snapshot call on the buy path",
  );
});

test("a filled buy opens the live position by itself", () => {
  // It already existed behind the 📍 button. Making someone tap for it after a
  // fill is asking them to do the obvious thing by hand.
  assert.match(SINGLE, /startMonitor\(chatId, ca, r\.chain, wid\)\.catch\(\(\) => \{\}\);/);
  const iReceipt = SINGLE.indexOf("await edit(chatId, pid, receipt + note, kb)");
  const iMon = SINGLE.indexOf("startMonitor(chatId, ca, r.chain, wid)");
  assert.ok(iMon > iReceipt, "the receipt lands first — the monitor follows it");
});

test("the monitor it opens is the live one, not a snapshot", () => {
  const mon = TG.slice(TG.indexOf("async function startMonitor("));
  const body = mon.slice(0, mon.indexOf("\nfunction ") > -1 ? mon.indexOf("\nfunction ") : 3000);
  assert.match(body, /setInterval\(/, "it refreshes itself");
  assert.match(body, /pinChatMessage/, "and pins, so it stays at the top of the chat");
  assert.match(body, /if \(np\.closed\)/, "…and closes when the position is gone");
});

test("a repeat buy does not stack monitors", () => {
  // Buying the same token three times must not leave three pinned trackers.
  const mon = TG.slice(TG.indexOf("async function startMonitor("));
  assert.match(mon.slice(0, 900), /const existing = _monitorByToken\.get\(tkey\);/);
  assert.match(mon.slice(0, 900), /return; \} catch \(_\) \{ stopMonitor/, "it refreshes the existing one in place");
});

test("a monitor that fails to open cannot break the buy", () => {
  // The trade is done and the money has moved by then.
  assert.match(SINGLE, /startMonitor\([^)]*\)\.catch\(\(\) => \{\}\)/);
});
