// A DEXSCREENER URL CARRIES THE POOL, NOT THE TOKEN.
//
// Reported 2026-10-30 with https://dexscreener.com/bsc/0x20da3ebe08379117fdb7f15ff55456813b546554:
// DexScreener had the token and "the bot could not read the CA". Every reader
// in the bot asked `latest/dex/tokens/{address}`, which knows nothing about
// pools, so the link was refused as "not a valid address" and the bare pair
// address went on to be priced, tracked — and LISTED — as if it were the token.
//
// These tests drive the shared rule (shared/dexscreener/pair.js), the bot's
// bench-aware lookup (dexscreener.fetchPairX) and the one helper every flow
// calls (helpers/caInput.js) against a stubbed DexScreener. The wiring tests
// that drive the real handlers live in caInputWiring.test.js.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = process.env.BOT_DATA_DIR || fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-dexpair-"));

const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const dsPair = require("../../shared/dexscreener/pair");
const dexscreener = require("../src/dexscreener");
const caInput = require("../src/helpers/caInput");

// The address from the report — as it appears in the URL, i.e. the POOL.
const PAIR = "0x20da3ebe08379117fdb7f15ff55456813b546554";
const TOKEN = "0x9aB1c2D3e4F5a6B7c8D9e0F1a2B3c4D5e6F7a8B9";
const WBNB = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
const LINK = `https://dexscreener.com/bsc/${PAIR}`;

const pairRecord = (over = {}) => ({
  chainId: "bsc",
  dexId: "pancakeswap",
  url: LINK,
  pairAddress: PAIR,
  labels: ["v2"],
  baseToken: { address: TOKEN, name: "Real Project", symbol: "REAL" },
  quoteToken: { address: WBNB, name: "Wrapped BNB", symbol: "WBNB" },
  priceUsd: "0.0123",
  liquidity: { usd: 54321 },
  ...over,
});

const realFetch = global.fetch;
let calls = [];
/** Route by URL. `routes` maps a substring to a body (or a function → Response). */
function stub(routes) {
  calls = [];
  global.fetch = async (url) => {
    const u = String(url);
    calls.push(u);
    for (const [frag, ans] of Object.entries(routes)) {
      if (!u.includes(frag)) continue;
      if (typeof ans === "function") return ans(u);
      return new Response(JSON.stringify(ans), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ schemaVersion: "1.0.0", pairs: null }), { status: 200 });
  };
}
beforeEach(() => dexscreener.resetBench());
afterEach(() => {
  global.fetch = realFetch;
  dexscreener.resetBench();
});

// ── parseLink ────────────────────────────────────────────────────────────────

test("a DexScreener link is read as chain + address, in every spelling people paste", () => {
  for (const s of [
    LINK,
    `  ${LINK}  `,
    `https://www.dexscreener.com/bsc/${PAIR}`,
    `dexscreener.com/bsc/${PAIR}`,
    `${LINK}?maker=0xabc`,
    `${LINK}#chart`,
    `HTTPS://DexScreener.com/BSC/${PAIR}`,
  ]) {
    const r = dsPair.parseLink(s);
    assert.ok(r, `should parse: ${s}`);
    assert.equal(r.slug, "bsc");
    assert.equal(r.address.toLowerCase(), PAIR);
  }
  // A search link has an address and no chain.
  assert.deepEqual(dsPair.parseLink(`https://dexscreener.com/search?q=${PAIR}`), { slug: null, address: PAIR });
  // Solana pools are base58 and case-SENSITIVE: kept exactly as typed.
  const sol = "8sLbNZoA1cfnvMJLPfp98ZLAnFSYCFApfJKMbiXNLwxj";
  assert.deepEqual(dsPair.parseLink(`https://dexscreener.com/solana/${sol}`), { slug: "solana", address: sol });
});

test("⚠️ only a dexscreener.com link counts, and only when it IS the message", () => {
  for (const s of [
    "https://dexscreener.com/new-pairs/bsc", // a list page, not a pair
    "https://dexscreener.com/gainers",
    `https://evil.example/dexscreener.com/bsc/${PAIR}`, // the host is not dexscreener
    `https://dexscreener.com.evil.example/bsc/${PAIR}`,
    `look at this ${LINK}`, // a link inside a sentence is talk, not input
    `${LINK}?maker=0xabc look at this`, // …and so is one with words after its query string
    PAIR, // a bare address is not a link
    "",
  ]) {
    assert.equal(dsPair.parseLink(s), null, `should refuse: ${s}`);
  }
});

// ── resolvePairX ─────────────────────────────────────────────────────────────

test("a pair resolves to its BASE token, from the documented pair endpoint, in one request", async () => {
  stub({ [`/latest/dex/pairs/bsc/${PAIR}`]: { pairs: [pairRecord()] } });
  const r = await dsPair.resolvePairX(PAIR, { slugs: ["bsc"] });
  assert.equal(r.ok, true);
  assert.equal(r.pair.token.address, TOKEN);
  assert.equal(r.pair.token.symbol, "REAL");
  assert.equal(r.pair.quote.symbol, "WBNB");
  assert.equal(calls.length, 1);
  assert.match(calls[0], /api\.dexscreener\.com\/latest\/dex\/pairs\/bsc\//);
});

test("⚠️ the match is EXACT — a pair in the answer with another address is not taken", async () => {
  stub({ "/latest/dex/pairs/": { pairs: [pairRecord({ pairAddress: "0x1111111111111111111111111111111111111111" })] } });
  const r = await dsPair.resolvePairX(PAIR, { slugs: ["bsc"] });
  assert.equal(r.ok, true);
  assert.equal(r.pair, null);
});

test("EVM hex matches whatever its case; base58 must match exactly", () => {
  assert.equal(dsPair.sameAddress(PAIR.toUpperCase().replace("0X", "0x"), PAIR), true);
  assert.equal(dsPair.sameAddress("8sLbNZoA1cfnvMJLPfp98ZLAnFSYCFApfJKMbiXNLwxj", "8slbnzoa1cfnvmjlpfp98zlanfsycfapfjkmbixnlwxj"), false);
  // Older schema versions spell it `pair: {...}`.
  assert.equal(dsPair.pickPair({ pair: pairRecord() }, PAIR.toUpperCase().replace("0X", "0x")).baseToken.address, TOKEN);
});

test("'not a pair' and 'could not ask' are different answers — and a 404 is an answer", async () => {
  stub({ "/latest/dex/pairs/": { schemaVersion: "1.0.0", pairs: null } });
  assert.deepEqual(await dsPair.resolvePairX(TOKEN, { slugs: ["bsc"] }), { ok: true, pair: null, why: null });

  stub({ "/latest/dex/pairs/": () => new Response("nope", { status: 404 }) });
  assert.equal((await dsPair.resolvePairX(TOKEN, { slugs: ["bsc"] })).ok, true);

  stub({ "/latest/dex/pairs/": () => new Response("slow down", { status: 429 }) });
  const r = await dsPair.resolvePairX(TOKEN, { slugs: ["bsc"] });
  assert.equal(r.ok, false);
  assert.match(r.why, /429/);
});

test("several chains are asked at once, and a failure elsewhere cannot hide a hit", async () => {
  stub({
    "/pairs/ethereum/": () => new Response("x", { status: 500 }),
    "/pairs/bsc/": { pairs: [pairRecord()] },
  });
  const r = await dsPair.resolvePairX(PAIR, { slugs: ["ethereum", "bsc", "base"] });
  assert.equal(r.ok, true);
  assert.equal(r.pair.chainId, "bsc");
  assert.equal(calls.length, 3);
});

test("the FIRST chain's reason is the one reported — a later dead socket cannot bury a refusal", async () => {
  stub({
    "/pairs/ethereum/": () => new Response("slow down", { status: 429 }),
    "/pairs/bsc/": () => { throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } }); },
  });
  const r = await dsPair.resolvePairX(PAIR, { slugs: ["ethereum", "bsc"] });
  assert.equal(r.ok, false);
  assert.match(r.why, /429/);
});

// ── the bot's bench-aware lookup ─────────────────────────────────────────────

test("fetchPairX maps our chain keys onto DexScreener's slugs and back", async () => {
  stub({ "/pairs/seiv2/": { pairs: [pairRecord({ chainId: "seiv2" })] } });
  const r = await dexscreener.fetchPairX(PAIR, ["sei"]);
  assert.equal(r.pair.chain, "sei"); // DexScreener spells Sei `seiv2`
  assert.match(calls[0], /\/pairs\/seiv2\//);
});

test("⚠️ a refusal parks DexScreener for every caller — the second lookup makes no request", async () => {
  stub({ "/latest/dex/pairs/": () => new Response("blocked", { status: 403 }) });
  const first = await dexscreener.fetchPairX(PAIR, ["bsc"]);
  assert.equal(first.ok, false);
  assert.equal(calls.length, 1);
  const second = await dexscreener.fetchPairX(PAIR, ["bsc"]);
  assert.equal(second.ok, false);
  assert.match(second.why, /refusing this server/);
  assert.equal(calls.length, 1, "the bench must stop the request, not just label it");
});

// ── caInput: the helper every flow calls ─────────────────────────────────────

test("the reported link resolves to the TOKEN, on BNB Chain", async () => {
  stub({ [`/pairs/bsc/${PAIR}`]: { pairs: [pairRecord()] } });
  const r = await caInput.resolveInput(LINK);
  assert.equal(r.via, "pair");
  assert.equal(r.address, TOKEN);
  assert.equal(r.chain, "bsc");
  assert.equal(r.refused, null);
  assert.equal(calls.length, 1, "the link names its chain — exactly one request");
});

test("a link to a TOKEN page (not a pair) keeps its address and its chain", async () => {
  stub({});
  const r = await caInput.resolveInput(`https://dexscreener.com/bsc/${TOKEN}`);
  assert.equal(r.via, "link");
  assert.equal(r.address, TOKEN);
  assert.equal(r.chain, "bsc");
});

test("⚠️ a link we cannot verify is REFUSED — it is almost always a pair, and a pair must not be used as a token", async () => {
  stub({ "/latest/dex/pairs/": () => new Response("down", { status: 503 }) });
  const r = await caInput.resolveInput(LINK);
  assert.ok(r.refused, "must say why instead of guessing");
  assert.match(r.refused, /503/);
});

test("a link on a network Dexvra does not run is refused, naming it", async () => {
  stub({});
  const r = await caInput.resolveInput(`https://dexscreener.com/notachain/${PAIR}`);
  assert.match(r.refused, /notachain/);
  assert.equal(calls.length, 0, "no request for a chain we cannot use");
});

test("a bare PAIR address on a fixed chain resolves to its token", async () => {
  stub({ [`/pairs/bsc/${PAIR}`]: { pairs: [pairRecord()] } });
  const r = await caInput.resolveInput(PAIR, { chain: "bsc" });
  assert.equal(r.via, "pair");
  assert.equal(r.address, TOKEN);
  assert.equal(calls.length, 1);
});

test("⚠️ a bare address FAILS OPEN when DexScreener cannot be asked — the intake must not die with an indexer", async () => {
  stub({ "/latest/dex/pairs/": () => new Response("blocked", { status: 403 }) });
  const r = await caInput.resolveInput(TOKEN, { chain: "bsc" });
  assert.equal(r.via, "plain");
  assert.equal(r.address, TOKEN);
  assert.equal(r.refused, null);
});

test("a bare TOKEN address is returned as typed", async () => {
  stub({});
  const r = await caInput.resolveInput(TOKEN, { chain: "bsc" });
  assert.deepEqual({ via: r.via, address: r.address, chain: r.chain }, { via: "plain", address: TOKEN, chain: "bsc" });
});

test("a dexvra.io link needs no request at all", async () => {
  stub({});
  const r = await caInput.resolveInput(`https://dexvra.io/token/bsc/${TOKEN}`);
  assert.deepEqual({ via: r.via, address: r.address, chain: r.chain }, { via: "dexvra", address: TOKEN, chain: "bsc" });
  assert.equal(calls.length, 0);
});

test("chatter is not an address", async () => {
  stub({});
  assert.equal(await caInput.resolveInput("hello there"), null);
  assert.equal(await caInput.resolveInput(""), null);
  assert.equal(calls.length, 0);
});

test("resolveInputSoon gives up on a hung DexScreener instead of holding a person's flow", async () => {
  global.fetch = () => new Promise(() => {});
  const t0 = Date.now();
  const r = await caInput.resolveInputSoon(LINK, {}, 60);
  assert.equal(r, null);
  assert.ok(Date.now() - t0 < 1000);
});

test("probeChains is the buy bot's candidate list — one owner, re-exported", () => {
  const setup = require("../src/group/setup");
  assert.equal(setup.candidateChains, caInput.probeChains);
  assert.deepEqual(caInput.probeChains(PAIR), ["ethereum", "bsc", "base", "robinhood", "plasma", "elysium"]);
  assert.deepEqual(caInput.probeChains("8sLbNZoA1cfnvMJLPfp98ZLAnFSYCFApfJKMbiXNLwxj"), ["solana"]);
});
