// "bagaimana agar masalah ini tidak terjadi lgi" — asked over a launchpads:check
// run on the box that prefilled $KVR's logo, website and X from the mint's own
// metadata, minutes after its review card had come back "not set" on all three.
//
// The miss was a minute, not a token. The review card's second look only helps
// a buyer who is still reading it, and nothing said the card was blank because
// the chain could not be asked — the operator was the detector. So:
//   1. fulfilment asks ONE more time, immediately before the row is created,
//      filling holes by the SAME rule the form uses (listingHoles.js) and never
//      putting back what the buyer removed;
//   2. a blank we could not read pages the ops channel — at the review card and
//      at the paid order — and a blank the creator chose pages nobody.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-finallook-"));
process.env.LISTING_AUTOFILL_MS = "400";
process.env.POST_LOGO_TRIES = "1";
process.env.POST_LOGO_PAUSE_MS = "0";
process.env.POST_MARKET_TRIES = "1";
process.env.LOGO_REPAIR = "0";
// The runner switches the chain read off; this file is about where it is on.
process.env.SOLANA_META = "";

const test = require("node:test");
const assert = require("node:assert");

const holes = require("../src/listingHoles");
const fulfil = require("../src/fulfillment");
const listing = require("../src/handlers/listing");
const postFigures = require("../src/postFigures");
const log = require("../src/helpers/logger");

const MINT = "DzBCYzmGHEVdh5HK8tFBgS72iNaCEqkSHDeCCTLSpump"; // $KVR, the reported token
const FULL = {
  name: "KOVRA",
  symbol: "KVR",
  logoUrl: "https://ipfs.io/ipfs/bafkreic2br7xltdy2psp5cajtvskmwhctmizkp5ndo3ccmwud6hf4lhjly",
  website: "https://kovra.live/",
  twitter: "https://x.com/kovrasol",
  telegram: null,
  description: "Kovra is a cat in a costume, minted on pump.fun for Halloween season.",
};
const BLANK = { name: "KOVRA", symbol: "KVR", logoUrl: null, website: null, twitter: null, telegram: null };

// ── the shared rule ─────────────────────────────────────────────────────────

const form = (over = {}) => ({ chain: "solana", address: MINT, name: "KOVRA", sym: "KVR", ...over });

test("holes only: a late read never replaces a field already filled", () => {
  const add = holes.additions(form({ twitter: "https://x.com/first", logoUrl: "https://cdn.example/a.png" }), FULL);
  assert.ok(!("twitter" in add) && !("logoUrl" in add), JSON.stringify(add));
  assert.strictEqual(add.website, FULL.website, "the vacuity check — a real hole is still filled");
});

test("⚠️ a field the buyer REMOVED stays removed — logo and overview", () => {
  const add = holes.additions(form(), FULL, { removed: { logo: true, overview: true }, autoOverview: true });
  assert.ok(!("logoUrl" in add), "a /skip'd logo came back");
  assert.ok(!("overview" in add), "a /skip'd overview came back");
  assert.strictEqual(add.twitter, FULL.twitter, "only the removed fields are spared");
  const free = holes.additions(form(), FULL, { autoOverview: true });
  assert.strictEqual(free.logoUrl, FULL.logoUrl, "without a removal the logo IS filled");
});

test("the auto-written intro gives way to the project's own words; a typed overview does not", () => {
  const intro = holes.autoIntro(form());
  assert.match(holes.additions(form({ overview: intro }), FULL, { autoOverview: true }).overview, /cat in a costume/);
  assert.ok(!("overview" in holes.additions(form({ overview: "Our own words." }), FULL, { autoOverview: false })));
});

test("an ipfs:// logo is never written — the site refuses the WHOLE listing over its picture", () => {
  assert.ok(!("logoUrl" in holes.additions(form(), { ...FULL, logoUrl: "ipfs://bafkreikovra" })));
});

test("hasHoles: an uploaded logo and a full set of links is nothing to look for", () => {
  assert.strictEqual(holes.hasHoles(form({ logoFileId: "f1", website: "w", twitter: "x", telegram: "t", overview: "own" })), false);
  assert.strictEqual(holes.hasHoles(form({ logoFileId: "f1", website: "w", twitter: "x", telegram: "t" })), true, "no overview at all is a hole");
  assert.strictEqual(holes.hasHoles(form({ website: "w", twitter: "x", telegram: "t", overview: "own" }), { removed: { logo: true } }), false, "a removed logo is not a hole");
});

// ── the form records the removal and hands it to the order ──────────────────

test("⚠️ /skip on the logo is RECORDED and reaches the order", async () => {
  const pay = require("../src/handlers/pay");
  const realPay = pay.startPayment;
  let order = null;
  pay.startPayment = async (ctx, o) => (order = o);
  const session = { type: "xpress_listing", form: { ...listing._test.emptyForm(), ...form({ logoUrl: FULL.logoUrl }) }, awaitingField: "logo" };
  const ctx = {
    chat: { id: 7, type: "private" }, from: { id: 7 }, session, message: { text: "/skip" },
    reply: async () => ({ message_id: 1 }), replyWithPhoto: async () => ({ message_id: 1 }),
    telegram: { deleteMessage: async () => {} }, answerCbQuery: async () => {},
  };
  try {
    await listing.handleText(ctx);
    assert.strictEqual(session.form.logoUrl, null);
    assert.deepStrictEqual(session.form.removed, { logo: true });
    await listing.goPay(ctx, "XPRESS");
    assert.ok(order, "the payment was armed");
    assert.deepStrictEqual(order.payload.autofill.removed, { logo: true }, "fulfilment must know the buyer removed it");
    assert.strictEqual(order.payload.autofill.autoOverview, true, "the overview is the auto-written intro, and the order says so");
  } finally {
    pay.startPayment = realPay;
  }
});

// ── the review card's second look: an unread blank pages ────────────────────

test("⚠️ a second look that ends with the chain UNREAD is a WARN — the ops channel, not only pm2", async () => {
  const solanaMeta = require("../src/solanaMeta");
  const real = { settled: solanaMeta.settled, lastWhy: solanaMeta.lastWhy };
  const realLate = { ...listing._late };
  const realLookups = { ...listing._lookups };
  const warns = [];
  const infos = [];
  const rw = log.warn;
  const ri = log.info;
  log.warn = (...a) => warns.push(a.join(" "));
  log.info = (...a) => infos.push(a.join(" "));
  const f = { ...listing._test.emptyForm(), ...form() };
  const session = { form: f, reviewShown: true, latest_bot_message: 5 };
  const ctx = { session };
  listing._late.peek = () => session;
  listing._late.delays = () => [0];
  listing._late.wait = async () => {};
  listing._lookups.fetchTokenInfo = async () => BLANK;
  try {
    solanaMeta.settled = () => false;
    solanaMeta.lastWhy = () => "the Solana RPC is rate-limiting this server (429)";
    const r = await listing._lateFill(ctx, f, { message_id: 5 });
    assert.strictEqual(r.why, "unread");
    const line = warns.find((w) => w.includes(MINT));
    assert.ok(line, `no WARN: ${warns.join(" | ")}`);
    assert.match(line, /logo, website, X, Telegram/);
    assert.match(line, /429/);
    assert.match(line, new RegExp(`launchpads:check -- ${MINT}`), "the remedy carries the REAL mint");
    assert.doesNotMatch(line, /[<>]/, "never a bracketed blank");

    // A SETTLED answer with nothing in it is the creator's choice — INFO only.
    warns.length = 0;
    solanaMeta.settled = () => true;
    const r2 = await listing._lateFill(ctx, f, { message_id: 5 });
    assert.strictEqual(r2.why, "nothing new");
    assert.strictEqual(warns.filter((w) => w.includes(MINT)).length, 0, "a creator who wrote no links paged the ops channel");
    assert.ok(infos.some((i) => i.includes("found nothing new")));
  } finally {
    Object.assign(solanaMeta, real);
    Object.assign(listing._late, realLate);
    Object.assign(listing._lookups, realLookups);
    log.warn = rw;
    log.info = ri;
  }
});

// ── fulfilment's final look, driven ─────────────────────────────────────────

function harness({ info = FULL, settled = true, why = null, onLook } = {}) {
  const api = require("../src/api/dexvra");
  const post = require("../src/channels/post");
  const bt = require("../src/bannerTemplate");
  const br = require("../src/bannerRender");
  const postids = require("../src/channels/postids");
  const te = require("../src/tokenEmoji");
  const x = require("../src/twitter");
  const market = require("../src/marketdata");
  const saved = {
    create: api.createListing, send: post.sendMedia, mirror: post.mirrorToGroup, postListing: x.postListing,
    compose: bt.compose, render: br.renderListingBanner, ids: postids.set, emoji: te.ensureTokenEmoji,
    fm: market.fetchMarket, look: { ..._finalLookSaved }, alert: log.alert, fetch: global.fetch,
  };
  const out = { row: null, looks: [], alerts: [], marketCalledAt: null, lookCalledAt: null };
  let tick = 0;
  api.createListing = async (input) => ((out.row = { ...input }), { id: "L1" });
  post.sendMedia = async () => ({ message_id: 1 });
  post.mirrorToGroup = async () => null;
  x.postListing = async () => null;
  bt.compose = async () => null;
  br.renderListingBanner = async () => null;
  postids.set = async () => {};
  te.ensureTokenEmoji = async () => null;
  market.fetchMarket = async () => {
    out.marketCalledAt = ++tick;
    await new Promise((r) => setTimeout(r, 30));
    out.marketDoneAt = ++tick;
    return { priceUsd: 0.0000098, mcap: 9800, liq: null, poolAddress: null };
  };
  global.fetch = async () => ({ ok: false, status: 404, headers: { get: () => null }, json: async () => ({}), text: async () => "", arrayBuffer: async () => new ArrayBuffer(0) });
  log.alert = (html) => out.alerts.push(String(html));
  fulfil._finalLook.fetchTokenInfo = async (...a) => {
    out.lookCalledAt = ++tick;
    out.looks.push(a);
    if (onLook) await onLook();
    return info;
  };
  fulfil._finalLook.meta = () => ({ covers: (c) => c === "solana", settled: () => settled, lastWhy: () => why });
  out.restore = () => {
    api.createListing = saved.create;
    post.sendMedia = saved.send;
    post.mirrorToGroup = saved.mirror;
    x.postListing = saved.postListing;
    bt.compose = saved.compose;
    br.renderListingBanner = saved.render;
    postids.set = saved.ids;
    te.ensureTokenEmoji = saved.emoji;
    market.fetchMarket = saved.fm;
    Object.assign(fulfil._finalLook, saved.look);
    log.alert = saved.alert;
    global.fetch = saved.fetch;
  };
  return out;
}
const _finalLookSaved = { ...fulfil._finalLook };

const order = (input = {}, payload = {}) => ({
  payload: {
    listingInput: { chain: "solana", address: MINT, sym: "KVR", name: "KOVRA", tier: "XPRESS", overview: holes.autoIntro(form()), ...input },
    autofill: { removed: {}, autoOverview: true },
    trendHours: 0,
    ...payload,
  },
});
const ctxOf = () => ({ telegram: {}, reply: async () => ({}), from: { id: 7 } });

test("⚠️ THE REPORTED ORDER: a review card born blank still creates a listing with its logo, website, X and description", async () => {
  const h = harness();
  try {
    await fulfil.fulfillListing(ctxOf(), order());
    assert.ok(h.row, "the create was reached");
    assert.strictEqual(h.row.logoUrl, FULL.logoUrl);
    assert.strictEqual(h.row.website, FULL.website);
    assert.strictEqual(h.row.twitter, FULL.twitter);
    assert.match(h.row.overview, /cat in a costume/, "the auto-written intro must give way to the project's own words");
    assert.strictEqual(h.looks.length, 1, "exactly one final look");
    assert.strictEqual(h.alerts.filter((a) => /Links:/.test(a)).length, 0, "a filled listing pages nobody");
  } finally {
    h.restore();
  }
});

test("⚠️ the final look runs BESIDE the market read, never after it", async () => {
  const h = harness();
  try {
    await fulfil.fulfillListing(ctxOf(), order());
    assert.ok(h.lookCalledAt && h.marketDoneAt, "both were asked");
    // The market stub holds for 30ms; a serial look would start after it ends.
    assert.ok(h.lookCalledAt < h.marketDoneAt, `the look waited on the market read (look #${h.lookCalledAt}, market answered #${h.marketDoneAt})`);
  } finally {
    h.restore();
  }
});

test("⚠️ what the buyer REMOVED is never put back, and an UPLOADED logo is never replaced", async () => {
  let h = harness();
  try {
    await fulfil.fulfillListing(ctxOf(), order({}, { autofill: { removed: { logo: true, overview: true }, autoOverview: true } }));
    assert.strictEqual(h.row.logoUrl, undefined, "a /skip'd logo came back on the paid listing");
    assert.doesNotMatch(String(h.row.overview), /cat in a costume/, "a /skip'd overview came back");
    assert.strictEqual(h.row.twitter, FULL.twitter, "the vacuity check — the look itself still ran");
  } finally {
    h.restore();
  }
  h = harness();
  try {
    // The Telegram download fails in this harness, so the row has no url —
    // and still the chain's logo must not stand in for the buyer's upload.
    await fulfil.fulfillListing(ctxOf(), order({}, { logoFileId: "AgADBuyerUpload" }));
    assert.strictEqual(h.row.logoUrl, undefined, "a chain logo replaced the picture the buyer uploaded");
  } finally {
    h.restore();
  }
});

test("⚠️ a listing still blank because the chain could NOT be asked pages — naming the reason and the real check", async () => {
  const h = harness({ info: BLANK, settled: false, why: "the Solana RPC is rate-limiting this server (429)" });
  try {
    await fulfil.fulfillListing(ctxOf(), order());
    const page = h.alerts.find((a) => /Links:/.test(a));
    assert.ok(page, `no page: ${h.alerts.join(" || ")}`);
    assert.match(page, /429/);
    assert.match(page, /TOKEN'S OWN METADATA/, "the Solana read is named, not a curve");
    assert.match(page, new RegExp(`launchpads:check -- ${MINT}`));
    assert.match(page, /the row is blank because the TOKEN'S OWN METADATA read could not answer/, "…and the logo half of the same blank");
  } finally {
    h.restore();
  }
});

test("a blank whose chain ANSWERED is the creator's choice — no page", async () => {
  const h = harness({ info: BLANK, settled: true });
  try {
    await fulfil.fulfillListing(ctxOf(), order());
    assert.ok(h.row, "the create was reached");
    assert.strictEqual(h.alerts.length, 0, `a creator who published nothing paged: ${h.alerts.join(" || ")}`);
  } finally {
    h.restore();
  }
});

test("only where the source is asked at all: another chain pays for no look", async () => {
  const h = harness();
  try {
    await fulfil.fulfillListing(ctxOf(), order({ chain: "ethereum", address: "0x0000000000000000000000000000000000000001" }));
    assert.ok(h.row, "the create was reached");
    assert.strictEqual(h.looks.length, 0, "an EVM order paid for a Solana metadata read");
  } finally {
    h.restore();
  }
});

test("a final look that throws costs the look, never the order", async () => {
  const h = harness({
    onLook: () => {
      throw new Error("boom");
    },
  });
  try {
    await fulfil.fulfillListing(ctxOf(), order());
    assert.ok(h.row, "a broken look failed a paid order");
  } finally {
    h.restore();
  }
});

// ── the watch, pure ─────────────────────────────────────────────────────────

test("socialsUnread: only the reported shape, and only when the chain could not be asked", () => {
  assert.strictEqual(postFigures.socialsUnread({ holes: ["website", "X", "Telegram"], unreadWhy: "rpc 429" }), true);
  assert.strictEqual(postFigures.socialsUnread({ holes: ["Telegram"], unreadWhy: "rpc 429" }), false, "a missing Telegram beside an X is a creator's choice");
  assert.strictEqual(postFigures.socialsUnread({ holes: ["website", "X", "Telegram"], unreadWhy: null }), false, "the chain answered");
  assert.strictEqual(postFigures.artRemedy("unread", "solana", MINT), `npm run launchpads:check -- ${MINT}`);
  assert.strictEqual(postFigures.artRemedy("unread", "robinhood", "0xabc"), "npm run pons:check", "the curve check stays the curve check");
});

// ── the repair asks the mint, not only the market ───────────────────────────

test("⚠️ a blank Solana row's repair asks the token's own metadata — and an unread one is retried, not given up on", async () => {
  const repair = require("../src/services/logoRepair");
  const job = { kind: "listing", chain: "solana", address: MINT, urls: [], posts: [] };
  const base = {
    readMarket: async () => ({ live: { priceUsd: 1, mcap: 2 } }),
    adoptChainLogo: fulfil._adoptChainLogo,
    readArtwork: async () => ({ bytes: null, why: "no gateway had it" }),
  };
  let asked = null;
  const found = await repair._attempt(job, {
    ...base,
    readTokenInfo: async () => ({ info: { logoUrl: FULL.logoUrl }, unread: null }),
    readArtwork: async (urls) => ((asked = urls), { bytes: null, why: "cold" }),
  });
  assert.deepStrictEqual(asked, [FULL.logoUrl], "the mint's logo was never tried");
  assert.strictEqual(found.done, false);

  const unread = await repair._attempt(job, { ...base, readTokenInfo: async () => ({ info: null, unread: "rpc 429" }) });
  assert.deepStrictEqual(unread, { done: false, why: "rpc 429" }, "an unread mint was reported as a token with no artwork");

  const none = await repair._attempt(job, { ...base, readTokenInfo: async () => ({ info: { logoUrl: null }, unread: null }) });
  assert.strictEqual(none.done, true, "an ANSWER with no logo ends the job");
});
