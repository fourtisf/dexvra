// The `[ca]` lines — so the next "the bot can't read this CA" is found with
// grep, not with a screenshot. The card a person sees says it in chat; a chat is
// not something an operator can search.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-calog-"));

const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const log = require("../src/helpers/logger");
const dexscreener = require("../src/dexscreener");
const caInput = require("../src/helpers/caInput");

const PAIR = "0x20da3ebe08379117fdb7f15ff55456813b546554";
const TOKEN = "0x9aB1c2D3e4F5a6B7c8D9e0F1a2B3c4D5e6F7a8B9";
const LINK = `https://dexscreener.com/bsc/${PAIR}`;
const rec = { chainId: "bsc", dexId: "pancakeswap", pairAddress: PAIR, baseToken: { address: TOKEN, symbol: "REAL" }, quoteToken: { symbol: "WBNB" } };

const realFetch = global.fetch;
const real = { info: log.info, warn: log.warn };
let lines;
beforeEach(() => {
  lines = [];
  log.info = (...a) => lines.push(["info", a.join(" ")]);
  log.warn = (...a) => lines.push(["warn", a.join(" ")]);
  dexscreener.resetBench();
});
afterEach(() => { global.fetch = realFetch; Object.assign(log, real); dexscreener.resetBench(); });

const answering = () => { global.fetch = async (u) => new Response(JSON.stringify(String(u).includes(`/pairs/bsc/${PAIR}`) ? { pairs: [rec] } : { pairs: null }), { status: 200 }); };
const refusing = () => { global.fetch = async () => new Response("no", { status: 503 }); };

test("a pair resolved to its token is a [ca] INFO line naming both, short", async () => {
  answering();
  await caInput.resolveInput(LINK);
  const l = lines.find(([lvl, s]) => lvl === "info" && s.startsWith("[ca]"));
  assert.ok(l, JSON.stringify(lines));
  assert.match(l[1], /DexScreener pair on bsc/);
  assert.match(l[1], /0x20da…6554/);
  assert.match(l[1], /\$REAL/);
});

test("⚠️ a link refused because DexScreener could not be ASKED is a WARN — the ops channel, de-duplicated", async () => {
  refusing();
  const r = await caInput.resolveInput(LINK);
  assert.ok(r.refused);
  const w = lines.find(([lvl, s]) => lvl === "warn" && s.startsWith("[ca]"));
  assert.ok(w, JSON.stringify(lines));
  assert.ok(!w[1].includes(PAIR), "an address in the line makes every paste its own dedupe key — one fault would page once per link");
  assert.match(w[1], /503/, "the reason was dropped");
});

test("a bare address taken as typed because DexScreener could not be asked SAYS so", async () => {
  refusing();
  const r = await caInput.resolveInput(TOKEN);
  assert.equal(r.via, "plain");
  assert.ok(lines.some(([lvl, s]) => lvl === "info" && /taken as typed — could not ask DexScreener/.test(s)), JSON.stringify(lines));
});

test("a plain token DexScreener answered about writes nothing — a line per normal paste is noise", async () => {
  answering();
  await caInput.resolveInput(TOKEN);
  assert.deepEqual(lines.filter(([, s]) => s.startsWith("[ca]")), []);
});
