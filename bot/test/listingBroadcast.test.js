// "di bawahnya ada fitur add broadcast aturan dengan fee tambahan" — a project
// buying a listing can attach a Mass DM to the SAME order instead of buying it
// separately.
//
// Three rules make it more than a button, and each is a way it could have gone
// wrong quietly:
//   • the fee is MASS_DM_PRICE itself, so the add-on and the standalone product
//     can never quote two different numbers for one thing;
//   • it is charged in the ORDER'S OWN coin ("kalo client book chain bsc
//     pembayaran harus bsc"), which is why a chain that coin table cannot price
//     is never offered the button at all;
//   • and the two prices are added EXACTLY — 1.15 + 0.15 is 1.2999999999999998
//     in float, on the one screen that takes the money.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-bcaddon-"));

const test = require("node:test");
const assert = require("node:assert");

const { addAmount } = require("../src/payments/units");
const addon = require("../src/config/broadcastAddon");
const { TIER_MAP } = require("../src/config/packages");
const { MASS_DM_PRICE } = require("../src/config/constants");
const { payOptionsFor } = require("../src/config/payOptions");
const listing = require("../src/handlers/listing");
const tpl = require("../src/templates");

const XPRESS = TIER_MAP.XPRESS.price;

// ── the money arithmetic ────────────────────────────────────────────────────

test("⚠️ two package prices add EXACTLY, not in float", () => {
  // The case that produced this: Platinum on BSC (1.15) + the add-on (0.15).
  assert.strictEqual(1.15 + 0.15, 1.2999999999999998, "if this ever stops being true, delete addAmount");
  assert.strictEqual(addAmount(1.15, 0.15), 1.3);
  assert.strictEqual(addAmount(0.06, 0.05), 0.11);
  assert.strictEqual(addAmount(2.8, 0.15), 2.95);
  assert.strictEqual(addAmount(1, 1), 2);
  assert.strictEqual(addAmount(900, 0.15), 900.15);
});

test("the total is what a buyer would add up by hand", () => {
  assert.strictEqual(addon.totalWithAddon(XPRESS.SOL, "solana"), 3); // 1 + 2
  assert.strictEqual(addon.totalWithAddon(XPRESS.BNB, "bsc"), 0.55); // 0.25 + 0.3
  assert.strictEqual(addon.totalWithAddon(XPRESS.ETH, "ethereum"), 0.16); // 0.06 + 0.1
  assert.strictEqual(addon.totalWithAddon(TIER_MAP.PLATINUM.price.BNB, "bsc"), 1.45); // 1.15 + 0.3
});

// ⚠️ The SHIPPED DEFAULT, read out of the source rather than off the resolved
// constant. Two reasons, and both are scars in this repo:
//   • an operator's bot/.env wins over the code default, so asserting the
//     RESOLVED value would go red on their box for a reason that has nothing to
//     do with the code — the rule run-tests.js already enforces for templates;
//   • and a price is a business fact, so moving it should be a deliberate line
//     in a diff rather than something that happens on the way past.
test("the shipped fee is the FULL Mass DM price — the launch discount is gone", () => {
  const src = fss.readFileSync(require.resolve("../src/config/constants.js"), "utf8");
  const block = src.slice(src.indexOf("const MASS_DM_PRICE"), src.indexOf("MASS_DM_REVIEW_CHAT_ID"));
  assert.ok(block.length > 50, "MASS_DM_PRICE not found — this scan proves nothing");
  assert.match(block, /MASS_DM_PRICE_SOL\) \|\| 2/, "SOL: 2");
  assert.match(block, /MASS_DM_PRICE_BNB\) \|\| 0\.3/, "BNB: 0.3");
  assert.match(block, /MASS_DM_PRICE_ETH\) \|\| 0\.1/, "ETH: 0.1");
});

// ── one price, one product ──────────────────────────────────────────────────

test("the fee IS the Mass DM price, never a second table", () => {
  assert.strictEqual(addon.addonPrice("solana"), MASS_DM_PRICE.SOL);
  assert.strictEqual(addon.addonPrice("bsc"), MASS_DM_PRICE.BNB);
  assert.strictEqual(addon.addonPrice("ethereum"), MASS_DM_PRICE.ETH);
  // A source scan, because "reads the same constant" is a property no value
  // comparison can prove once the numbers happen to coincide.
  const src = fss.readFileSync(require.resolve("../src/config/broadcastAddon.js"), "utf8");
  assert.match(src, /MASS_DM_PRICE/, "the add-on must read the Mass DM price");
  assert.ok(
    !/=\s*\{\s*SOL\s*:\s*[\d.]/.test(src.replace(/\/\*[\s\S]*?\*\//g, "")),
    "a private price table here would be a second price for one product",
  );
});

// ── paid in the order's own coin ────────────────────────────────────────────

test("⚠️ a chain the add-on cannot price is never offered it", () => {
  // MASS_DM_PRICE has SOL, BNB and ETH only. Tron pays TRX and TON pays TON, so
  // there is no fee to charge in the coin those orders settle in — and charging
  // a second coin is the rule this whole payment path now forbids.
  assert.strictEqual(addon.addonPrice("tron"), null);
  assert.strictEqual(addon.addonPrice("ton"), null);
  assert.strictEqual(addon.canAddBroadcast("tron"), false);
  assert.strictEqual(addon.canAddBroadcast("ton"), false);
  // …and every chain that CAN is offered it.
  for (const c of ["solana", "bsc", "ethereum", "base", "robinhood", "sui", "polygon"]) {
    assert.ok(addon.canAddBroadcast(c), `${c} pays in a coin the add-on prices`);
  }
});

test("⚠️ a currency the add-on cannot price is DROPPED from the order's rails", () => {
  // payOptionsFor turns this table into the networks an order may settle on, so
  // leaving TRX at its bare listing price would sell a Tron rail that charges
  // for the listing and throws the broadcast in for free.
  const t = addon.pricesWithAddon(XPRESS, "solana");
  assert.strictEqual(t.SOL, addAmount(XPRESS.SOL, MASS_DM_PRICE.SOL));
  assert.strictEqual(t.ETH, addAmount(XPRESS.ETH, MASS_DM_PRICE.ETH));
  assert.strictEqual(t.BNB, addAmount(XPRESS.BNB, MASS_DM_PRICE.BNB));
  assert.ok(!("TRX" in t), "TRX has no add-on price — it may not stay at 900");
  assert.ok(!("TON" in t), "TON has no add-on price");
});

test("…and the order's own network survives, so it can still be armed", () => {
  for (const [chain, native] of [["solana", "SOL"], ["bsc", "BNB"], ["ethereum", "ETH"], ["base", "ETH"]]) {
    const opts = payOptionsFor({ chain, prices: addon.pricesWithAddon(XPRESS, chain) });
    assert.ok(opts.length >= 1, `${chain} must still have a rail with the add-on on`);
    assert.strictEqual(opts[0].chain, chain);
    assert.strictEqual(opts[0].native, native);
  }
});

test("⚠️ Robinhood keeps BOTH its ETH rails, and both carry the fee", () => {
  const opts = payOptionsFor({ chain: "robinhood", prices: addon.pricesWithAddon(XPRESS, "robinhood") });
  assert.deepStrictEqual(opts.map((o) => o.chain), ["robinhood", "ethereum"]);
  const eth = addAmount(XPRESS.ETH, MASS_DM_PRICE.ETH);
  assert.deepStrictEqual(opts.map((o) => o.amount), [eth, eth], "a choice of rail, never of price");
});

// ── the flow, driven ────────────────────────────────────────────────────────

const mkCtx = (form) => {
  const sent = [];
  return {
    sent,
    from: { id: 9, username: "buyer" },
    chat: { id: 9, type: "private" },
    session: { type: "xpress_listing", form },
    answerCbQuery: async () => true,
    reply: async (text, extra) => {
      sent.push({ text: String(typeof text === "object" ? text.text || text.html : text), extra: extra || {} });
      return { message_id: sent.length };
    },
    replyWithPhoto: async (_p, extra) => {
      sent.push({ text: String((extra || {}).caption || ""), extra: extra || {} });
      return { message_id: sent.length };
    },
    telegram: { deleteMessage: async () => {} },
  };
};
const form = (over = {}) => ({
  chain: "solana",
  address: "So11111111111111111111111111111111111111112",
  sym: "ACAI",
  name: "Acai",
  overview: "A token.",
  ...over,
});
const buttons = (ctx) => {
  const last = ctx.sent[ctx.sent.length - 1] || {};
  const rows = ((last.extra.reply_markup || {}).inline_keyboard || []);
  return rows.flat().map((b) => b.text);
};

test("the review card offers the add-on, with its fee ON the button", async () => {
  const ctx = mkCtx(form());
  await listing.showReview(ctx);
  const b = buttons(ctx);
  const row = b.find((t) => /Broadcast/.test(t));
  assert.ok(row, "a Solana listing must be offered the add-on");
  assert.ok(row.includes(`${MASS_DM_PRICE.SOL} SOL`), `the fee a buyer reads before tapping is on the button: ${row}`);
});

test("⚠️ …and a Tron listing is offered NO such button at all", async () => {
  const ctx = mkCtx(form({ chain: "tron", address: "TJRyWwFs9wTFGZg3JbrVriFbNfCug5tDeC" }));
  await listing.showReview(ctx);
  assert.ok(!buttons(ctx).some((t) => /Broadcast/.test(t)), "a button whose only outcome is a refusal is not a button");
});

test("composing a broadcast attaches it and returns to the review card", async () => {
  const ctx = mkCtx(form());
  await listing.broadcastAdd(ctx);
  assert.strictEqual(ctx.session.awaitingField, "broadcast");
  assert.ok(ctx.sent[ctx.sent.length - 1].text.includes(`${MASS_DM_PRICE.SOL} SOL`), "the prompt states the fee");

  ctx.message = { text: "  gm from Acai", entities: [{ type: "bold", offset: 2, length: 2 }] };
  await listing.handleText(ctx);
  assert.strictEqual(ctx.session.awaitingField, null);
  // ⚠️ RAW, not trimmed: entity offsets are counted from the start of the
  // message, so a trimmed leading space moves every bold run one char left.
  assert.strictEqual(ctx.session.form.broadcast.text, "  gm from Acai");
  assert.deepStrictEqual(ctx.session.form.broadcast.entities, [{ type: "bold", offset: 2, length: 2 }]);
  assert.ok(buttons(ctx).some((t) => /✏️ Broadcast/.test(t)), "the row switches to edit/remove");
});

test("a photo with a caption can BE the broadcast", async () => {
  const ctx = mkCtx(form());
  await listing.broadcastAdd(ctx);
  ctx.message = { photo: [{ file_id: "PHOTO1" }], caption: "gm", caption_entities: [] };
  await listing.handlePhoto(ctx);
  assert.strictEqual(ctx.session.form.broadcast.mediaFileId, "PHOTO1");
  assert.strictEqual(ctx.session.form.broadcast.text, "gm");
});

test("…and the logo prompt still takes a photo, unchanged", async () => {
  const ctx = mkCtx(form());
  ctx.session.awaitingField = "logo";
  ctx.message = { photo: [{ file_id: "LOGO1" }] };
  await listing.handlePhoto(ctx);
  assert.strictEqual(ctx.session.form.logoFileId, "LOGO1");
  assert.ok(!ctx.session.form.broadcast, "a logo is not a broadcast");
});

test("/cancel backs out and attaches nothing", async () => {
  const ctx = mkCtx(form());
  await listing.broadcastAdd(ctx);
  ctx.message = { text: "/cancel", entities: [] };
  await listing.handleText(ctx);
  assert.strictEqual(ctx.session.awaitingField, null);
  assert.ok(!ctx.session.form.broadcast);
});

test("❌ drops it again", async () => {
  const ctx = mkCtx(form({ broadcast: { text: "gm", entities: [], mediaFileId: null } }));
  await listing.broadcastRemove(ctx);
  assert.strictEqual(ctx.session.form.broadcast, null);
  assert.ok(buttons(ctx).some((t) => /\+ Broadcast/.test(t)), "the row goes back to offering it");
});

test("⚠️ the add-on is re-checked at the TAP, not trusted to the row", async () => {
  // A review card left open in the chat can outlive a chain switch.
  const ctx = mkCtx(form({ chain: "tron", address: "TJRyWwFs9wTFGZg3JbrVriFbNfCug5tDeC" }));
  await listing.broadcastAdd(ctx);
  assert.notStrictEqual(ctx.session.awaitingField, "broadcast", "it must not open a compose step it cannot charge for");
  assert.match(ctx.sent[ctx.sent.length - 1].text, /isn't available/i);
});

test("templates render and are editable in the admin bot", () => {
  for (const k of ["broadcast_addon_prompt", "broadcast_addon_attached", "broadcast_addon_queued", "broadcast_addon_failed", "broadcast_addon_unavailable"]) {
    assert.ok(tpl.meta(k), `${k} must be listed in META or no admin can edit it`);
  }
  assert.match(tpl.render("broadcast_addon_prompt", { fee: "0.15 BNB" }).text, /0\.15 BNB/);
});

// ── the order that reaches the payment path ─────────────────────────────────

test("the fee rides ONE order, in ONE coin, with the message attached", async () => {
  const pay = require("../src/handlers/pay");
  const real = pay.startPayment;
  let armed = null;
  pay.startPayment = async (_ctx, o) => {
    armed = o;
  };
  try {
    const ctx = mkCtx(form({ broadcast: { text: "gm", entities: [], mediaFileId: null } }));
    await listing.goPay(ctx, "XPRESS");
  } finally {
    pay.startPayment = real;
  }
  assert.ok(armed, "goPay must reach the payment path");
  assert.strictEqual(armed.humanAmount, addAmount(XPRESS.SOL, MASS_DM_PRICE.SOL), "the listing plus the fee, in SOL");
  assert.strictEqual(armed.native, "SOL");
  assert.strictEqual(armed.chain, "solana");
  assert.strictEqual(armed.payload.broadcast.text, "gm", "the composed message travels with the order");
  assert.strictEqual(armed.prices.SOL, addAmount(XPRESS.SOL, MASS_DM_PRICE.SOL));
});

test("…and without one, nothing about the order changes", async () => {
  const pay = require("../src/handlers/pay");
  const real = pay.startPayment;
  let armed = null;
  pay.startPayment = async (_ctx, o) => {
    armed = o;
  };
  try {
    await listing.goPay(mkCtx(form()), "XPRESS");
  } finally {
    pay.startPayment = real;
  }
  assert.strictEqual(armed.humanAmount, 1);
  assert.strictEqual(armed.payload.broadcast, null);
  assert.deepStrictEqual(armed.prices, XPRESS, "the untouched table, not a rebuilt copy");
});

test("⚠️ an empty compose is not a broadcast, and is never charged for", async () => {
  const pay = require("../src/handlers/pay");
  const real = pay.startPayment;
  let armed = null;
  pay.startPayment = async (_ctx, o) => {
    armed = o;
  };
  try {
    await listing.goPay(mkCtx(form({ broadcast: { text: "", entities: [], mediaFileId: null } })), "XPRESS");
  } finally {
    pay.startPayment = real;
  }
  assert.strictEqual(armed.humanAmount, 1, "nothing to send, nothing to bill");
  assert.strictEqual(armed.payload.broadcast, null);
});

// ── the queue, DRIVEN ───────────────────────────────────────────────────────
//
// ⚠️ The one link these tests cannot drive end to end is fulfillListing itself:
// it creates the listing through the site API, builds banners, posts to three
// channels and tweets, and standing all of that up would test the stubs. So the
// QUEUE is driven for real here, and the CALL SITE is pinned by a scan below —
// which is mutation-tested, because a scan that cannot fail is not a guard.

const massStore = require("../src/massdm/store");
const fulfilment = require("../src/fulfillment");

function stubStore(onCreate) {
  const realCreate = massStore.createJob;
  const realAud = massStore.audience;
  massStore.createJob = async (job) => {
    if (onCreate) onCreate(job);
    if (job.__boom) throw new Error("disk full");
    return { id: "job1", total: (job.targets || []).length };
  };
  massStore.audience = () => [1, 2, 3];
  return () => {
    massStore.createJob = realCreate;
    massStore.audience = realAud;
  };
}

const queueCtx = () => ({
  from: { id: 9 },
  chat: { id: 9 },
  session: {},
  telegram: { sendMessage: async () => ({}) },
  reply: async () => ({ message_id: 1 }),
});

test("a composed broadcast becomes a pending_review job for the whole audience", async () => {
  let seen = null;
  const restore = stubStore((j) => (seen = j));
  let r;
  try {
    r = await fulfilment.queueBroadcast(queueCtx(), { id: "ord1", buyerId: 9, buyerUsername: "buyer" }, { text: "gm", entities: [{ type: "bold", offset: 0, length: 2 }], mediaFileId: null });
  } finally {
    restore();
  }
  assert.strictEqual(r.ok, true);
  assert.ok(r.ref, "the buyer is given a ref to quote");
  assert.strictEqual(seen.text, "gm");
  assert.deepStrictEqual(seen.entities, [{ type: "bold", offset: 0, length: 2 }]);
  assert.strictEqual(seen.test, false, "a PAID broadcast is queued for review, never sent straight out");
  assert.deepStrictEqual(seen.targets, [1, 2, 3], "the same audience the standalone product reaches");
});

test("⚠️ a queue that will not take it comes back ok:false — it never throws", async () => {
  const realCreate = massStore.createJob;
  massStore.createJob = async () => {
    throw new Error("disk full");
  };
  let r;
  try {
    r = await fulfilment.queueBroadcast(queueCtx(), { id: "ord3", buyerId: 9 }, { text: "gm" });
  } finally {
    massStore.createJob = realCreate;
  }
  // The listing is already live and the funds already swept by this point: a
  // throw here would report a delivered listing as a failed order.
  assert.strictEqual(r.ok, false);
  assert.match(r.why, /disk full/);
  assert.ok(r.ref, "the buyer still gets a ref to quote at support");
});

// ⚠️ A POSITIVE TEST, because a wiring that does nothing refuses beautifully.
// The first cut of this pinned the call site with a SOURCE SCAN — and a mutation
// run walked straight past it: `if (false) {` leaves every string the scan looks
// for exactly where it was. So fulfillListing is DRIVEN, with the site API, the
// channel posts, the banner build and the tweet stubbed out, and the assertion
// is that a job really reaches the queue. The curveBuyPath scar, one package
// over.
function stubListingWorld() {
  const api = require("../src/api/dexvra");
  const post = require("../src/channels/post");
  const market = require("../src/marketdata");
  const x = require("../src/twitter");
  const br = require("../src/bannerRender");
  const bt = require("../src/bannerTemplate");
  const postids = require("../src/channels/postids");
  const te = require("../src/tokenEmoji");
  const saved = { api: { ...api }, post: { ...post }, market: { ...market }, x: { ...x } };
  const savedMore = { br: br.renderListingBanner, bt: bt.compose, ids: postids.set, te: te.forToken };
  api.createListing = async () => ({ id: "L1", ok: true });
  api.getListings = async () => [];
  market.fetchMarket = async () => ({ priceUsd: 1, mcap: 1000, liq: 100, vol24: 10 });
  x.postTweet = async () => null;
  x.tweetListing = async () => null;
  post.sendMedia = async () => ({ message_id: 1 });
  post.send = async () => ({ message_id: 1 });
  br.renderListingBanner = async () => null;
  bt.compose = async () => null;
  postids.set = async () => {};
  te.forToken = async () => "🪙";
  return () => {
    Object.assign(api, saved.api);
    Object.assign(post, saved.post);
    Object.assign(market, saved.market);
    Object.assign(x, saved.x);
    br.renderListingBanner = savedMore.br;
    bt.compose = savedMore.bt;
    postids.set = savedMore.ids;
    te.forToken = savedMore.te;
  };
}

const listingOrder = (broadcast) => ({
  id: `o${Math.random().toString(36).slice(2)}`,
  kind: "xpress_listing",
  buyerId: 9,
  chain: "solana",
  native: "SOL",
  humanAmount: broadcast ? 2 : 1,
  payload: {
    listingInput: { chain: "solana", address: "So11111111111111111111111111111111111111112", sym: "ACAI", name: "Acai", tier: "XPRESS" },
    logoFileId: null,
    trendHours: 0,
    broadcast: broadcast || null,
  },
});

/** Drive a real listing fulfilment; return whatever reached the Mass DM queue. */
async function fulfilWith(broadcast) {
  const unstub = stubListingWorld();
  let queued = null;
  const restore = stubStore((j) => (queued = j));
  try {
    await fulfilment.fulfillOrder(queueCtx(), listingOrder(broadcast));
  } finally {
    restore();
    unstub();
  }
  return queued;
}

test("⚠️ a listing PAID for with a broadcast really queues one", async () => {
  const q = await fulfilWith({ text: "gm from Acai", entities: [], mediaFileId: null });
  assert.ok(q, "the buyer paid for a broadcast — it has to reach the queue");
  assert.strictEqual(q.text, "gm from Acai");
  assert.strictEqual(q.test, false, "paid → pending_review, never sent straight out");
});

test("…and a listing without one queues nothing at all", async () => {
  assert.strictEqual(await fulfilWith(null), null, "no add-on, no job");
});
