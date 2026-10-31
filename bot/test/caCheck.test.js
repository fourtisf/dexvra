// npm run ca:check — DRIVEN, against a DexScreener that answers the way the box
// would, because `node --check` proves syntax and every defect this repo has had
// in a check script was a runtime shape (a guard that passed on the revision it
// existed to catch, a stale log line read as this boot, a check measuring its own
// copy of the question).
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-cacheck-"));
process.env.SKIP_DOTENV = "1";

const { test, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const dexscreener = require("../src/dexscreener");
const check = require("../scripts/ca-check");

const PAIR = "0x20da3ebe08379117fdb7f15ff55456813b546554";
const TOKEN = "0x9aB1c2D3e4F5a6B7c8D9e0F1a2B3c4D5e6F7a8B9";
const pairRecord = {
  chainId: "bsc", dexId: "pancakeswap", pairAddress: PAIR,
  baseToken: { address: TOKEN, name: "Real Project", symbol: "REAL" },
  quoteToken: { address: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c", symbol: "WBNB" },
  liquidity: { usd: 54321 },
};

const realFetch = global.fetch;
afterEach(() => { global.fetch = realFetch; dexscreener.resetBench(); });

/** `mode`: "ok" — DexScreener answers; "down" — every request refused;
 *  "lies" — the pair endpoint names a DIFFERENT token (a shape drift). */
function ds(mode = "ok") {
  global.fetch = async (url) => {
    const u = String(url);
    if (mode === "down") return new Response("no", { status: 403 });
    if (u.includes(`/latest/dex/tokens/${TOKEN.toLowerCase()}`)) return new Response(JSON.stringify({ pairs: [pairRecord] }), { status: 200 });
    if (u.includes(`/latest/dex/pairs/bsc/${PAIR}`)) {
      const rec = mode === "lies" ? { ...pairRecord, baseToken: { address: "0x" + "7".repeat(40), symbol: "WRONG" } } : pairRecord;
      return new Response(JSON.stringify({ pairs: [rec] }), { status: 200 });
    }
    return new Response(JSON.stringify({ pairs: null }), { status: 200 });
  };
}

const quiet = () => { const lines = []; return { lines, print: (s) => lines.push(String(s)) }; };
const listings = (rows) => async () => rows;

test("a healthy box: the listing reads as itself and its link reads back as it — exit 0", async () => {
  ds("ok");
  const o = quiet();
  const r = await check.run({ argv: [], print: o.print, getListings: listings([{ chain: "bsc", address: TOKEN, sym: "$REAL", status: "approved" }]) });
  assert.equal(r.code, 0, o.lines.join("\n"));
  assert.ok(o.lines.some((l) => /reads back as the token/.test(l)), o.lines.join("\n"));
  assert.ok(o.lines.some((l) => /build /.test(l)), "no build stamp — a check read off a stale checkout looks current");
});

test("⚠️ a pair endpoint that names another token fails the round trip — exit 1", async () => {
  ds("lies");
  const o = quiet();
  const r = await check.run({ argv: [], print: o.print, getListings: listings([{ chain: "bsc", address: TOKEN, sym: "$REAL", status: "approved" }]) });
  assert.equal(r.code, 1, o.lines.join("\n"));
  assert.ok(o.lines.some((l) => /not the token/.test(l)), o.lines.join("\n"));
});

test("⚠️ a listing STORED AS A PAIR is named with the token it should be — exit 1", async () => {
  ds("ok");
  const o = quiet();
  const r = await check.run({ argv: [], print: o.print, getListings: listings([{ chain: "bsc", address: PAIR, sym: "$LP", status: "approved" }]) });
  assert.equal(r.code, 1);
  assert.ok(o.lines.some((l) => l.includes("STORED") || (l.includes("PAIR") && l.includes(TOKEN))), o.lines.join("\n"));
});

test("--all scans every listing for a stored pair, read-only", async () => {
  ds("ok");
  const o = quiet();
  const rows = [{ chain: "bsc", address: TOKEN, sym: "$REAL" }, { chain: "bsc", address: PAIR, sym: "$LP" }];
  const r = await check.run({ argv: ["--all"], print: o.print, getListings: listings(rows) });
  assert.equal(r.code, 1);
  assert.ok(o.lines.some((l) => l.includes(`bsc/${PAIR} is a PAIR — the token is ${TOKEN}`)), o.lines.join("\n"));
});

test("⚠️ DexScreener refusing the box is a FAULT, never a green 'nothing to check'", async () => {
  ds("down");
  const o = quiet();
  const r = await check.run({ argv: [], print: o.print, getListings: listings([{ chain: "bsc", address: TOKEN, sym: "$REAL", status: "approved" }]) });
  assert.equal(r.code, 1, o.lines.join("\n"));
  assert.ok(r.faults.includes("DexScreener did not answer"), r.faults.join(" | "));
});

test("a token DexScreener has no pair for is SKIPPED and said, not failed", async () => {
  ds("ok");
  const o = quiet();
  const other = "0x" + "5".repeat(40);
  const r = await check.run({ argv: [], print: o.print, getListings: listings([{ chain: "bsc", address: other, sym: "$NEW", status: "approved" }]) });
  assert.equal(r.code, 0, o.lines.join("\n"));
  assert.ok(o.lines.some((l) => /nothing to round-trip/.test(l)));
});

test("with an argument it drives THAT input — the reported link reads as the token", async () => {
  ds("ok");
  const o = quiet();
  const r = await check.run({ argv: [`https://dexscreener.com/bsc/${PAIR}`], print: o.print });
  assert.equal(r.code, 0);
  assert.ok(o.lines.some((l) => l.includes(`reads as ${TOKEN} on bsc`)), o.lines.join("\n"));
});

test("it asks the BOT's resolver, not a copy of the question", () => {
  const src = fss.readFileSync(path.join(__dirname, "..", "scripts", "ca-check.js"), "utf8");
  assert.ok((src.match(/caInput\.resolveInput\(/g) || []).length >= 3, "the check grew its own idea of 'is this a pair'");
  assert.ok(!/\/latest\/dex\/pairs\//.test(src), "the check asks the pair endpoint itself instead of driving caInput");
});

// ── "LIAT IN" (2026-10-31): the first live --all run ────────────────────────
// It ended "✓ no listing is stored as a pair" under a wall of
// `[ca] … taken as typed — could not ask DexScreener … (HTTP 429)`: four
// unpaced workers drew a 429, the bench parked DexScreener, and every row after
// it resolved "as typed" and was counted clean without being asked.

/** DexScreener that answers `okCalls` pair requests ("not a pair") and then
 *  refuses with a 429 — the shape of a scan running into the per-IP limit. */
function dsLimitedAfter(okCalls) {
  const seen = { pair: 0 };
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes("/latest/dex/pairs/")) {
      seen.pair++;
      if (seen.pair > okCalls) return new Response("slow down", { status: 429, headers: { "retry-after": "60" } });
      return new Response(JSON.stringify({ pairs: null }), { status: 200 });
    }
    return new Response(JSON.stringify({ pairs: null }), { status: 200 });
  };
  return seen;
}

const tok = (n) => "0x" + String(n).repeat(40).slice(0, 40);
const rowsOf = (n) => Array.from({ length: n }, (_, i) => ({ chain: "bsc", address: tok(i + 1), sym: `$T${i}`, createdAt: `2026-10-0${i + 1}` }));

test("⚠️ --all never prints ✓ over listings a refusal stopped it asking about", async () => {
  // Section 1 asks each of the 3 rows once (3 calls); section 2 gets one more
  // answer, then the 429.
  const seen = dsLimitedAfter(4);
  const o = quiet();
  const r = await check.run({ argv: ["--all"], print: o.print, getListings: listings(rowsOf(3)), gapMs: 0 });
  const out = o.lines.join("\n");
  assert.equal(r.code, 1, out);
  assert.ok(!/✓ no listing is stored as a pair/.test(out), "a green verdict over rows it never asked — the reported screen");
  assert.ok(r.faults.some((f) => /--all stopped after 1 of 3/.test(f)), r.faults.join(" | "));
  assert.ok(/were NOT checked/.test(out), out);
  assert.equal(seen.pair, 5, "it kept asking a host that had just refused it");
});

test("the stop prints the COMPLETE line that resumes it — the row it stopped on, no blank to fill", async () => {
  dsLimitedAfter(4);
  const o = quiet();
  await check.run({ argv: ["--all"], print: o.print, getListings: listings(rowsOf(3)), gapMs: 0 });
  assert.ok(o.lines.some((l) => l.trim() === "cd /opt/dexvra/bot && npm run ca:check -- --all --from=1"), o.lines.join("\n"));
});

test("--from=N resumes at row N and asks nothing before it", async () => {
  const seen = dsLimitedAfter(1e9);
  const o = quiet();
  const r = await check.run({ argv: ["--all", "--from=2"], print: o.print, getListings: listings(rowsOf(3)), gapMs: 0 });
  assert.equal(r.code, 0, o.lines.join("\n"));
  assert.equal(seen.pair, 3 + 1, "section 1 asks all three; --all from row 2 asks exactly one");
  assert.ok(o.lines.some((l) => /✓ no listing is stored as a pair .*\(1 checked\)/.test(l)), o.lines.join("\n"));
});

test("a complete scan says how many it checked", async () => {
  dsLimitedAfter(1e9);
  const o = quiet();
  const r = await check.run({ argv: ["--all"], print: o.print, getListings: listings(rowsOf(3)), gapMs: 0 });
  assert.equal(r.code, 0, o.lines.join("\n"));
  assert.ok(o.lines.some((l) => /✓ no listing is stored as a pair .*\(3 checked\)/.test(l)), o.lines.join("\n"));
});

test("--all asks ONE listing at a time, paced — never a burst at the bot's own allowance", async () => {
  dsLimitedAfter(1e9);
  const waits = [];
  let inFlight = 0;
  let peak = 0;
  const realFetchNow = global.fetch;
  global.fetch = async (u) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    try { return await realFetchNow(u); } finally { inFlight--; }
  };
  const o = quiet();
  await check.run({ argv: ["--all"], print: o.print, getListings: listings(rowsOf(4)), gapMs: 7, sleep: async (ms) => { waits.push(ms); } });
  assert.equal(peak, 1, "requests overlapped — the four-worker burst that drew the 429");
  assert.deepEqual(waits, [7, 7, 7], "no gap between rows");
});

test("the default gap is half DexScreener's documented 300/min, and a blank env is not zero", () => {
  const src = fss.readFileSync(path.join(__dirname, "..", "scripts", "ca-check.js"), "utf8");
  assert.match(src, /: 500;/, "the default pace moved");
  assert.match(src, /envGap !== ""/, "a bare CA_CHECK_GAP_MS= would read as no pacing at all");
});

test("the per-listing [ca] notes are held during --all, and the logger is restored after", async () => {
  dsLimitedAfter(4);
  const log = require("../src/helpers/logger");
  const before = log.info;
  const printed = [];
  const realLog = console.log;
  console.log = (...a) => printed.push(a.join(" "));
  try {
    await check.run({ argv: ["--all"], print: () => {}, getListings: listings(rowsOf(3)), gapMs: 0 });
  } finally {
    console.log = realLog;
  }
  assert.equal(log.info, before, "the check left the logger muted");
  // Section 1 runs unheld (3 rows, its own report); only section 2 is held, and
  // its 429 row would otherwise print `taken as typed`.
  assert.ok(!printed.some((l) => /\[ca\].*taken as typed/.test(l)), printed.join("\n"));
});

test("the resolver says when a bare address went UNCHECKED — 'not a pair' and 'could not ask' are different answers", async () => {
  const caInput = require("../src/helpers/caInput");
  dsLimitedAfter(1);
  const asked = await caInput.resolveInput(tok(1), { chain: "bsc" });
  assert.equal(asked.unverified, null, "an answered 'not a pair' was marked unchecked");
  const refused = await caInput.resolveInput(tok(2), { chain: "bsc" });
  assert.equal(refused.via, "plain", "a bare address still fails OPEN");
  assert.match(String(refused.unverified), /429/, "the refusal's reason did not travel");
});

test("⚠️ a listing whose OWN read failed once (a 503, not a refusal) is not passed on its link alone", async () => {
  // No bench is armed by a 5xx, so without its own check the round trip would
  // go on and print ✓ — over "is the listing stored as a pair?", never answered.
  let first = true;
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes(`/latest/dex/pairs/bsc/${TOKEN.toLowerCase()}`) && first) {
      first = false;
      return new Response("upstream", { status: 503 });
    }
    if (u.includes(`/latest/dex/tokens/${TOKEN.toLowerCase()}`)) return new Response(JSON.stringify({ pairs: [pairRecord] }), { status: 200 });
    if (u.includes(`/latest/dex/pairs/bsc/${PAIR}`)) return new Response(JSON.stringify({ pairs: [pairRecord] }), { status: 200 });
    return new Response(JSON.stringify({ pairs: null }), { status: 200 });
  };
  const o = quiet();
  const rows = [
    { chain: "bsc", address: TOKEN, sym: "$REAL", status: "approved", createdAt: "2026-10-02" },
    { chain: "bsc", address: "0x" + "5".repeat(40), sym: "$NEW", status: "approved", createdAt: "2026-10-01" },
  ];
  await check.run({ argv: [], print: o.print, getListings: listings(rows) });
  const real = o.lines.filter((l) => l.includes("$REAL"));
  assert.ok(real.some((l) => /could not ask DexScreener whether its own address is a pair/.test(l)), o.lines.join("\n"));
  assert.ok(!real.some((l) => /reads back as the token/.test(l)), "a ✓ over a listing whose own address was never checked");
});
