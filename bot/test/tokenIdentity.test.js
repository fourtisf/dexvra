// "bagaimana agar masalah ini tidak terjadi lgi" — after $BTC went out as $LTC.
//
// The readers are fixed (dsTokenSide / gtTokenSide). These pin the SECOND line:
// the token's own contract decides whose token it is, at every door a listing
// is made through — the listing form (where a human confirms), the free-listing
// scan and its door (where nobody does), the paid post's final look, and
// `identity:check` for rows already written. See services/tokenIdentity.js.
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dexvra-ident-"));
process.env.BOT_DATA_DIR = dir;
process.env.DATA_DIR = dir;
process.env.LISTING_AUTOFILL_MS = "300";

const test = require("node:test");
const assert = require("node:assert/strict");

const ident = require("../src/services/tokenIdentity");
const al = require("../src/services/autoLister");
const api = require("../src/api/dexvra");
const listing = require("../src/handlers/listing");
const listedGuard = require("../src/helpers/listedGuard");
const fulfil = require("../src/fulfillment");

const BTC = "C5xph2yL6gMdxmuLGxJBkGpmuDFfyi5fqkBNhvL6pump";
const realDeps = { ...ident._deps };
const realLookups = { ...listing._lookups };
const realBlock = listedGuard.blockIfListed;
const realEnv = process.env.LISTING_IDENTITY;

/** The token's own contract says $BTC. */
function contractSays(symbol, name) {
  ident._deps.solanaCovers = () => true;
  ident._deps.solana = async () => ({ ok: true, why: null, info: symbol ? { symbol, name } : null });
  ident._deps.evmCovers = (c) => c !== "solana" && c !== "tron";
  ident._deps.evm = async () => ({ ok: true, symbol, name, why: null });
}
function contractUnreadable(why = "could not read the token's accounts from the Solana RPC (HTTP 429)") {
  ident._deps.solanaCovers = () => true;
  ident._deps.solana = async () => ({ ok: false, why, info: null });
  ident._deps.evmCovers = () => true;
  ident._deps.evm = async () => ({ ok: false, symbol: null, name: null, why });
}

test.beforeEach(() => {
  process.env.LISTING_IDENTITY = "1";
  Object.assign(ident._deps, realDeps);
  Object.assign(listing._lookups, realLookups);
  listedGuard.blockIfListed = async () => false;
});
test.after(() => {
  Object.assign(ident._deps, realDeps);
  Object.assign(listing._lookups, realLookups);
  listedGuard.blockIfListed = realBlock;
  if (realEnv == null) delete process.env.LISTING_IDENTITY;
  else process.env.LISTING_IDENTITY = realEnv;
});

test("tickers are compared the way we publish them — case, '$' and emoji never decide", () => {
  assert.equal(ident.conflict("$btc", "BTC"), null);
  assert.equal(ident.conflict("PEPE", "PEPE🐸"), null);
  assert.equal(ident.conflict("LTC", null), null, "a contract with no symbol makes no claim");
  assert.equal(ident.conflict(null, "BTC"), null);
  assert.deepEqual(ident.conflict("LTC", "BTC"), { published: "LTC", contract: "BTC" });
});

test("blank LISTING_IDENTITY is ON; only an explicit off switches it off", () => {
  process.env.LISTING_IDENTITY = "";
  assert.equal(ident.enabled(), true);
  delete process.env.LISTING_IDENTITY;
  assert.equal(ident.enabled(), true);
  for (const off of ["0", "false", "off", "no"]) {
    process.env.LISTING_IDENTITY = off;
    assert.equal(ident.enabled(), false, off);
  }
});

test("readX: the mint's own ticker; a document failure still leaves it; 'could not ask' is never a verdict", async () => {
  contractSays("BTC", "Big Titty Coin");
  assert.deepEqual(await ident.readX("solana", BTC), { ok: true, symbol: "BTC", name: "Big Titty Coin", why: null });
  // the metadata DOCUMENT failed — the on-chain half (name + ticker) still answers
  ident._deps.solana = async () => ({ ok: false, why: "metadata document could not be read", info: { symbol: "BTC", name: "Big Titty Coin" } });
  assert.equal((await ident.readX("solana", BTC)).symbol, "BTC");
  contractUnreadable();
  const r = await ident.readX("solana", BTC);
  assert.equal(r.ok, false);
  assert.match(r.why, /429/);
  const c = await ident.checkX("solana", BTC, { symbol: "LTC" });
  assert.equal(c.ok, false);
  assert.equal(c.refusal, null, "an RPC that did not answer is never a refusal");
  // a chain with no reader is an answer with nothing to compare
  ident._deps.evmCovers = realDeps.evmCovers;
  assert.deepEqual(await ident.readX("tron", "TXyz"), { ok: true, symbol: null, name: null, why: "no on-chain identity reader for tron" });
});

// ── the free-listing door ────────────────────────────────────────────────────
const now = Date.UTC(2026, 10, 5, 8);
const M = 1_000_000;
// Not "LTC"/"BTC" here: those are majors, and the impersonation gate (rightly)
// refuses them before this check is ever reached.
const healthy = (over = {}) => ({
  name: "Little Titty", symbol: "LITTY", mcap: 1.5 * M, liq: 150_000, vol24: 300_000, priceUsd: 0.0015,
  logoUrl: "https://dd.dexscreener.com/x.png", pairCreatedAt: now - 72 * 3_600_000, ...over,
});
async function withSite(fn) {
  const real = { c: api.createListing, g: api.getListings, w: api.canCreate };
  const created = [];
  api.createListing = async (input) => (created.push(input), { id: "x" + created.length, ...input });
  api.getListings = async () => [];
  api.canCreate = async () => ({ ok: true, status: 400, why: null });
  try {
    return await fn(created);
  } finally {
    api.createListing = real.c;
    api.getListings = real.g;
    api.canCreate = real.w;
  }
}

test("createFromInfo — every free door — refuses a token whose market data names another token", async () => {
  await withSite(async (created) => {
    contractSays("BIGTITTY", "Big Titty");
    assert.equal(await al.createFromInfo("bsc", "0x" + "41".repeat(20), healthy()), null);
    assert.equal(created.length, 0, "never listed under another token's name");
    // the contract agrees → listed
    contractSays("LITTY", "Little Titty");
    assert.ok(await al.createFromInfo("bsc", "0x" + "42".repeat(20), healthy()));
    // the contract could not be read → listed, as before this check existed
    contractUnreadable("could not read the contract (rpc timeout after 4000ms)");
    assert.ok(await al.createFromInfo("bsc", "0x" + "43".repeat(20), healthy()));
    assert.equal(created.length, 2);
  });
});

test("a SCAN refuses it under its own reason, cools it, and the Test scan says the same", async () => {
  await withSite(async (created) => {
    await al.resetState(now - 10 * 3_600_000);
    await al.set({ enabled: true, minMcap: 1 * M, maxMcap: 1.2 * M, paceListings: false, postChannel: false, minAgeHours: 0 });
    const addr = "0x" + "44".repeat(20);
    const asked = [];
    const deps = {
      fetchDiscoveryX: async () => ({ items: [{ chain: "bsc", address: addr }], ok: true, sources: [] }),
      fetchTokenInfo: async () => healthy(),
      safetyX: async () => ({ ok: true, refusal: null }),
      identityX: async (c, a, info) => (asked.push(a), ident.checkX(c, a, info)),
    };
    contractSays("BIGTITTY", "Big Titty");
    assert.equal(await al.runOnce({ now, deps }), 0);
    assert.equal(created.length, 0);
    const s = al.lastScan();
    assert.equal(s.reasons["identity mismatch"], 1, JSON.stringify(s.reasons));
    assert.equal(s.blocker, null, "a refused mismatch is the gate working, not a blocked scan");
    const dry = await al.dryRun({ now, deps });
    assert.equal(dry.listed, 0, "🔎 Test scan may not promise a listing the scan refuses");
    assert.equal(dry.reasons["identity mismatch"], 1);
    // cooled — not asked again inside the cool-off
    const n = asked.length;
    await al.runOnce({ now: now + 3_600_000, deps });
    assert.equal(asked.length, n);
  });
});

// ── the listing form ─────────────────────────────────────────────────────────
function ctxWith(session, msgText) {
  const replies = [];
  return {
    replies,
    chat: { id: 7, type: "private" },
    from: { id: 7 },
    session,
    message: { text: msgText },
    reply: async (t, extra) => (replies.push({ text: String(t), extra }), { message_id: replies.length }),
    replyWithPhoto: async (photo, extra) => (replies.push({ photo, text: String((extra && extra.caption) || "") }), { message_id: replies.length }),
    telegram: { deleteMessage: async () => {} },
    answerCbQuery: async () => {},
  };
}
const LTC_RECORD = {
  name: "Little Titty Coin", symbol: "LTC", logoUrl: "https://cdn.example/ltc.png",
  twitter: "https://x.com/ltc", website: "https://ltc.example", priceUsd: 0.003212, mcap: 3_100_000, liq: 1_100_000,
};

test("the FORM: the contract's name wins, the stranger's logo/links/figures are dropped, and the card says so", async () => {
  contractSays("BTC", "Big Titty Coin");
  listing._lookups.fetchTokenInfo = async () => LTC_RECORD;
  listing._lookups.fetchMarket = async () => ({ ...LTC_RECORD });
  listing._lookups.fetchTokenDescription = async () => "Little Titty Coin is the little one.";
  const ctx = ctxWith({ type: "xpress_listing", form: { ...listing._test.emptyForm(), chain: "solana" }, awaitingField: "address" }, BTC);
  await listing.handleText(ctx);
  const f = ctx.session.form;
  assert.equal(f.sym, "BTC");
  assert.equal(f.name, "Big Titty Coin");
  assert.equal(f.logoUrl || null, null, "LTC's artwork must never become BTC's");
  assert.equal(f.twitter || null, null);
  assert.equal(f.website || null, null);
  assert.doesNotMatch(String(f.overview || ""), /little one/);
  assert.ok(!(f.market && f.market.mcap), "LTC's cap is not BTC's");
  assert.deepEqual(f.identityConflict, { indexer: "LTC", contract: "BTC" });
  const card = ctx.replies.map((r) => r.text).join("\n");
  assert.match(card, /Check this is your token/);
  assert.match(card, /\$LTC/);
  assert.match(card, /\$BTC/);
  // …and the order carries the finding, so fulfilment's final look cannot
  // refill the stranger's logo and links after payment.
  const pay = require("../src/handlers/pay");
  const realStart = pay.startPayment;
  let order = null;
  pay.startPayment = async (_ctx, o) => { order = o; };
  try {
    await listing.goPay(ctx, "XPRESS");
  } finally {
    pay.startPayment = realStart;
  }
  assert.deepEqual(order && order.payload.identityConflict, { indexer: "LTC", contract: "BTC" });
  assert.equal(order.payload.listingInput.sym, "BTC");
});

test("the FORM's second look never refills the logo and links from market data that named another token", async () => {
  const savedLate = { ...listing._late };
  const savedMeta = process.env.SOLANA_META;
  process.env.SOLANA_META = "1"; // the second look is a Solana feature
  listing._late.delays = () => [0];
  listing._late.wait = async () => {};
  listing._late.peek = (ctx) => ctx.session;
  try {
    contractSays("BTC", "Big Titty Coin");
    listing._lookups.fetchTokenInfo = async () => LTC_RECORD;
    listing._lookups.fetchMarket = async () => null;
    listing._lookups.fetchTokenDescription = async () => null;
    const ctx = ctxWith({ type: "xpress_listing", form: { ...listing._test.emptyForm(), chain: "solana" }, awaitingField: "address" }, BTC);
    await listing.handleText(ctx);
    const late = await listing._late.started;
    assert.equal(late && late.why, "the market data named another token");
    assert.equal(ctx.session.form.logoUrl || null, null, "the second look put LTC's logo back");
  } finally {
    Object.assign(listing._late, savedLate);
    if (savedMeta == null) delete process.env.SOLANA_META;
    else process.env.SOLANA_META = savedMeta;
  }
});

test("the FORM: an agreeing or unreadable contract changes nothing, and no warning is shown", async () => {
  for (const setup of [() => contractSays("LTC", "Little Titty Coin"), () => contractUnreadable()]) {
    setup();
    listing._lookups.fetchTokenInfo = async () => LTC_RECORD;
    listing._lookups.fetchMarket = async () => null;
    listing._lookups.fetchTokenDescription = async () => null;
    const ctx = ctxWith({ type: "xpress_listing", form: { ...listing._test.emptyForm(), chain: "solana" }, awaitingField: "address" }, BTC);
    await listing.handleText(ctx);
    const f = ctx.session.form;
    assert.equal(f.sym, "LTC");
    assert.equal(f.logoUrl, "https://cdn.example/ltc.png");
    assert.equal(f.identityConflict, undefined);
    assert.doesNotMatch(ctx.replies.map((r) => r.text).join("\n"), /Check this is your token/);
  }
});

test("the paid post's final look never refills from market data that named another token", async () => {
  const saved = { ...fulfil._finalLook };
  let asked = 0;
  fulfil._finalLook.meta = () => ({ covers: () => true, settled: () => true, lastWhy: () => null });
  fulfil._finalLook.fetchTokenInfo = async () => (asked++, LTC_RECORD);
  try {
    const input = { chain: "solana", address: BTC, sym: "BTC", name: "Big Titty Coin" };
    assert.equal(await fulfil._finalLookRun(input, { identityConflict: { indexer: "LTC", contract: "BTC" } }), null);
    assert.equal(asked, 0);
    // without the conflict it still looks (the rule did not switch the look off)
    assert.ok(await fulfil._finalLookRun(input, {}));
    assert.equal(asked, 1);
  } finally {
    Object.assign(fulfil._finalLook, saved);
  }
});

test("identity:check judges a row by its own contract — and 'could not ask' is never a match", async () => {
  const { judge } = require("../scripts/identity-check");
  contractSays("BTC", "Big Titty Coin");
  const wrong = await judge({ chain: "solana", address: BTC, sym: "$LTC" });
  assert.equal(wrong.state, "mismatch");
  assert.deepEqual(wrong.clash, { published: "LTC", contract: "BTC" });
  assert.equal((await judge({ chain: "solana", address: BTC, sym: "BTC" })).state, "match");
  contractSays(null, null);
  assert.equal((await judge({ chain: "solana", address: BTC, sym: "LTC" })).state, "none");
  contractUnreadable();
  assert.equal((await judge({ chain: "solana", address: BTC, sym: "LTC" })).state, "unread");
});
