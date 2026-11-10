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
    // the contract could not be read → HELD, never listed blind (nobody confirms this door)
    contractUnreadable("could not read the contract (rpc timeout after 4000ms)");
    assert.equal(await al.createFromInfo("bsc", "0x" + "43".repeat(20), healthy()), null);
    assert.equal(created.length, 1);
    // …and listed the moment the contract answers
    contractSays("LITTY", "Little Titty");
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

// "liat ini" — the first live identity:check found $LTC, $THE-ALGORITHM and
// $MEMESTOCK. Each kept a pump baseline taken from the STRANGER's price while
// the fixed readers now price the real token, so the ladder could fire
// "+100% since listing" under a name that is not the token's. Every alert asks
// stillListed.confirmListed before it goes out; the identity check rides there.
test("a pump or rank-up alert is HELD for a listing published under another token's name", async () => {
  const { confirmListed } = require("../src/helpers/stillListed");
  const log = require("../src/helpers/logger");
  const row = { chain: "solana", address: BTC, sym: "$LTC", status: "approved", listedAt: 1 };
  const rows = async () => [row];
  const warns = [];
  const realWarn = log.warn;
  log.warn = (...a) => warns.push(a.join(" "));
  try {
    contractSays("BTC", "Big Titty Coin");
    const held = await confirmListed(row, { listedAt: 1 }, rows);
    assert.equal(held.ok, false, "the alert would print $LTC over Big Titty Coin's price");
    assert.match(held.why, /another token's name/);
    assert.match(held.why, /\$LTC/);
    assert.match(held.why, /\$BTC/);
    assert.ok(warns.some((w) => /identity:check/.test(w)), "ops is told, with the command that finds every such row");

    contractSays("LTC", "Little Titty Coin");
    assert.equal((await confirmListed(row, { listedAt: 1 }, rows)).ok, true, "an agreeing contract changes nothing");

    contractUnreadable();
    assert.equal((await confirmListed(row, { listedAt: 1 }, rows)).ok, true, "'could not ask' never holds an alert");

    contractSays("BTC", "Big Titty Coin");
    process.env.LISTING_IDENTITY = "0";
    assert.equal((await confirmListed(row, { listedAt: 1 }, rows)).ok, true, "the switch still switches it off");
  } finally {
    log.warn = realWarn;
  }
});

test("identity:check says whether a wrong row's tier was BOUGHT or given by the auto-lister", () => {
  const { provenance } = require("../scripts/identity-check");
  const bsc = "0x46cEeFDa28Dd7207059ed19B0acdc026955bb15C";
  const given = { [`bsc:${bsc.toLowerCase()}`]: "DIAMOND" };
  assert.equal(provenance({ chain: "bsc", address: bsc, tier: "FREE" }, given), "a free listing");
  assert.match(provenance({ chain: "bsc", address: bsc, tier: "DIAMOND" }, given), /given by the auto-lister, not bought/);
  // A different tier from the one the bot gave means a purchase changed it.
  assert.match(provenance({ chain: "bsc", address: bsc, tier: "GOLD" }, given), /not given by the auto-lister.*same package/);
  assert.match(provenance({ chain: "solana", address: BTC, tier: "XPRESS" }, {}), /not given by the auto-lister/);
});

test("identity:check holds the readers' INFO detail for the run and gives it back", () => {
  const src = require("node:fs")
    .readFileSync(require.resolve("../scripts/identity-check"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  const iMute = src.indexOf("log.info = () => {}");
  const iLoop = src.indexOf("for (let i = 0; i < rows.length; i++)");
  const iFinally = src.indexOf("} finally {", iLoop);
  const iRestore = src.indexOf("log.info = info", iFinally);
  assert.ok(iMute > 0 && iMute < iLoop, "muted before the first row");
  assert.ok(iFinally > iLoop && iRestore > iFinally, "restored in a finally, whatever the loop does");
  assert.match(src, /% 100 === 0/, "a long run says how far it has got");
  // The second --all run left $LEMON flagged with only its TICKER in the
  // summary; whether it is one token is read off the two names.
  const summary = src.slice(src.indexOf("for (const { row, v } of wrong)"));
  assert.match(summary.slice(0, 400), /\$\{v\.clash\.published\}\$\{row\.name \?/, "the summary names the listing beside its ticker");
});

// "liat ini" (the first --all run): eight rows flagged, and two of them were ONE
// token with two ticker spellings — $LEMON over a contract saying LEMON.FUN
// ("Lemon"), $BANANAS31 over BANANA ("Banana For Scale"). A false flag holds
// that row's pump alerts and tells the operator to delete a real listing. A
// stranger's pool carries the stranger's NAME with its ticker, so the name is
// what tells the two apart.
test("one token, two ticker spellings: the same NAME and a ticker that extends the other agree", () => {
  assert.equal(ident.conflict("$LEMON", "LEMON.FUN", { published: "Lemon", contract: "Lemon" }), null);
  assert.equal(ident.conflict("BANANAS31", "BANANA", { published: "Banana For Scale", contract: "banana-for-scale" }), null);
  // the real mismatches from the same run: the stranger's name came with its ticker
  assert.deepEqual(ident.conflict("LTC", "BTC", { published: "Little Titty Coin", contract: "Big Titty Coin" }), { published: "LTC", contract: "BTC" });
  assert.ok(ident.conflict("STONKBROKER", "DERP", { published: "Stonk Broker", contract: "DERP" }));
  // the name alone is not enough: the right name over an unrelated ticker is still wrong
  assert.ok(ident.conflict("LTC", "BTC", { published: "Big Titty Coin", contract: "Big Titty Coin" }));
  // nor a related ticker alone
  assert.ok(ident.conflict("LEMON", "LEMON.FUN"), "no names → the old rule");
  assert.ok(ident.conflict("LEMON", "LEMON.FUN", { published: "Lemonade", contract: "Lemon" }));
  // too short to mean anything
  assert.ok(ident.conflict("AB", "ABC", { published: "Abc Token", contract: "Abc Token" }));
  assert.ok(ident.conflict("ABCD", "ABCDE", { published: "Xy", contract: "Xy" }));
});

test("the free door passes the names: one token's two spellings list, a stranger's name is refused", async () => {
  contractSays("BANANA", "Banana For Scale");
  const addr = "0x3d4f0513e8a29669b960f9dbca61861548a9a760";
  const same = await ident.checkX("bsc", addr, { symbol: "BANANAS31", name: "Banana For Scale" });
  assert.equal(same.refusal, null);
  const other = await ident.checkX("bsc", addr, { symbol: "BANANAS31", name: "Banana Gun" });
  assert.match(String(other.refusal), /identity mismatch/);
});

test("the alert hold passes the listing's name: $LEMON over LEMON.FUN ('Lemon') is announced", async () => {
  const { confirmListed } = require("../src/helpers/stillListed");
  const addr = "0xf0E17e54239CD945Cd7bEa471a3a2CA6a8C7f7A3";
  const row = { chain: "robinhood", address: addr, sym: "$LEMON", name: "Lemon", status: "approved", listedAt: 1 };
  contractSays("LEMON.FUN", "Lemon");
  assert.equal((await confirmListed(row, { listedAt: 1 }, async () => [row])).ok, true, "one token is not held");
  const wrong = { ...row, name: "Lemonade Stand" };
  const held = await confirmListed(wrong, { listedAt: 1 }, async () => [wrong]);
  assert.equal(held.ok, false, "a different name is still another token");
});

test("identity:check passes the listing's name", async () => {
  const { judge } = require("../scripts/identity-check");
  contractSays("BANANA", "Banana For Scale");
  const row = { chain: "bsc", address: "0x3d4f0513e8a29669b960f9dbca61861548a9a760", sym: "$BANANAS31", name: "Banana For Scale" };
  assert.equal((await judge(row)).state, "match");
  assert.equal((await judge({ ...row, name: "Banana Gun" })).state, "mismatch");
});

test("the FORM passes the market record's name: one token's two spellings keep their logo and links", async () => {
  const LEMON_RECORD = { ...LTC_RECORD, name: "Lemon", symbol: "LEMON", logoUrl: "https://cdn.example/lemon.png" };
  contractSays("LEMON.FUN", "Lemon");
  listing._lookups.fetchTokenInfo = async () => LEMON_RECORD;
  listing._lookups.fetchMarket = async () => null;
  listing._lookups.fetchTokenDescription = async () => null;
  const ctx = ctxWith({ type: "xpress_listing", form: { ...listing._test.emptyForm(), chain: "solana" }, awaitingField: "address" }, BTC);
  await listing.handleText(ctx);
  const f = ctx.session.form;
  assert.equal(f.identityConflict, undefined);
  assert.equal(f.logoUrl, "https://cdn.example/lemon.png");
  assert.doesNotMatch(ctx.replies.map((r) => r.text).join("\n"), /Check this is your token/);
});

// "BAGAIMANA AGAR BOT TIDAK SALAH SCAN" — every one of the eight wrong rows
// was written with nothing between it and the site; the free door listed a
// token whose contract it could not read. It holds it now and asks again.
test("a SCAN holds a token whose contract cannot be read — counted, never cooled, listed when it answers", async () => {
  await withSite(async (created) => {
    await al.resetState(now - 10 * 3_600_000);
    await al.set({ enabled: true, minMcap: 1 * M, maxMcap: 1.2 * M, paceListings: false, postChannel: false, minAgeHours: 0 });
    const addr = "0x" + "45".repeat(20);
    const deps = {
      fetchDiscoveryX: async () => ({ items: [{ chain: "bsc", address: addr }], ok: true, sources: [] }),
      fetchTokenInfo: async () => healthy(),
      safetyX: async () => ({ ok: true, refusal: null }),
      identityX: async (c, a, info) => ident.checkX(c, a, info),
      logoX: async () => ({ ok: true, url: "/api/media/aa.png" }),
    };
    contractUnreadable("could not read the contract (rpc timeout after 4000ms)");
    assert.equal(await al.runOnce({ now, deps }), 0);
    assert.equal(created.length, 0, "never listed blind");
    const s = al.lastScan();
    assert.equal(s.unchecked, 1);
    assert.ok(Object.keys(s.uncheckedWhy).some((k) => /own contract could not be read/.test(k)), JSON.stringify(s.uncheckedWhy));
    assert.match(s.blocker || "", /could not be safety-checked/, "a scan that held everything says so");
    const dry = await al.dryRun({ now, deps });
    assert.equal(dry.listed, 0, "🔎 Test scan may not promise it either");
    assert.equal(dry.unchecked, 1);
    // not cooled: the next scan asks again, and lists it once the contract answers
    contractSays("LITTY", "Little Titty");
    await al.runOnce({ now: now + 60_000, deps });
    assert.equal(created.length, 1, "listed as soon as its own contract agreed");
  });
});
