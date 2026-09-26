// ⚡ Run now, on the 🆓 Auto Listing panel — "kalo kita pencet run now bot cari
// projectnya dan langsung free listing".
//
// 🔎 Test scan answers "would anything qualify". This one ACTS on that answer,
// and the whole design is in what it does NOT bypass:
//
//   skipped  the pace WAIT, and only the wait
//   binds    the switch, the daily cap, the chain scope, the never-relist
//            ledger, and every quality floor (trigger / liquidity / volume / age)
//
// A floor with a one-tap bypass is not a floor, and this button publishes on a
// public site — the rule ⚡ Run now already follows on the trending panel.
//
// Two properties here are invisible in the REASSURING direction, which is this
// repo's most expensive recurring shape, so both are POSITIVE tests:
//
//   1  a forced run must actually LIST while the pace holds. A wiring that does
//      nothing refuses beautifully (the curveBuyPath scar, one package over).
//   2  a forced report must NOT become `state.scan`. `alScanLine` reads that
//      report's AGE as the only proof the scheduled loop is alive — so a button
//      added to diagnose a dead loop would have been the thing that hid it.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-alrun-"));
process.env.ADMIN_BOT_TOKEN = process.env.ADMIN_BOT_TOKEN || "123456:TEST_ADMIN_ALRUN";

const test = require("node:test");
const assert = require("node:assert");

const al = require("../src/services/autoLister");
const api = require("../src/api/dexvra");

const M = 1_000_000;
const MIN = 60_000;
const HOUR = 3_600_000;
const now = 1_800_000_000_000;

const healthy = (over = {}) => ({
  name: "Nine Hood",
  symbol: "NINEHOOD",
  mcap: 1.5 * M,
  liq: 120_000,
  vol24: 300_000,
  priceUsd: 0.0012,
  logoUrl: "https://dd.dexscreener.com/x.png",
  pairCreatedAt: now - 48 * HOUR,
  ...over,
});

const readState = () => JSON.parse(fss.readFileSync(path.join(process.env.BOT_DATA_DIR, "autoListerState.json"), "utf8"));

function harness(addresses, { info = healthy, listings = async () => [] } = {}) {
  const created = [];
  const real = { c: api.createListing, g: api.getListings, k: api.canCreate };
  api.canCreate = async () => ({ ok: true, status: 400, why: null });
  api.createListing = async (input) => {
    created.push(input);
    return { id: `id${created.length}`, ...input };
  };
  api.getListings = listings;
  const deps = {
    fetchDiscovery: async () => addresses.map((a) => ({ chain: "solana", address: a })),
    fetchTokenInfo: async (_chain, a) => info(a),
  };
  return {
    deps,
    created,
    restore: () => {
      api.createListing = real.c;
      api.getListings = real.g;
      api.canCreate = real.k;
    },
  };
}

/** Wipe the config AND the clock. A persisted setting that leaks turns a later
 *  test's failure into a mystery about the code under it. */
async function fresh(cfg = {}) {
  await al.reset();
  await al.resetState();
  return al.set({ enabled: true, minMcap: 1 * M, maxMcap: 1.5 * M, postChannel: false, paceListings: true, ...cfg });
}

// ── What it skips ───────────────────────────────────────────────────────────

test("⚡ Run now LISTS while the pace is holding — the wait is the one gate it steps over", async () => {
  const h = harness(["Aaa1", "Bbb2"]);
  try {
    await fresh();
    // A first scan lists one and starts the clock.
    await al.runOnce({ deps: h.deps, now, rng: () => 0.5 });
    assert.strictEqual(h.created.length, 1, "setup: the first scan must list one");
    // A SCHEDULED scan a minute later does nothing — this is the state being
    // overridden, asserted rather than assumed.
    await al.runOnce({ deps: h.deps, now: now + MIN, rng: () => 0.5 });
    assert.strictEqual(h.created.length, 1, "setup: the pace must be holding");

    const r = await al.forceRun({ deps: h.deps, now: now + 2 * MIN, rng: () => 0.5 });
    assert.strictEqual(r.busy, false);
    assert.strictEqual(r.listed, 1, "the forced run listed nothing — the wiring is inert");
    assert.strictEqual(h.created.length, 2);
    assert.ok(r.report.skippedPace, "the wait it overrode is recorded, for the verdict");
    assert.strictEqual(r.report.paced, null, "`paced` renders as 'the scan stopped for the pace' — it did not");
  } finally {
    h.restore();
  }
});

test("…and it names WHAT it listed, not just how many", async () => {
  const h = harness(["Aaa1"]);
  try {
    await fresh();
    const r = await al.forceRun({ deps: h.deps, now, rng: () => 0.5 });
    assert.strictEqual(r.listed, 1);
    assert.strictEqual(r.report.picked.length, 1);
    assert.strictEqual(r.report.picked[0].sym, "NINEHOOD");
    assert.strictEqual(r.report.picked[0].chain, "solana");
    assert.ok(r.report.picked[0].trigger >= 1 * M && r.report.picked[0].trigger <= 1.5 * M);
  } finally {
    h.restore();
  }
});

test("a forced listing STAMPS the pace clock — it is the next listing taken early, not a free extra", async () => {
  const h = harness(["Aaa1", "Bbb2"]);
  try {
    await fresh();
    await al.forceRun({ deps: h.deps, now, rng: () => 0.5 });
    assert.strictEqual(h.created.length, 1);
    // The scheduled loop must now WAIT, exactly as it would after any listing.
    const p = al.pace(al.get(), undefined, now + MIN);
    assert.strictEqual(p.due, false, "a forced listing that did not start the clock lets the loop fire again immediately");
    await al.runOnce({ deps: h.deps, now: now + MIN, rng: () => 0.5 });
    assert.strictEqual(h.created.length, 1, "the scheduled scan listed a second one — the pace was not stamped");
  } finally {
    h.restore();
  }
});

// ── What it does NOT skip ───────────────────────────────────────────────────

test("the QUALITY FLOORS bind a forced run — a floor with a one-tap bypass is not a floor", async () => {
  const cases = [
    ["below its trigger", { mcap: 0.4 * M }],
    ["thin liquidity", { liq: 10 }],
    ["low 24h volume", { vol24: 5 }],
    ["too new", { pairCreatedAt: now - 5 * MIN }],
    ["above the ceiling", { mcap: 900 * M }],
  ];
  for (const [label, over] of cases) {
    const h = harness(["Aaa1"], { info: () => healthy(over) });
    try {
      await fresh({ maxMcapHard: 50 * M });
      const r = await al.forceRun({ deps: h.deps, now, rng: () => 0.5 });
      assert.strictEqual(h.created.length, 0, `${label}: a forced run published a token the floors refuse`);
      assert.strictEqual(r.listed, 0);
      assert.ok(Object.keys(r.report.reasons).length, `${label}: it must be COUNTED, not skipped in silence`);
    } finally {
      h.restore();
    }
  }
});

test("the SWITCH binds — a service you turned off must not publish because of one tap", async () => {
  const h = harness(["Aaa1"]);
  try {
    await fresh({ enabled: false });
    const r = await al.forceRun({ deps: h.deps, now, rng: () => 0.5 });
    assert.strictEqual(h.created.length, 0);
    assert.strictEqual(r.report.off, true, "it has to be REPORTED, or the button reads as broken");
  } finally {
    h.restore();
  }
});

test("the DAILY CAP binds, and is checked before the pace", async () => {
  const h = harness(["Aaa1", "Bbb2"]);
  try {
    await fresh({ maxPerDay: 1 });
    await al.runOnce({ deps: h.deps, now, rng: () => 0.5 });
    assert.strictEqual(h.created.length, 1, "setup");
    const r = await al.forceRun({ deps: h.deps, now: now + MIN, rng: () => 0.5 });
    assert.strictEqual(h.created.length, 1);
    assert.strictEqual(r.report.capped, "1/1", "the cap is the operator's own setting — say so, never a bare 'nothing listed'");
  } finally {
    h.restore();
  }
});

test("the never-relist LEDGER binds — a forced run cannot hand back a deleted paid listing", async () => {
  const h = harness(["Aaa1"], { listings: async () => [{ chain: "solana", address: "Aaa1" }] });
  try {
    await fresh();
    const r = await al.forceRun({ deps: h.deps, now, rng: () => 0.5 });
    assert.strictEqual(h.created.length, 0);
    assert.strictEqual(r.report.known, 1);
  } finally {
    h.restore();
  }
});

// ── The report separation ───────────────────────────────────────────────────

test("⚠️ a forced report is NOT the loop's liveness proof", async () => {
  const h = harness(["Aaa1", "Bbb2", "Ccc3"]);
  try {
    // ⚠️ STATED, NEVER INHERITED: `resetState()` deliberately PRESERVES the scan
    // report (🧹 Clear history must not make a healthy loop read as dead), so
    // `fresh()` does not clear it and a test that asserted null would be
    // asserting the previous test's leftovers.
    await fresh();
    await al.runOnce({ deps: h.deps, now: now + 9 * HOUR, rng: () => 0.5 });
    const before = al.lastScan();
    assert.strictEqual(before.forced, false);
    assert.strictEqual(before.at, now + 9 * HOUR, "setup: the scheduled scan is the one that reports");

    await al.forceRun({ deps: h.deps, now: now + 10 * HOUR, rng: () => 0.5 });
    assert.strictEqual(al.lastScan().at, before.at, "a tap refreshed the loop's timestamp — that is the defect this panel exists to catch");
    assert.ok(al.lastForcedScan(), "…and the tap's own report has to be readable, or the panel has nothing to show");
    assert.strictEqual(al.lastForcedScan().forced, true);
    assert.strictEqual(al.lastForcedScan().at, now + 10 * HOUR);

    // 🧹 Clear history writes a whole fresh state object — a field missing from
    // it is a field deleted, which is how `resetAnnounceState` once dropped the
    // probe rotation. Both reports survive it.
    await al.resetState(now + 11 * HOUR);
    assert.ok(al.lastScan(), "🧹 Clear history wiped the loop's proof of life");
    assert.ok(al.lastForcedScan(), "🧹 Clear history wiped the last ⚡ Run now verdict");
  } finally {
    h.restore();
  }
});

test("…and a forced run cannot drive the blocked-scan pager", async () => {
  const h = harness(["Aaa1"], {
    listings: async () => {
      throw new Error("site down");
    },
  });
  try {
    await fresh();
    const blockedBefore = readState().blocked;
    const scanBefore = al.lastScan();
    const r = await al.forceRun({ deps: h.deps, now, rng: () => 0.5 });
    assert.match(String(r.report.blocker), /site API unreachable/, "the blocker still reaches the caller — it is the diagnosis");
    assert.strictEqual(readState().blocked, blockedBefore, "impatient taps must not page the ops channel");
    assert.strictEqual(al.lastScan() && al.lastScan().at, scanBefore && scanBefore.at, "a blocked tap must not become the loop's report either");
  } finally {
    h.restore();
  }
});

test("two scans cannot overlap — they read-modify-write the same state file", async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const h = harness(["Aaa1"]);
  h.deps.fetchDiscovery = async () => {
    await gate;
    return [{ chain: "solana", address: "Aaa1" }];
  };
  try {
    await fresh();
    const scheduled = al.runOnce({ deps: h.deps, now, rng: () => 0.5 });
    // Synchronous with the call, before the gate opens: the lock is taken.
    const forced = al.forceRun({ deps: h.deps, now, rng: () => 0.5 });
    release();
    const [, r] = await Promise.all([scheduled, forced]);
    assert.strictEqual(r.busy, true, "the tap raced the scheduled scan — two snapshots, and the later write loses the earlier one's listings");
    assert.strictEqual(h.created.length, 1, "exactly one scan may list");
  } finally {
    h.restore();
  }
});
