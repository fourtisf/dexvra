// "fixkan mc dan liquidity di template channel telegram, website dexvra dan
// announce x — setiap token listing harus ada mc cap dan liquidity bukan TBA"
//
// The report: $SFX (Safix, Robinhood, Uniswap v4, pair
// 0x51958cce…bd36) went out as an Xpress Listing to 12,445 subscribers reading
// "Market cap: TBA · Price: TBA", with no liquidity line at all — while
// DexScreener carried it at a $1.0M cap on $85K of liquidity and dexvra.io
// priced it at $1.10M in the same minute. Nothing about the token was missing.
// The post had ONE bounded read, no second attempt, no fallback, and a template
// with no liquidity segment.
//
// Every test here stubs the network: whether DexScreener answers the box is a
// property of its egress, and `npm run post:check` is what measures it there.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-listfig-"));

const test = require("node:test");
const assert = require("node:assert");

const figures = require("../src/marketFigures");
const fulfil = require("../src/fulfillment");
const fmt = require("../src/channels/format");
const tpl = require("../src/templates");
const x = require("../src/twitter");
const postFigures = require("../src/postFigures");

const SFX = "0x0a574aae41da077713ba32aa05ca151c8759e2f6";
// The pair exactly as DexScreener publishes it — including the v4 pool id,
// which is a 32-byte hash and not an address.
const SFX_PAIR = {
  chainId: "robinhood",
  dexId: "uniswap",
  pairAddress: "0x51958cce8f6eee392b53c22005325e94ad605c24ed46f5d6fb225a69f8f9bd36",
  baseToken: { address: SFX, name: "Safix", symbol: "SFX" },
  quoteToken: { symbol: "USDG" },
  priceUsd: "0.001097",
  liquidity: { usd: 85012 },
  marketCap: 1097000,
  fdv: 1097000,
  volume: { h24: 336000 },
  priceChange: { h24: 21.32 },
};

/**
 * A network where DexScreener refuses the first `dsRefusals` asks (the 429 a
 * box sharing its DexScreener budget with nine background pipelines gets) and
 * every other host knows nothing. Records who was asked.
 */
function network({ dsRefusals = 0, dsDown = false, chain503 = false } = {}) {
  const orig = global.fetch;
  const asked = [];
  let dsSeen = 0;
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes("dexscreener")) {
      asked.push("ds");
      dsSeen++;
      if (dsDown || dsSeen <= dsRefusals) return { ok: false, status: 429, headers: { get: () => null }, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ pairs: [SFX_PAIR] }) };
    }
    asked.push(u.includes("geckoterminal") ? "gt" : "other");
    if (chain503 && u.includes("/api/pons")) return { ok: false, status: 503, headers: { get: () => null }, json: async () => ({}), text: async () => "" };
    return { ok: false, status: 404, headers: { get: () => null }, json: async () => ({}), text: async () => "" };
  };
  return { asked, restore: () => (global.fetch = orig) };
}

// ── the pure rules ──────────────────────────────────────────────────────────

test("needsAnotherRead: price and cap always; liquidity only where a POOL exists", () => {
  assert.strictEqual(figures.needsAnotherRead(null), true);
  assert.strictEqual(figures.needsAnotherRead({ priceUsd: 1, mcap: 0 }), true, "no cap is a hole");
  assert.strictEqual(figures.needsAnotherRead({ priceUsd: 0, mcap: 5 }), true, "no price is a hole");
  // A bonding curve has no pool depth at all — re-asking would cost every
  // pre-migration listing the whole retry window for a number that does not exist.
  assert.strictEqual(figures.needsAnotherRead({ priceUsd: 1, mcap: 5, liq: null, poolAddress: null }), false);
  // A reading that NAMES a pool is a pool whose depth we failed to read.
  assert.strictEqual(figures.needsAnotherRead({ priceUsd: 1, mcap: 5, liq: null, poolAddress: "0xpool" }), true);
  assert.strictEqual(figures.needsAnotherRead({ priceUsd: 1, mcap: 5, liq: 9, poolAddress: "0xpool" }), false);
});

test("mergeFigures fills HOLES and never replaces an answer", () => {
  const a = { priceUsd: 2, mcap: 0, liq: null, poolAddress: null, name: "A" };
  const b = { priceUsd: 3, mcap: 50, liq: 7, poolAddress: "0xp", name: "B" };
  const m = figures.mergeFigures(a, b);
  assert.strictEqual(m.priceUsd, 2, "an earlier answer stands");
  assert.strictEqual(m.mcap, 50, "a 0 is a hole — it would render as TBA");
  assert.strictEqual(m.liq, 7);
  assert.strictEqual(m.poolAddress, "0xp");
  assert.strictEqual(m.name, "A");
  assert.deepStrictEqual(figures.mergeFigures(null, b), b);
  assert.deepStrictEqual(figures.mergeFigures(a, null), a);
});

test("a snapshot is refused when it is too old, from the future, or undated", () => {
  const now = 10_000_000;
  const hour = 3_600_000;
  const snap = { priceUsd: 1, mcap: 2, liq: 3, at: now - 60_000 };
  assert.deepStrictEqual(figures.usableSnapshot(snap, now, hour), { priceUsd: 1, mcap: 2, liq: 3, at: now - 60_000 });
  assert.strictEqual(figures.usableSnapshot({ ...snap, at: now - 2 * hour }, now, hour), null, "too old to publish");
  assert.strictEqual(figures.usableSnapshot({ ...snap, at: now + 60_000 }, now, hour), null, "a reading of unknown age is not a claim");
  assert.strictEqual(figures.usableSnapshot({ priceUsd: 1, mcap: 2 }, now, hour), null, "undated");
  assert.strictEqual(figures.usableSnapshot(snap, now, 0), null, "a zero window turns it off");
});

test("a snapshot carries FIGURES and nothing else — it cannot smuggle a pool or a zero", () => {
  // A stray poolAddress would make the watch page over a curve's missing depth,
  // and a 0 is a hole, not a reading. What leaves is exactly what may publish.
  const now = 10_000_000;
  const got = figures.usableSnapshot({ priceUsd: 1, mcap: 0, liq: -3, poolAddress: "0xpool", at: now - 1 }, now, 3_600_000);
  assert.deepStrictEqual(got, { priceUsd: 1, at: now - 1 });
});

test("snapshotOf takes the first positive figure per field, in the order given", () => {
  const s = figures.snapshotOf([{ priceUsd: 5, mcap: null, liq: 0 }, { priceUsd: 9, mcap: 70, liq: 8 }], 123);
  assert.deepStrictEqual(s, { priceUsd: 5, mcap: 70, liq: 8, at: 123 });
  assert.strictEqual(figures.snapshotOf([null, { liq: 0 }], 1), null, "nothing read is no snapshot");
});

test("rowFigures leaves a hole OUT — a re-list must never erase a figure it did not carry", () => {
  assert.deepStrictEqual(figures.rowFigures({ priceUsd: 0.001, mcap: 1e6, liq: 0 }), { price: 0.001, mcap: 1e6 });
  assert.deepStrictEqual(figures.rowFigures(null), {});
});

// ── the read: asked again while a figure is a hole ──────────────────────────

test("⚠️ THE REPORTED STATE: DexScreener refuses the first ask — the post asks again and gets every figure", async () => {
  const { asked, restore } = network({ dsRefusals: 1 });
  try {
    const r = await fulfil._readPostMarket("robinhood", SFX, "test");
    assert.ok(r.live, "one refused request used to BE the whole post");
    assert.strictEqual(r.live.priceUsd, 0.001097);
    assert.strictEqual(r.live.mcap, 1097000);
    assert.strictEqual(r.live.liq, 85012);
    assert.strictEqual(r.why, null, "a read that ended priced carries no why");
    assert.ok(r.attempts >= 2, `it had to ask again: ${r.attempts}`);
    assert.ok(asked.filter((w) => w === "ds").length >= 2);
  } finally {
    restore();
  }
});

test("⚠️ a read that ENDS priced carries no why — the first attempt's failure is not the post's story", async () => {
  // The first attempt's chain read answers 503 (a why); the second is priced.
  // A reason printed beside a real number is the two-cells-disagreeing defect.
  require("../src/ponsChain")._reset();
  const { restore } = network({ dsRefusals: 1, chain503: true });
  try {
    const r = await fulfil._readPostMarket("robinhood", SFX, "test");
    assert.ok(r.attempts >= 2, "the first attempt had to fail for this to mean anything");
    assert.strictEqual(r.live.mcap, 1097000);
    assert.strictEqual(r.why, null, `got: ${r.why}`);
  } finally {
    restore();
    require("../src/ponsChain")._reset();
  }
});

test("…and while it is still unpriced, the FIRST reason is what it names — not whatever the last attempt said", async () => {
  // A later attempt answering "parked" or "rate limited" must not bury the
  // failure that started it (the rule solana.js states for its host list).
  const market = require("../src/marketdata");
  const real = market.fetchMarket;
  let n = 0;
  market.fetchMarket = async () => {
    n++;
    throw new Error(n === 1 ? "the one that started it" : "a later echo");
  };
  try {
    const r = await fulfil._readPostMarket("robinhood", SFX, "test", { tries: 3, pauseMs: 0 });
    assert.strictEqual(n, 3, "every attempt was made");
    assert.match(String(r.why), /the one that started it/, `got: ${r.why}`);
  } finally {
    market.fetchMarket = real;
  }
});

test("…and a healthy token pays exactly ONE read — the retry is for holes only", async () => {
  const { asked, restore } = network();
  try {
    const r = await fulfil._readPostMarket("robinhood", SFX, "test");
    assert.strictEqual(r.attempts, 1);
    assert.strictEqual(asked.filter((w) => w === "ds").length, 1);
    assert.ok(!asked.includes("gt"), "DexScreener had all three — GeckoTerminal is not asked");
  } finally {
    restore();
  }
});

test("⚠️ every live attempt failing still publishes the FORM's reading — when it is recent", async () => {
  const { restore } = network({ dsDown: true });
  try {
    const snapshot = { priceUsd: 0.00109, mcap: 1090000, liq: 84000, at: Date.now() - 4 * 60_000 };
    const r = await fulfil._readPostMarket("robinhood", SFX, "test", { snapshot });
    assert.strictEqual(r.from, "form");
    assert.strictEqual(r.live.mcap, 1090000);
    assert.strictEqual(r.live.liq, 84000);
    assert.strictEqual(r.live.priceUsd, 0.00109);

    // …and a reading from two hours ago is not one to publish.
    const old = await fulfil._readPostMarket("robinhood", SFX, "test", { snapshot: { ...snapshot, at: Date.now() - 2 * 3_600_000 } });
    assert.strictEqual(old.from, null);
    assert.ok(!old.live || !(old.live.mcap > 0), "a stale snapshot must not be published");
  } finally {
    restore();
  }
});

test("a live figure is never replaced by the snapshot's — the snapshot only fills holes", async () => {
  const { restore } = network();
  try {
    const snapshot = { priceUsd: 9, mcap: 9, liq: 9, at: Date.now() };
    const r = await fulfil._readPostMarket("robinhood", SFX, "test", { snapshot });
    assert.strictEqual(r.from, null);
    assert.strictEqual(r.live.mcap, 1097000);
  } finally {
    restore();
  }
});

// ── what actually publishes ─────────────────────────────────────────────────

const COIN = {
  name: "Safix",
  symbol: "SFX",
  chain: "robinhood",
  address: SFX,
  tier: "XPRESS",
  price: 0.001097,
  mcap: 1097000,
  liq: 85012,
  links: {},
};

test("the shipped DEFAULTS carry {liq} themselves — the editor shows what publishes", () => {
  // ensureAfter would insert it at render time anyway (which is why dropping it
  // from a default is behaviour-neutral on the post); this is about the admin
  // bot's editor, which shows the stored/default text raw.
  for (const k of ["post_listing_xpress", "post_listing_tiered", "post_trending", "x_listing", "x_listing_tiered"]) {
    assert.match(String(tpl.DEFAULTS[k]), /\{mcap\}[^\n]*\{liq\}/, `${k} lost its liquidity beside the market cap`);
  }
});

test("the shipped channel card carries market cap AND liquidity", () => {
  const out = fmt.listingPost(COIN);
  const text = out.text != null ? out.text : out.html;
  assert.match(text, /Market cap: \$1\.1\d?M/);
  assert.match(text, /Liquidity: \$85(\.\d+)?K/);
  assert.doesNotMatch(text, /TBA/);
});

test("⚠️ an operator's SAVED card without {liq} still publishes liquidity — markup form", async () => {
  const saved = "💲 {name} ({symbol})\n\n📊 **Market cap:** {mcap} · **Price:** {price}\n\n📄 {address}";
  await tpl.setTemplate("post_listing_xpress", saved);
  try {
    const out = fmt.listingPost(COIN);
    assert.match(out.text, /Market cap: \$1\.1\d?M · 💧 Liquidity: \$85(\.\d+)?K · Price:/);
  } finally {
    await tpl.resetTemplate("post_listing_xpress");
  }
});

test("⚠️ …and the pasted {text, entities} form keeps every entity on its own characters", async () => {
  // A premium emoji AFTER the insertion point is the thing a naive insertion
  // breaks: its offset has to move by exactly the inserted length.
  const text = "Market cap: {mcap} · Price: {price} 🔥 done";
  const fire = text.indexOf("🔥");
  const saved = {
    text,
    entities: [
      { type: "bold", offset: 0, length: "Market cap:".length },
      { type: "custom_emoji", offset: fire, length: 2, custom_emoji_id: "5368324170671202286" },
    ],
  };
  const v = tpl.ensureAfter(saved, tpl.LIQ_SEGMENT);
  assert.match(v.text, /\{mcap\} · 💧 Liquidity: \{liq\} · Price/);
  const moved = v.entities.find((e) => e.type === "custom_emoji");
  assert.strictEqual(v.text.slice(moved.offset, moved.offset + moved.length), "🔥", "the premium emoji stayed on its glyph");
  const bolds = v.entities.filter((e) => e.type === "bold").map((e) => v.text.slice(e.offset, e.offset + e.length));
  assert.deepStrictEqual(bolds.sort(), ["Liquidity:", "Market cap:"], "the operator's bold untouched, the new label bold too");
  // Already carries it → untouched, byte for byte.
  assert.strictEqual(tpl.ensureAfter(v, tpl.LIQ_SEGMENT), v);
  // No market line to anchor to → untouched, never guessed.
  const none = { text: "no market here", entities: [] };
  assert.strictEqual(tpl.ensureAfter(none, tpl.LIQ_SEGMENT), none);
});

test("the trending card carries liquidity too", () => {
  const out = fmt.trendingPost(COIN);
  assert.match(out.text, /Liquidity: \$85(\.\d+)?K/);
});

test("the X listing tweet carries MC AND liquidity — the shipped copy and an old saved one", async () => {
  assert.match(x._text.listingText(COIN), /MC: \$1\.1\d?M {2}\| {2}Liq: \$85(\.\d+)?K/);
  assert.match(x._text.listingText({ ...COIN, tier: "GOLD" }), /Liq: \$85(\.\d+)?K/);
  await tpl.setTemplate("x_listing", "New on Dexvra ${tag}\nPrice: {price}  |  MC: {mcap}\n#Dexvra");
  try {
    assert.match(x._text.listingText(COIN), /MC: \$1\.1\d?M {2}\| {2}Liq: \$85(\.\d+)?K/);
  } finally {
    await tpl.resetTemplate("x_listing");
  }
  // No reading is a dash — "$0" reads as a rug.
  assert.match(x._text.listingText({ ...COIN, liq: null }), /Liq: —/);
});

test("the figure watch pages on a missing liquidity only where a pool exists", () => {
  const base = { kind: "listing", chain: "robinhood", address: SFX, sym: "SFX", name: "Safix" };
  assert.ok(postFigures.figureAlert({ ...base, live: { priceUsd: 1, mcap: 2, liq: null, poolAddress: "0xpool" } }), "a pool we failed to read");
  assert.strictEqual(postFigures.figureAlert({ ...base, live: { priceUsd: 1, mcap: 2, liq: null, poolAddress: null } }), null, "a curve has no depth — not a fault");
});

// ── driven end to end: one order, three surfaces ────────────────────────────

test("⚠️ DRIVEN: a paid listing with a refused first read publishes the figures on the ROW, the CARD and the TWEET", async () => {
  const api = require("../src/api/dexvra");
  const post = require("../src/channels/post");
  const bt = require("../src/bannerTemplate");
  const br = require("../src/bannerRender");
  const postids = require("../src/channels/postids");
  const te = require("../src/tokenEmoji");
  const saved = {
    create: api.createListing, send: post.sendMedia, mirror: post.mirrorToGroup, postListing: x.postListing,
    compose: bt.compose, render: br.renderListingBanner, ids: postids.set, emoji: te.ensureTokenEmoji,
  };
  let row = null;
  let card = null;
  let tweet = null;
  api.createListing = async (input) => ((row = { ...input }), { id: "L1" });
  post.sendMedia = async (chat, media, payload) => ((card = card || payload), { message_id: 1 });
  post.mirrorToGroup = async () => null;
  x.postListing = async (coin) => ((tweet = x._text.listingText(coin)), null);
  bt.compose = async () => null;
  br.renderListingBanner = async () => null;
  postids.set = async () => {};
  te.ensureTokenEmoji = async () => null;
  const { restore } = network({ dsRefusals: 1 });
  try {
    await fulfil.fulfillListing(
      { telegram: {}, reply: async () => ({}) },
      { payload: { listingInput: { chain: "robinhood", address: SFX, sym: "SFX", name: "Safix", tier: "XPRESS" }, trendHours: 0 } },
    );
    assert.ok(row, "the create was reached");
    assert.strictEqual(row.mcap, 1097000, "dexvra.io's row is born with the cap the post published");
    assert.strictEqual(row.liq, 85012, "…and the liquidity");
    const text = card && (card.text != null ? card.text : card.html);
    assert.ok(text, "the listing card was posted");
    assert.doesNotMatch(text, /TBA/, `the channel card: ${text}`);
    assert.match(text, /Liquidity: \$85/);
    assert.ok(tweet, "the tweet was built");
    assert.doesNotMatch(tweet, /TBA/, `the tweet: ${tweet}`);
    assert.match(tweet, /Liq: \$85/);
  } finally {
    restore();
    api.createListing = saved.create;
    post.sendMedia = saved.send;
    post.mirrorToGroup = saved.mirror;
    x.postListing = saved.postListing;
    bt.compose = saved.compose;
    br.renderListingBanner = saved.render;
    postids.set = saved.ids;
    te.ensureTokenEmoji = saved.emoji;
  }
});

// ── the form keeps what it read ─────────────────────────────────────────────

test("⚠️ the listing FORM keeps the figures it read, and hands them to the order", async () => {
  const listing = require("../src/handlers/listing");
  const pay = require("../src/handlers/pay");
  const listedGuard = require("../src/helpers/listedGuard");
  const real = { ...listing._lookups };
  const realBlock = listedGuard.blockIfListed;
  const realPay = pay.startPayment;
  let order = null;
  listing._lookups.fetchTokenInfo = async () => ({ name: "Safix", symbol: "SFX", logoUrl: null, priceUsd: 0.0011, mcap: 1.1e6, liq: 0 });
  listing._lookups.fetchMarket = async () => ({ priceUsd: 0.001097, mcap: 1097000, liq: 85012, poolAddress: SFX_PAIR.pairAddress });
  listing._lookups.fetchTokenDescription = async () => null;
  listedGuard.blockIfListed = async () => false;
  pay.startPayment = async (ctx, o) => (order = o);
  const session = { type: "xpress_listing", form: { ...listing._test.emptyForm(), chain: "robinhood" }, awaitingField: "address" };
  const ctx = {
    chat: { id: 7, type: "private" }, from: { id: 7 }, session, message: { text: SFX },
    reply: async () => ({ message_id: 1 }), replyWithPhoto: async () => ({ message_id: 1 }),
    telegram: { deleteMessage: async () => {}, editMessageText: async () => ({}) }, answerCbQuery: async () => {},
  };
  try {
    await listing.handleText(ctx);
    const m = session.form.market;
    assert.ok(m, "the form must keep what it read");
    assert.strictEqual(m.mcap, 1097000, "the market read leads");
    assert.strictEqual(m.liq, 85012, "…and its liquidity, not the profile's 0");
    assert.ok(Number.isFinite(m.at), "dated, so fulfilment can refuse it when stale");
    await listing.goPay(ctx, "XPRESS");
    assert.ok(order, "the payment was armed");
    assert.deepStrictEqual(order.payload.market, m, "the order carries the snapshot to fulfilment");
  } finally {
    Object.assign(listing._lookups, real);
    listedGuard.blockIfListed = realBlock;
    pay.startPayment = realPay;
  }
});
