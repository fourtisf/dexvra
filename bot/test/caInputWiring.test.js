// EVERY DOOR A CONTRACT COMES IN THROUGH, DRIVEN.
//
// dexPair.test.js proves the rule; this proves the flows CALL it — a unit test
// of the helper passes beside a handler that never asks it (the curveBuyPath
// scar). Each test pastes the reported DexScreener link, or the bare pair
// address its URL carries, into the real handler and asserts the TOKEN is what
// got stored: on the listing form, in the buy bot's config, on the Mass DM
// order, and in the Trending lookup.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-cawire-"));
process.env.LISTING_AUTOFILL_MS = "200";
process.env.CA_RESOLVE_MS = "3000";
process.env.CA_INPUT_MS = "1000"; // the floor — read at require time, so before any require

const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const dexscreener = require("../src/dexscreener");
const listing = require("../src/handlers/listing");
const listedGuard = require("../src/helpers/listedGuard");
const groupSetup = require("../src/group/setup");
const cfg = require("../src/group/config");
const gt = require("../src/group/gtPairs");
const chainPools = require("../src/group/chainPools");
const massdm = require("../src/handlers/massdm");
const trending = require("../src/handlers/trending");
const api = require("../src/api/dexvra");

const PAIR = "0x20da3ebe08379117fdb7f15ff55456813b546554"; // the address in the report's URL
const TOKEN = "0x9aB1c2D3e4F5a6B7c8D9e0F1a2B3c4D5e6F7a8B9";
const WBNB = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
const LINK = `https://dexscreener.com/bsc/${PAIR}`;

const pairRecord = {
  chainId: "bsc",
  dexId: "pancakeswap",
  pairAddress: PAIR,
  baseToken: { address: TOKEN, name: "Real Project", symbol: "REAL" },
  quoteToken: { address: WBNB, name: "Wrapped BNB", symbol: "WBNB" },
  priceUsd: "0.0123",
  marketCap: 1230000,
  liquidity: { usd: 54321 },
  volume: { h24: 9876 },
  txns: { h24: { buys: 10, sells: 4 } },
};

const realFetch = global.fetch;
let dsDown = false;
let calls = [];
/** DexScreener as the box sees it: the token endpoint knows nothing about the
 *  pair; the pair endpoint does. Everything else answers "nothing here". */
function fakeFetch() {
  calls = [];
  global.fetch = async (url) => {
    const u = String(url);
    calls.push(u);
    if (dsDown && u.includes("dexscreener")) return new Response("down", { status: 503 });
    if (u.includes(`/latest/dex/pairs/bsc/${PAIR}`)) return new Response(JSON.stringify({ pairs: [pairRecord] }), { status: 200 });
    if (u.includes("/latest/dex/")) return new Response(JSON.stringify({ pairs: null }), { status: 200 });
    return new Response("{}", { status: 404 });
  };
}

const real = {
  fetchPool: gt.fetchPool,
  fetchTokenInfo: gt.fetchTokenInfo,
  supports: chainPools.supports,
  tokenMeta: chainPools.tokenMeta,
  block: listedGuard.blockIfListed,
  getListings: api.getListings,
  lookups: { ...listing._lookups },
};
beforeEach(() => {
  dsDown = false;
  dexscreener.resetBench();
  fakeFetch();
  gt.fetchPool = async () => null; // GeckoTerminal has never heard of the PAIR as a token
  gt.fetchTokenInfo = async () => null;
  chainPools.supports = () => false;
  chainPools.tokenMeta = async () => null;
  listedGuard.blockIfListed = async () => false;
});
afterEach(() => {
  global.fetch = realFetch;
  Object.assign(gt, { fetchPool: real.fetchPool, fetchTokenInfo: real.fetchTokenInfo });
  Object.assign(chainPools, { supports: real.supports, tokenMeta: real.tokenMeta });
  listedGuard.blockIfListed = real.block;
  api.getListings = real.getListings;
  Object.assign(listing._lookups, real.lookups);
  dexscreener.resetBench();
});

const said = (ctx) => ctx.replies.map((r) => String(r.text)).join("\n---\n");

// ── the listing form ─────────────────────────────────────────────────────────

function listingCtx(text, chain = "bsc") {
  const replies = [];
  return {
    replies,
    chat: { id: 7, type: "private" },
    from: { id: 7 },
    session: { type: "xpress_listing", form: { ...listing._test.emptyForm(), chain }, awaitingField: "address" },
    message: { text },
    reply: async (t, extra) => (replies.push({ text: String(t), extra }), { message_id: replies.length }),
    replyWithPhoto: async (p, extra) => (replies.push({ text: String((extra && extra.caption) || "") }), { message_id: replies.length }),
    telegram: { deleteMessage: async () => {} },
    answerCbQuery: async () => {},
  };
}
function recordLookups() {
  const asked = [];
  listing._lookups.fetchTokenInfo = async (chain, addr) => (asked.push(addr), { name: "Real Project", symbol: "REAL" });
  listing._lookups.fetchMarket = async () => null;
  listing._lookups.fetchTokenDescription = async () => null;
  return asked;
}

test("⚠️ the reported LINK, pasted into the listing form, lists the TOKEN — never the pool", async () => {
  const asked = recordLookups();
  const ctx = listingCtx(LINK);
  await listing.handleText(ctx);
  assert.equal(ctx.session.form.address, TOKEN);
  assert.ok(asked.every((a) => a === TOKEN), `autofill was asked about ${asked.join(", ")}`);
  assert.match(said(ctx), /DexScreener pair/, "the substitution is said out loud");
  assert.doesNotMatch(said(ctx), /doesn't look like a valid/, "a link is no longer 'not a valid address'");
});

test("the bare PAIR address from the URL lists the token too", async () => {
  recordLookups();
  const ctx = listingCtx(PAIR);
  await listing.handleText(ctx);
  assert.equal(ctx.session.form.address, TOKEN);
});

test("a link names its own network, and it wins over the chain picked a screen earlier", async () => {
  recordLookups();
  const ctx = listingCtx(LINK, "ethereum");
  await listing.handleText(ctx);
  assert.equal(ctx.session.form.chain, "bsc");
  assert.equal(ctx.session.form.address, TOKEN);
});

test("⚠️ a link DexScreener cannot be asked about is REFUSED, and nothing is stored", async () => {
  recordLookups();
  dsDown = true;
  const ctx = listingCtx(LINK);
  await listing.handleText(ctx);
  assert.equal(ctx.session.form.address, null);
  assert.match(said(ctx), /Couldn't read that link/);
});

test("⚠️ a link whose lookup HANGS is refused as unreadable — never 'not a valid address', never stored", async () => {
  recordLookups();
  listing._lookups.resolveInput = () => new Promise(() => {});
  const ctx = listingCtx(LINK);
  await listing.handleText(ctx);
  assert.equal(ctx.session.form.address, null);
  assert.match(said(ctx), /Couldn't read that link/);
  assert.doesNotMatch(said(ctx), /doesn't look like a valid/, "a timeout is about us, not about their address");
});

test("a plain token address still goes straight through when DexScreener is down", async () => {
  const asked = recordLookups();
  dsDown = true;
  const ctx = listingCtx(TOKEN);
  await listing.handleText(ctx);
  assert.equal(ctx.session.form.address, TOKEN);
  assert.deepEqual([...new Set(asked)], [TOKEN]);
});

// ── the buy bot ──────────────────────────────────────────────────────────────

function groupCtx(text, chatId) {
  const c = {
    chat: { id: chatId, type: "supergroup" },
    from: { id: 7 },
    message: { text, message_id: 5 },
    telegram: { getChatMember: async () => ({ status: "administrator" }) },
    replies: [],
  };
  c.reply = async (t, extra) => (c.replies.push({ text: t, extra }), { message_id: 99 });
  return c;
}

test("⚠️ /settoken with the reported link watches THAT pool, stored under the TOKEN", async () => {
  const ctx = groupCtx(`/settoken ${LINK}`, -3001);
  await groupSetup.settoken(ctx);
  const g = cfg.get(-3001);
  assert.ok(g, `nothing configured — said: ${said(ctx)}`);
  assert.equal(g.chain, "bsc");
  assert.equal(g.address, TOKEN, "the token, never the pool");
  assert.equal(g.pairAddress, PAIR, "the pool the admin pointed at is the one watched");
  assert.equal(g.sym, "REAL");
});

test("/settoken with the bare pair address resolves the same way", async () => {
  const ctx = groupCtx(`/settoken ${PAIR}`, -3002);
  await groupSetup.settoken(ctx);
  const g = cfg.get(-3002);
  assert.ok(g, `nothing configured — said: ${said(ctx)}`);
  assert.equal(g.address, TOKEN);
  assert.equal(g.pairAddress, PAIR);
});

test("a DexScreener link pasted by an admin in the group is ANSWERED (asked, not armed)", async () => {
  const ctx = groupCtx(LINK, -3003);
  let nexted = 0;
  await groupSetup.groupTokenReply(ctx, async () => { nexted++; });
  assert.equal(nexted, 0, "the link is handled, not passed along as chatter");
  assert.equal(cfg.get(-3003), null, "nothing is configured until the admin taps");
});

test("a link /settoken cannot verify says so instead of 'no live pool'", async () => {
  dsDown = true;
  const ctx = groupCtx(`/settoken ${LINK}`, -3004);
  await groupSetup.settoken(ctx);
  assert.equal(cfg.get(-3004), null);
  assert.match(said(ctx), /Couldn't read that link/);
});

// ── Mass DM ──────────────────────────────────────────────────────────────────

test("⚠️ Mass DM takes the link and the order is about the TOKEN", async () => {
  const sent = [];
  const ctx = {
    chat: { id: 7, type: "private" },
    from: { id: 7 },
    message: { text: LINK, message_id: 1 },
    session: { type: "massdm", awaitingField: "massdm_ca" },
    reply: async (t) => (sent.push(String(t)), { message_id: sent.length + 100 }),
    telegram: { deleteMessage: async () => {} },
  };
  await massdm.handleText(ctx);
  assert.ok(ctx.session.massForm, `no order — said: ${sent.join(" | ")}`);
  assert.equal(ctx.session.massForm.ca, TOKEN);
  assert.equal(ctx.session.massForm.chain, "bsc");
});

// ── Trending ─────────────────────────────────────────────────────────────────

test("⚠️ Trending finds the listing from its DexScreener link", async () => {
  api.getListings = async () => [{ chain: "bsc", address: TOKEN, status: "approved", sym: "$REAL", name: "Real Project" }];
  const replies = [];
  const ctx = {
    chat: { id: 7, type: "private" },
    from: { id: 7 },
    message: { text: LINK },
    session: { type: "trend", awaitingField: "trend_ca" },
    reply: async (t) => (replies.push(String(t)), { message_id: replies.length }),
    replyWithPhoto: async () => ({ message_id: 1 }),
    telegram: { deleteMessage: async () => {} },
    answerCbQuery: async () => {},
  };
  await trending.handleText(ctx);
  assert.ok(ctx.session.coin, `not found — said: ${replies.join(" | ")}`);
  assert.equal(ctx.session.coin.address, TOKEN);
});

test("a token that IS the listing costs Trending no DexScreener request", async () => {
  api.getListings = async () => [{ chain: "bsc", address: TOKEN, status: "approved", sym: "$REAL" }];
  const ctx = {
    chat: { id: 7, type: "private" }, from: { id: 7 }, message: { text: TOKEN },
    session: { type: "trend", awaitingField: "trend_ca" },
    reply: async () => ({ message_id: 1 }), replyWithPhoto: async () => ({ message_id: 1 }),
    telegram: { deleteMessage: async () => {} }, answerCbQuery: async () => {},
  };
  await trending.handleText(ctx);
  assert.equal(ctx.session.coin.address, TOKEN);
  assert.equal(calls.filter((u) => u.includes("dexscreener")).length, 0);
});

// ── the gainers slot swap, and a bare paste in the DM ───────────────────────

test("⚠️ the admin's gainers slot swap reads a DexScreener link as the TOKEN it trades", async () => {
  const gainers = require("../src/gainers");
  const market = require("../src/marketdata");
  const realInfo = dexscreener.fetchTokenInfo;
  const realMarket = market.fetchMarket;
  const asked = [];
  dexscreener.fetchTokenInfo = async (chain, addr) => {
    asked.push(addr);
    return addr === TOKEN ? { name: "Real Project", symbol: "REAL", change24h: 12, priceUsd: 0.01, liq: 50000 } : null;
  };
  market.fetchMarket = async () => null;
  try {
    const best = await gainers.resolveToken(LINK);
    assert.equal(best.address, TOKEN);
    assert.equal(best.chain, "bsc");
    assert.ok(!asked.includes(PAIR), "the pool was never priced as if it were the token");
  } finally {
    dexscreener.fetchTokenInfo = realInfo;
    market.fetchMarket = realMarket;
  }
});

test("a DexScreener link pasted into the DM with no flow running finds the listing by its TOKEN", async () => {
  const text = require("../src/handlers/text");
  const realExisting = listedGuard.existingListing;
  const realSend = listedGuard.sendAlreadyListed;
  const looked = [];
  let answered = null;
  listedGuard.existingListing = async (addr, chain) => (looked.push([addr, chain]), addr === TOKEN ? { chain: "bsc", address: TOKEN } : null);
  listedGuard.sendAlreadyListed = async (_ctx, row) => { answered = row; };
  try {
    const ctx = { chat: { id: 7, type: "private" }, from: { id: 7 }, session: {}, message: { text: LINK }, reply: async () => ({}) };
    await text.textRouter(ctx);
    assert.deepEqual(looked, [[TOKEN, "bsc"]]);
    assert.equal(answered && answered.address, TOKEN);
  } finally {
    listedGuard.existingListing = realExisting;
    listedGuard.sendAlreadyListed = realSend;
  }
});
