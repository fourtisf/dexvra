// The pump-alert milestone ladder.
//
// A pump alert used to fire exactly ONCE per token, at whatever the raw gain
// happened to be on the poll that caught it — which is why a token up 282%
// announced "+282%". Not a threshold anybody picked, just the number a 30-second
// poll landed on. And a token that then ran to 10x said nothing more about it.
//
// It now announces ROUND steps — +100%, +200%, +300% … up to the ceiling — one
// alert per step. These tests pin the two things that decide whether that reads
// as information or as spam: which step a gain maps to, and which steps a single
// price move is allowed to consume.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-ms-"));

const test = require("node:test");
const assert = require("node:assert");
const { milestoneFor, stepKeys, MILESTONE_STEP } = require("../src/services/pumpChecker");
const pumpConfig = require("../src/services/pumpConfig");

const MIN = pumpConfig.DEFAULT_MIN; // 100
const MAX = pumpConfig.DEFAULT_MAX; // 2000
const ms = (pct) => milestoneFor(pct, MIN, MAX);

// ---------------------------------------------------------------- the ask
test("the number announced is always a round step, never the raw gain", () => {
  // The screenshot that started this: +282% should read as +200%.
  assert.equal(ms(282.4), 200);
  for (const pct of [137, 282.4, 599.99, 1050, 1999]) {
    const m = ms(pct);
    assert.equal(m % MILESTONE_STEP, 0, `${pct}% mapped to ${m}%, which is not a round step`);
  }
});

test("the ladder runs 100 to 2000, exactly as configured", () => {
  assert.equal(ms(100), 100, "the floor itself must announce");
  assert.equal(ms(2000), 2000, "the ceiling itself must announce");
  const reachable = [];
  for (let p = MIN; p <= MAX; p += 1) { const m = ms(p); if (m != null && !reachable.includes(m)) reachable.push(m); }
  assert.deepEqual(reachable, [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000,
    1100, 1200, 1300, 1400, 1500, 1600, 1700, 1800, 1900, 2000]);
});

test("a step is only ever announced once it has actually been reached", () => {
  // Flooring, not rounding: +299% is not "+300%". Announcing a step a token has
  // not reached is the one thing that would make the number a lie.
  assert.equal(ms(299.9), 200);
  assert.equal(ms(300), 300);
  assert.equal(ms(199.9), 100);
});

test("below the floor there is no alert at all", () => {
  assert.equal(ms(0), null);
  assert.equal(ms(99.9), null);
  assert.equal(ms(-50), null, "a token DOWN from its baseline never alerts");
});

// ---------------------------------------------------------------- anti-spam
test("a token that jumps several steps at once announces ONE of them", () => {
  // 90% straight to 450% between two polls is one price move. Four alerts in one
  // second for one move is spam, so the skipped steps are consumed, not posted.
  const key = "bsc:0xabc";
  const consumed = stepKeys(key, ms(450), MIN, MAX);
  assert.deepEqual(consumed, [`${key}@100`, `${key}@200`, `${key}@300`, `${key}@400`]);
  // …and the step it announced is among them, so it can never repeat.
  assert.ok(consumed.includes(`${key}@400`));
});

test("consuming a step never consumes one above it — the climb continues", () => {
  // The whole point of the ladder: after announcing +400%, the token must still
  // be able to announce +500%.
  const key = "bsc:0xabc";
  const consumed = stepKeys(key, 400, MIN, MAX);
  for (const higher of [500, 900, 2000]) {
    assert.ok(!consumed.includes(`${key}@${higher}`), `+${higher}% was wrongly consumed at +400%`);
  }
});

test("latch keys are per token AND per step", () => {
  // Two tokens at the same step, and one token at two steps, must never collide.
  assert.notDeepEqual(stepKeys("bsc:0xaaa", 200, MIN, MAX), stepKeys("bsc:0xbbb", 200, MIN, MAX));
  assert.deepEqual(stepKeys("bsc:0xaaa", 100, MIN, MAX), ["bsc:0xaaa@100"]);
  assert.deepEqual(stepKeys("bsc:0xaaa", 200, MIN, MAX), ["bsc:0xaaa@100", "bsc:0xaaa@200"]);
});

// ---------------------------------------------------------------- admin window
test("a raised floor moves the ladder with it", () => {
  // The window is admin-configurable from @dexvraadminbot. If the operator sets
  // a 500% floor, nothing below 500% may announce — including step 400.
  assert.equal(milestoneFor(480, 500, 2000), null, "480% announced despite a 500% floor");
  assert.equal(milestoneFor(560, 500, 2000), 500);
  assert.deepEqual(stepKeys("k", 700, 500, 2000), ["k@500", "k@600", "k@700"]);
});

test("a lowered ceiling caps the ladder", () => {
  assert.equal(milestoneFor(640, 100, 600), 600, "600 is the last reachable step");
  assert.deepEqual(stepKeys("k", 600, 100, 600), ["k@100", "k@200", "k@300", "k@400", "k@500", "k@600"]);
});

test("a floor that is not a round step still yields round steps", () => {
  // An operator can type 150. The steps stay on the 100 grid; the first one that
  // clears the floor is 200.
  assert.equal(milestoneFor(180, 150, 2000), null, "100 is below the operator's floor");
  assert.equal(milestoneFor(210, 150, 2000), 200);
  assert.deepEqual(stepKeys("k", 300, 150, 2000), ["k@200", "k@300"]);
});

// ---------------------------------------------------------------- the card
test("the text card's multiple lands on a whole number, because it comes from the step", () => {
  // The default post_pump template leads with the multiple: "🚀 3.8× since
  // listing" in the screenshot that started this. A round step makes it a round
  // multiple — +200% is 3×, and never 3.8×.
  const fmt = require("../src/channels/format");
  const coin = { name: "Spy", symbol: "SPYB", chain: "bsc", address: "0x" + "a".repeat(40),
    tier: "diamond", price: 0.00816, mcap: 8_200_000, links: {}, siteUrl: "https://dexvra.io/x" };
  for (const [step, mult] of [[100, "2×"], [200, "3×"], [900, "10×"], [2000, "21×"]]) {
    const { text } = fmt.pumpPost(coin, step, 2_100_000, 8_200_000);
    assert.ok(text.includes(mult), `+${step}% should read as ${mult}, card was:\n${text}`);
    assert.ok(!/\d\.\d×/.test(text), `a step must never produce a fractional multiple:\n${text}`);
  }
  // The raw gain is exactly what used to produce the fractional one.
  assert.match(fmt.pumpPost(coin, 282.4, 2_100_000, 8_200_000).text, /3\.8×/);
});

test("the banner overlay carries the step too, not the raw gain", () => {
  // "+282%" in the screenshot came from the IMAGE overlay, not the text card —
  // pumpMedia composites `change: +N%` onto the admin's clip. Routing the step
  // to the card while leaving the picture on the raw gain would put two
  // different numbers in one alert.
  const src = fss.readFileSync(require.resolve("../src/services/pumpChecker.js"), "utf8");
  assert.match(src, /pumpMedia\(r, base, m, milestone\)/, "the overlay still gets the raw percentage");
  assert.match(src, /fmt\.pumpPost\(coin, milestone,/, "the text card still gets the raw percentage");
  assert.match(src, /x\.postPump\(coin, milestone,/, "the tweet still gets the raw percentage");
});

// ---------------------------------------------------------------- deploy safety
test("tokens that already alerted under the old latch do not re-fire on deploy", () => {
  // Before the ladder, a token latched under its BARE key. Switching to per-step
  // keys makes every one of those look un-announced — so the first poll after
  // deploy would dump an alert for every previously-pumped listing into a
  // channel with twelve thousand subscribers. The migration must consume their
  // history silently instead.
  const src = fss.readFileSync(require.resolve("../src/services/pumpChecker.js"), "utf8");
  const iLegacy = src.indexOf("if (latch.has(key))");
  const iStep = src.indexOf("if (latch.has(`${key}@${milestone}`))");
  assert.ok(iStep > -1, "the per-step latch check is missing");
  assert.ok(iLegacy > -1, "the legacy bare-key check was removed — deploying this would spam the channel");
  assert.ok(iStep < iLegacy, "the step check must run first; the legacy check is the fallback");
  // It must consume and CONTINUE — never fall through into posting.
  const block = src.slice(iLegacy, iLegacy + 500);
  assert.match(block, /latch\.addAll\(stepKeys\(/, "the migration must consume the steps below");
  assert.match(block, /continue;/, "the migration must not post");
});
