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
