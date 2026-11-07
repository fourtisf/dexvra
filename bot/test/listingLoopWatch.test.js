// "bagaimana agar free listing selalu bekerja" — the layer that was missing.
//
// `listingWatch` answers "are free listings actually going out", and it is
// folded into `fileReport`: it runs INSIDE the scan. So the one state it can
// never see is the scan not happening at all — a stopped loop files no report,
// evaluates no watch, and free listings end in silence with the panel still
// reading 🟢 ON. That is the nine-hour `autoTrend` outage, on the other service,
// and the lesson it left is the one being applied here:
//
//   ⚠️ A guard written inside the thing it guards cannot see the thing not
//     being called.
//
// So the question is asked from a timer that is NOT the loop's own — the health
// monitor, which is watching anyway — and `autoLister.loopHealth` is the ONE
// owner of the answer, because the panel renders it in the other process and
// two copies of "has the scanner gone quiet" drift.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-alloop-"));

const test = require("node:test");
const assert = require("node:assert");

const al = require("../src/services/autoLister");
const health = require("../src/services/healthMonitor");
const log = require("../src/helpers/logger");

const MIN = 60_000;
const now = 1_800_000_000_000;
const cfg = { enabled: true, minGapMin: 25, maxGapMin: 90 };
// Two full gaps plus slack = 190 min. Stated here so the fixtures below cannot
// drift from the rule silently.
const STALE = al.staleAfterMs(cfg);

// ── loopHealth: the one owner ───────────────────────────────────────────────

test("the stale bound is two full scan gaps plus slack", () => {
  assert.strictEqual(STALE, 2 * 90 * MIN + 10 * MIN);
});

test("a fresh report is a live loop; an old one is not", () => {
  const fresh = al.loopHealth({ now, cfg, scan: { at: now - 30 * MIN }, halt: null, upMs: 1e9 });
  assert.strictEqual(fresh.state, "ok");
  const old = al.loopHealth({ now, cfg, scan: { at: now - STALE - MIN }, halt: null, upMs: 1e9 });
  assert.strictEqual(old.state, "stale");
  assert.strictEqual(old.ageMs, STALE + MIN);
});

test("⚠️ a RESTART is not a dead loop — the report on disk outlives the process", () => {
  // `lastScan()` is persisted, so a box that was down for a day comes back
  // holding a day-old report and a perfectly healthy loop that has simply not
  // reached its first scan yet. Judging then accuses the restart of being the
  // fault.
  const justUp = al.loopHealth({ now, cfg, scan: { at: now - 24 * 60 * MIN }, halt: null, upMs: 2 * MIN });
  assert.strictEqual(justUp.state, "booting");
  const neverUp = al.loopHealth({ now, cfg, scan: null, halt: null, upMs: 2 * MIN });
  assert.strictEqual(neverUp.state, "booting");
  // …and once it has had a full gap to file one, it IS judged.
  const settled = al.loopHealth({ now, cfg, scan: null, halt: null, upMs: (90 + 6) * MIN });
  assert.strictEqual(settled.state, "never");
});

test("⚠️ a HALT outranks staleness — one fault, one alert", () => {
  // A halt is the loop RUNNING and refusing to write, which is exactly why no
  // report reaches the file. Reporting it as a dead loop sends the operator to
  // pm2 to hunt a process that is running perfectly.
  const h = al.loopHealth({ now, cfg, scan: { at: now - STALE - MIN }, halt: { at: now - MIN, why: "cannot read autoLister.json" }, upMs: 1e9 });
  assert.strictEqual(h.state, "halted");
  assert.match(String(h.why), /cannot read/);
});

test("⚠️ the SWITCH is reported, never a state — an OFF service can still have a dead loop", () => {
  // An OFF service still files a report every scan (deliberately: a stale report
  // has to mean the LOOP stopped, and it can only mean that if every other
  // reason files one). So a stale report while OFF still means the loop is dead,
  // and the panel must be able to say so. What the switch decides is whether it
  // is worth PAGING for — the caller's call, not this function's.
  const h = al.loopHealth({ now, cfg: { ...cfg, enabled: false }, scan: { at: now - STALE - MIN }, halt: null, upMs: 1e9 });
  assert.strictEqual(h.state, "stale", "the switch swallowed the loop's state");
  assert.strictEqual(h.enabled, false);
});

// ── the pager ───────────────────────────────────────────────────────────────

function monitor(healthOf) {
  const alerts = [];
  const realAlert = log.alert;
  const realHealth = al.loopHealth;
  const realGet = al.get;
  log.alert = (t) => alerts.push(String(t));
  al.get = () => cfg;
  al.loopHealth = ({ now: n }) => healthOf(n);
  health._test.faults.clear();
  health._test.setStartedAt(now - 10 * 60 * MIN); // long up, so `upMs` never gates
  return {
    alerts,
    check: (n) => health._test.checkAutoLister(n),
    restore: () => {
      log.alert = realAlert;
      al.loopHealth = realHealth;
      al.get = realGet;
      health._test.faults.clear();
    },
  };
}

const state = (s, over = {}) => ({ state: s, enabled: true, staleMs: STALE, ageMs: 200 * MIN, why: null, ...over });

test("a dead loop PAGES — after the grace, once, and not before", () => {
  const m = monitor(() => state("stale"));
  try {
    m.check(now);
    assert.deepStrictEqual(m.alerts, [], "it paged on the first bad pass — a single slow pass would wake someone");
    m.check(now + 9 * MIN);
    assert.deepStrictEqual(m.alerts, []);
    m.check(now + 11 * MIN);
    assert.strictEqual(m.alerts.length, 1);
    assert.match(m.alerts[0], /gone quiet/i);
    assert.match(m.alerts[0], /listing:check/, "a diagnosis with no hands attached is a bug report the code files against its owner");
    m.check(now + 60 * MIN);
    assert.strictEqual(m.alerts.length, 1, "it paged twice — a monitor that repeats gets muted");
  } finally {
    m.restore();
  }
});

test("…and says so when it recovers", () => {
  let dead = true;
  const m = monitor(() => state(dead ? "stale" : "ok"));
  try {
    m.check(now);
    m.check(now + 11 * MIN);
    assert.strictEqual(m.alerts.length, 1);
    dead = false;
    m.check(now + 20 * MIN);
    assert.strictEqual(m.alerts.length, 2);
    assert.match(m.alerts[1], /reporting again/i, "a fixed outage and a forgotten one look identical without this");
  } finally {
    m.restore();
  }
});

test("⚠️ it does NOT page for a switch, a halt, or a restart", () => {
  for (const [label, h] of [
    ["OFF", state("stale", { enabled: false })],
    ["halted", state("halted")],
    ["booting", state("booting")],
    ["ok", state("ok")],
  ]) {
    const m = monitor(() => h);
    try {
      m.check(now);
      m.check(now + 11 * MIN);
      m.check(now + 120 * MIN);
      assert.deepStrictEqual(m.alerts, [], `${label} paged — that sends the operator to the wrong layer`);
    } finally {
      m.restore();
    }
  }
});

test("⚠️ switching it OFF clears the page SILENTLY — '✅ reporting again' would be false", () => {
  let off = false;
  const m = monitor(() => state("stale", { enabled: !off }));
  try {
    m.check(now);
    m.check(now + 11 * MIN);
    assert.strictEqual(m.alerts.length, 1);
    off = true;
    m.check(now + 20 * MIN);
    assert.strictEqual(m.alerts.length, 1, "it claimed the service was scanning again after the operator turned it off");
    assert.strictEqual(health._test.faults.has("autolist"), false, "the fault has to clear, or a later re-enable never pages");
  } finally {
    m.restore();
  }
});

test("a loopHealth that throws must never take the monitor down with it", () => {
  const m = monitor(() => {
    throw new Error("state file on fire");
  });
  try {
    assert.doesNotThrow(() => m.check(now));
    assert.deepStrictEqual(m.alerts, []);
  } finally {
    m.restore();
  }
});

// ── the wiring, and the one owner ───────────────────────────────────────────

test("⚠️ the check is WIRED INTO the monitor's pass — a guard nobody calls is no guard", async () => {
  // Every test above calls `checkAutoLister` directly, so all of them pass on a
  // build where it was never added to `runOnce`. This one drives the real pass.
  const alerts = [];
  const realAlert = log.alert;
  const realHealth = al.loopHealth;
  const realGet = al.get;
  log.alert = (t) => alerts.push(String(t));
  al.get = () => cfg;
  al.loopHealth = () => state("stale");
  health._test.faults.clear();
  health._test.setStartedAt(now - 10 * 60 * MIN);
  health._test.setState({ boots: [], lastHeartbeatDate: new Date(now).toISOString().slice(0, 10) });
  const tg = { getMe: async () => ({ id: 1 }) };
  try {
    await health._test.runOnce(tg, now);
    await health._test.runOnce(tg, now + 11 * MIN);
    assert.strictEqual(alerts.filter((a) => /gone quiet/i.test(a)).length, 1, "the monitor's pass never asked about the scan loop");
  } finally {
    log.alert = realAlert;
    al.loopHealth = realHealth;
    al.get = realGet;
    health._test.faults.clear();
  }
});

test("⚠️ ONE OWNER — the panel may not grow its own idea of 'gone quiet'", () => {
  // Two copies of this predicate in two processes drift, and this repo has
  // already paid for exactly that (`trending:check` growing its own copy of
  // `countOpened` two lines under the comment explaining what the last one
  // cost). The scan reads CODE, not comments — the note beside the fix quotes
  // the rule it forbids.
  const src = fss
    .readFileSync(path.join(__dirname, "..", "src", "admin", "adminBot.js"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
  assert.ok(/autoLister\.loopHealth\(/.test(src), "the panel stopped reading the one owner");
  assert.ok(!/maxGapMin\s*\*\s*60_?000/.test(src), "adminBot.js is computing the stale bound itself again");
  // …and the scan is not vacuous: it must be the stripping that makes it pass.
  const raw = fss.readFileSync(path.join(__dirname, "..", "src", "admin", "adminBot.js"), "utf8");
  assert.ok(raw.length > src.length, "nothing was stripped — the guard would pass on a comment");
});
