// "bagaimana agar masalah ini tidak terjadi lagi?? trending minimal harus 5 token"
//
// Three reports of the same symptom in two days, three different causes, and in
// every one of them the OPERATOR was the detector: they counted rows in the
// channel and asked. A fourth cause will turn up — so what is watched here is
// the PROMISE (every chain carries at least perChainMin), not the causes.
const test = require("node:test");
const assert = require("node:assert");
const watch = require("../src/services/trendingWatch");

const MIN = 60_000;
const chain = (over = {}) => ({ id: "ethereum", featured: 3, floor: 5, eligible: 0, fillWhy: null, gainFloor: 5, ...over });

test("a chain short for ONE cycle is not an incident", () => {
  // A slot rolling over between cycles must not page anybody.
  const t0 = 1_000_000;
  let { state, alerts } = watch.evaluate([chain()], {}, { now: t0 });
  assert.deepStrictEqual(alerts, [], "paged on the first sight of a short board");
  ({ state, alerts } = watch.evaluate([chain()], state, { now: t0 + 10 * MIN }));
  assert.deepStrictEqual(alerts, [], "still inside the grace period");
});

test("…but one that STAYS short is said out loud, once, with the reason", () => {
  const t0 = 1_000_000;
  let { state } = watch.evaluate([chain()], {}, { now: t0 });
  const late = watch.evaluate([chain()], state, { now: t0 + 60 * MIN });
  assert.strictEqual(late.alerts.length, 1);
  assert.match(late.alerts[0].text, /short on ethereum/i);
  assert.match(late.alerts[0].text, /3<\/b> on the board, minimum is <b>5/, late.alerts[0].text);
  assert.match(late.alerts[0].text, /60 min/);

  // Not once per cycle: an alert every cycle is a channel nobody reads.
  const again = watch.evaluate([chain()], late.state, { now: t0 + 75 * MIN });
  assert.deepStrictEqual(again.alerts, [], "re-paged inside the repeat window");

  // …but it does repeat eventually, or a board short for a week is one message
  // on day one that everybody has scrolled past.
  const day = watch.evaluate([chain()], late.state, { now: t0 + 60 * MIN + watch.REPEAT_MS });
  assert.strictEqual(day.alerts.length, 1, "never repeated at all");
});

test("a RECOVERY is an alert too", () => {
  // Otherwise the operator cannot tell a fixed board from a forgotten one.
  const t0 = 1_000_000;
  let { state } = watch.evaluate([chain()], {}, { now: t0 });
  ({ state } = watch.evaluate([chain()], state, { now: t0 + 60 * MIN }));
  const back = watch.evaluate([chain({ featured: 5 })], state, { now: t0 + 90 * MIN });
  assert.strictEqual(back.alerts.length, 1);
  assert.match(back.alerts[0].text, /back at target/);
  assert.deepStrictEqual(back.state, {}, "a healthy chain keeps no state");

  // A chain that recovers before anyone was told says nothing at all.
  const quiet = watch.evaluate([chain({ featured: 5 })], { ethereum: { since: t0 } }, { now: t0 + 5 * MIN });
  assert.deepStrictEqual(quiet.alerts, []);
});

test("the three causes get three different answers — that is what took three rounds", () => {
  const spares = watch.diagnose({ featured: 3, floor: 5, eligible: 4 });
  assert.strictEqual(spares.code, "spares_unusable");
  assert.match(spares.text, /down more than 15%/, "must not read as 'no listings'");
  assert.match(spares.text, /next cycle has not run yet/, "between cycles that is the other true reading");

  const failed = watch.diagnose({ featured: 3, floor: 5, eligible: 0, fillWhy: "rate limited" });
  assert.strictEqual(failed.code, "fill_failed");
  assert.match(failed.text, /rate limited/, "the filler's own reason is the diagnosis");

  const none = watch.diagnose({ featured: 0, floor: 5, eligible: 0 });
  assert.strictEqual(none.code, "no_listings");
  assert.match(none.text, /Fill from market/, "it must name the switch that fixes it");

  assert.strictEqual(watch.diagnose({ featured: 5, floor: 5, eligible: 0 }), null, "at the floor is not a problem");
  assert.strictEqual(watch.diagnose({ featured: 9, floor: 5, eligible: 0 }), null);
});

test("every chain is judged on its own — one healthy chain must not mask a short one", () => {
  const t0 = 1_000_000;
  const chains = [chain({ id: "solana", featured: 7 }), chain({ id: "base", featured: 2, eligible: 3 })];
  let { state } = watch.evaluate(chains, {}, { now: t0 });
  const late = watch.evaluate(chains, state, { now: t0 + 60 * MIN });
  assert.deepStrictEqual(late.alerts.map((a) => a.chain), ["base"]);
});
