// "harusnya ada fitur add broadcast setelah dpt address kaya fourtisbot" — the
// broadcast add-on sits on the PAY CARD, beside Confirm Payment, on the card
// that already carries the deposit address.
//
// ⚠️ WHICH MAKES THE ADDRESS THE WHOLE DESIGN CONSTRAINT. generateWallet()
// mints a fresh keypair on every call, so re-arming the order would hand the
// buyer a SECOND address — and a buyer who had already sent to the first would
// have paid into a wallet this order no longer verifies against. The order is
// edited in place instead: same address, higher total, and verifyPayment
// compares the BALANCE there against the new amount, so what was already sent
// still counts.
//
// The other two rules: the fee is MASS_DM_PRICE itself (one table, two
// products), and it is charged in the order's OWN currency — which on this path
// is `order.native`, because by the pay card a Robinhood buyer may have picked
// either ETH rail.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-bcaddon-"));

const test = require("node:test");
const assert = require("node:assert");

const { addAmount, toSmallest } = require("../src/payments/units");
const addon = require("../src/config/broadcastAddon");
const { TIER_MAP } = require("../src/config/packages");
const { MASS_DM_PRICE } = require("../src/config/constants");
const pay = require("../src/handlers/pay");
const wallets = require("../src/payments/wallets");
const orders = require("../src/payments/orders");
const tpl = require("../src/templates");

const XPRESS = TIER_MAP.XPRESS.price;

// ── the money arithmetic ────────────────────────────────────────────────────

test("⚠️ two package prices add EXACTLY, not in float", () => {
  // The case that produced addAmount: Platinum on BSC (1.15) + a 0.15 fee.
  assert.strictEqual(1.15 + 0.15, 1.2999999999999998, "if this ever stops being true, delete addAmount");
  assert.strictEqual(addAmount(1.15, 0.15), 1.3);
  assert.strictEqual(addAmount(0.06, 0.05), 0.11);
  assert.strictEqual(addAmount(2.8, 0.15), 2.95);
  assert.strictEqual(addAmount(1, 2), 3);
  assert.strictEqual(addAmount(900, 0.15), 900.15);
});

// ⚠️ The SHIPPED DEFAULT, read out of the SOURCE rather than off the resolved
// constant: an operator's bot/.env beats the code default, so asserting the
// resolved value would go red on their box for a reason that has nothing to do
// with the code. And a price is a business fact — moving it should be a
// deliberate line in a diff.
test("the shipped fee is the FULL Mass DM price — the launch discount is gone", () => {
  const src = fss.readFileSync(require.resolve("../src/config/constants.js"), "utf8");
  const block = src.slice(src.indexOf("const MASS_DM_PRICE"), src.indexOf("MASS_DM_REVIEW_CHAT_ID"));
  assert.ok(block.length > 50, "MASS_DM_PRICE not found — this scan proves nothing");
  assert.match(block, /MASS_DM_PRICE_SOL\) \|\| 2/, "SOL: 2");
  assert.match(block, /MASS_DM_PRICE_BNB\) \|\| 0\.3/, "BNB: 0.3");
  assert.match(block, /MASS_DM_PRICE_ETH\) \|\| 0\.1/, "ETH: 0.1");
});

test("the fee IS the Mass DM price, never a second table", () => {
  assert.strictEqual(addon.addonPriceForNative("SOL"), MASS_DM_PRICE.SOL);
  assert.strictEqual(addon.addonPriceForNative("BNB"), MASS_DM_PRICE.BNB);
  assert.strictEqual(addon.addonPriceForNative("ETH"), MASS_DM_PRICE.ETH);
  const src = fss.readFileSync(require.resolve("../src/config/broadcastAddon.js"), "utf8");
  assert.match(src, /MASS_DM_PRICE/, "the add-on must read the Mass DM price");
  assert.ok(
    !/=\s*\{\s*SOL\s*:\s*[\d.]/.test(src.replace(/\/\*[\s\S]*?\*\//g, "")),
    "a private price table here would be a second price for one product",
  );
});

test("⚠️ a currency the add-on cannot price gets no fee at all", () => {
  // MASS_DM_PRICE has SOL, BNB and ETH only. A Tron order settles in TRX and a
  // TON order in TON, so there is nothing to charge in the coin those orders
  // actually pay in — and a second coin is what this payment path forbids.
  assert.strictEqual(addon.addonPriceForNative("TRX"), null);
  assert.strictEqual(addon.addonPriceForNative("TON"), null);
  assert.strictEqual(addon.addonPriceForNative(undefined), null);
});

// ── the pay card, driven ────────────────────────────────────────────────────

const ADDR = "GETjVBRPYtssumNhU9zBvqtNtLWMSCPu8rzVyvqcWfPk";

const mkCtx = () => {
  const sent = [];
  return {
    sent,
    from: { id: 9, username: "buyer" },
    chat: { id: 9, type: "private" },
    session: {},
    answerCbQuery: async () => true,
    reply: async (text, extra) => {
      sent.push({ text: String(typeof text === "object" ? text.text || text.html : text), extra: extra || {} });
      return { message_id: sent.length };
    },
    telegram: { deleteMessage: async () => {} },
  };
};
const buttons = (ctx) => {
  const last = ctx.sent[ctx.sent.length - 1] || {};
  const rows = ((last.extra.reply_markup || {}).inline_keyboard || []);
  return rows.flat().map((b) => b.text);
};
const lastText = (ctx) => (ctx.sent[ctx.sent.length - 1] || {}).text || "";

const order = (over = {}) => ({
  kind: "xpress_listing",
  chain: "solana",
  native: "SOL",
  humanAmount: XPRESS.SOL,
  prices: XPRESS,
  label: "Xpress Listing — $HOLYFROG on Solana",
  payload: { listingInput: { chain: "solana", address: "So1111", sym: "HOLYFROG", name: "Holy Frog" }, trendHours: 0 },
  ...over,
});

/** Arm an order for real, with the wallet and the store stubbed out. */
async function arm(o, { admin = false } = {}) {
  const ctx = mkCtx();
  const realW = wallets.generateWallet;
  const realS = orders.saveOrder;
  let wallets_made = 0;
  wallets.generateWallet = async () => {
    wallets_made += 1;
    return { address: ADDR };
  };
  orders.saveOrder = async () => {};
  const realAdmin = process.env.ADMIN_IDS;
  if (admin) process.env.ADMIN_IDS = "9";
  try {
    // isAdminUser reads ADMIN_IDS at REQUIRE time, so an admin order is driven
    // through the flag armPayment already computed rather than the env.
    await pay.startPayment(ctx, o);
  } finally {
    wallets.generateWallet = realW;
    orders.saveOrder = realS;
    if (realAdmin == null) delete process.env.ADMIN_IDS;
    else process.env.ADMIN_IDS = realAdmin;
  }
  return { ctx, walletsMade: () => wallets_made, restubWallet: () => {
    wallets.generateWallet = async () => {
      wallets_made += 1;
      return { address: "SECOND_ADDRESS" };
    };
    return () => (wallets.generateWallet = realW);
  } };
}

test("the pay card offers the add-on, with its fee on the button", async () => {
  const { ctx } = await arm(order());
  const row = buttons(ctx).find((t) => /Broadcast/.test(t));
  assert.ok(row, "a SOL order must be offered the add-on");
  assert.ok(row.includes(`${MASS_DM_PRICE.SOL} SOL`), `the fee is on the button: ${row}`);
  assert.ok(buttons(ctx).some((t) => /Confirm/.test(t)), "…beside Confirm, not instead of it");
  assert.match(lastText(ctx), new RegExp(String(XPRESS.SOL)), "the card still quotes the listing price alone");
});

test("⚠️ a Tron order's card carries NO such button", async () => {
  const { ctx } = await arm(order({ chain: "tron", native: "TRX", humanAmount: XPRESS.TRX }));
  assert.ok(!buttons(ctx).some((t) => /Broadcast/.test(t)), "a button whose only outcome is a refusal is not a button");
});

test("⚠️ adding it does NOT change the deposit address", async () => {
  const a = await arm(order());
  const { ctx } = a;
  const before = ctx.session.pendingPayment.address;
  const undo = a.restubWallet(); // any re-arm from here would mint SECOND_ADDRESS
  try {
    await pay.broadcastAsk(ctx);
    assert.strictEqual(ctx.session.awaitingPayBroadcast, true);
    await pay.broadcastCapture(ctx, { text: "gm", entities: [], mediaFileId: null });
  } finally {
    undo();
  }
  assert.strictEqual(ctx.session.pendingPayment.address, before, "the address a buyer may already have sent to");
  assert.strictEqual(before, ADDR);
  assert.strictEqual(a.walletsMade(), 1, "exactly one wallet was ever minted for this order");
});

test("…and the total, the smallest-unit amount and the message all move together", async () => {
  const { ctx } = await arm(order());
  await pay.broadcastAsk(ctx);
  await pay.broadcastCapture(ctx, { text: "  gm", entities: [{ type: "bold", offset: 2, length: 2 }], mediaFileId: null });
  const o = ctx.session.pendingPayment.order;
  const total = addAmount(XPRESS.SOL, MASS_DM_PRICE.SOL);
  assert.strictEqual(o.humanAmount, total);
  assert.strictEqual(o.amountSmallest, toSmallest("solana", total).toString(), "what verifyPayment compares against");
  assert.strictEqual(o.payload.broadcast.text, "  gm", "RAW — trimming shifts every entity offset");
  assert.deepStrictEqual(o.payload.broadcast.entities, [{ type: "bold", offset: 2, length: 2 }]);
  assert.match(lastText(ctx), new RegExp(String(total)), "the redrawn card quotes the new total");
});

test("…and the button is gone once it is attached", async () => {
  const { ctx } = await arm(order());
  await pay.broadcastAsk(ctx);
  await pay.broadcastCapture(ctx, { text: "gm", entities: [], mediaFileId: null });
  assert.ok(!buttons(ctx).some((t) => /Add Broadcast/.test(t)), "nothing may be charged for twice");
});

test("a photo with a caption can BE the broadcast", async () => {
  const { ctx } = await arm(order());
  await pay.broadcastAsk(ctx);
  await pay.broadcastCapture(ctx, { text: "gm", entities: [], mediaFileId: "PHOTO1" });
  assert.strictEqual(ctx.session.pendingPayment.order.payload.broadcast.mediaFileId, "PHOTO1");
});

test("↩️ leaves the order exactly as it was", async () => {
  const { ctx } = await arm(order());
  await pay.broadcastAsk(ctx);
  await pay.broadcastCancel(ctx);
  const o = ctx.session.pendingPayment.order;
  assert.strictEqual(ctx.session.awaitingPayBroadcast, false);
  assert.strictEqual(o.humanAmount, XPRESS.SOL, "nothing added");
  assert.ok(!o.payload.broadcast);
  assert.ok(buttons(ctx).some((t) => /Add Broadcast/.test(t)), "the card comes back with the offer intact");
});

test("⚠️ the tap is re-checked, not trusted to the card that offered it", async () => {
  // A pay card left open in the chat outlives a restart that turned the product
  // off, or an add-on that has since been attached from another tap.
  const { ctx } = await arm(order());
  ctx.session.pendingPayment.order.payload.broadcast = { text: "already", entities: [], mediaFileId: null };
  await pay.broadcastAsk(ctx);
  assert.notStrictEqual(ctx.session.awaitingPayBroadcast, true, "it must not open a compose step it would refuse");
});

test("⚠️ with no pending payment it says so rather than doing nothing", async () => {
  const ctx = mkCtx();
  await pay.broadcastAsk(ctx);
  assert.ok(ctx.sent.length, "a tap that goes nowhere is a dead button");
});

// ── the routers ─────────────────────────────────────────────────────────────
//
// The pay card is shared by every package, so the compose step has no
// session.type to dispatch on and must be caught ABOVE the flow routers.

test("⚠️ the compose step is answered with NO session.type at all", async () => {
  const text = require("../src/handlers/text");
  const { ctx } = await arm(order());
  await pay.broadcastAsk(ctx);
  assert.ok(!ctx.session.type, "an armed pay card carries no flow type of its own");
  // ⚠️ LEADING WHITESPACE ON PURPOSE. The trim this guards against happens in
  // the ROUTER, so a message with nothing to trim lets the mutant through — it
  // did, on the first cut of this test. Telegram entity offsets are counted
  // from the start of the message, so dropping those two spaces moves the bold
  // run two characters left and the broadcast goes out mis-formatted.
  ctx.message = { text: "  gm from the pay card", entities: [{ type: "bold", offset: 2, length: 2 }] };
  await text.textRouter(ctx);
  const got = ctx.session.pendingPayment.order.payload.broadcast;
  assert.strictEqual(got.text, "  gm from the pay card", "raw, exactly as Telegram sent it");
  assert.strictEqual(got.text.slice(2, 4), "gm", "the bold run still covers what it did when it arrived");
  assert.deepStrictEqual(got.entities, [{ type: "bold", offset: 2, length: 2 }]);
});

test("…and a photo reaches it the same way", async () => {
  const text = require("../src/handlers/text");
  const { ctx } = await arm(order());
  await pay.broadcastAsk(ctx);
  ctx.message = { photo: [{ file_id: "P9" }], caption: "gm", caption_entities: [] };
  await text.mediaRouter(ctx);
  assert.strictEqual(ctx.session.pendingPayment.order.payload.broadcast.mediaFileId, "P9");
});

test("templates render and are editable in the admin bot", () => {
  for (const k of ["broadcast_addon_prompt", "broadcast_addon_attached", "broadcast_addon_queued", "broadcast_addon_failed"]) {
    assert.ok(tpl.meta(k), `${k} must be listed in META or no admin can edit it`);
  }
  assert.match(tpl.render("broadcast_addon_prompt", { fee: "0.3 BNB" }).text, /0\.3 BNB/);
});

// ── the queue, DRIVEN ───────────────────────────────────────────────────────

const massStore = require("../src/massdm/store");
const fulfilment = require("../src/fulfillment");

function stubStore(onCreate) {
  const realCreate = massStore.createJob;
  const realAud = massStore.audience;
  massStore.createJob = async (job) => {
    if (onCreate) onCreate(job);
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
    r = await fulfilment.queueBroadcast(queueCtx(), { id: "ord1", buyerId: 9 }, { text: "gm", entities: [{ type: "bold", offset: 0, length: 2 }], mediaFileId: null });
  } finally {
    restore();
  }
  assert.strictEqual(r.ok, true);
  assert.ok(r.ref, "the buyer is given a ref to quote");
  assert.strictEqual(seen.text, "gm");
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

// ⚠️ A POSITIVE test, because a wiring that does nothing refuses beautifully.
// An earlier cut pinned this call site with a SOURCE SCAN, and a mutation run
// walked straight past it: `if (false) {` leaves every string the scan looks
// for exactly where it was. So fulfillListing is DRIVEN.
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
  const more = { br: br.renderListingBanner, bt: bt.compose, ids: postids.set, te: te.forToken };
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
    br.renderListingBanner = more.br;
    bt.compose = more.bt;
    postids.set = more.ids;
    te.forToken = more.te;
  };
}

async function fulfilWith(broadcast) {
  const unstub = stubListingWorld();
  let queued = null;
  const restore = stubStore((j) => (queued = j));
  try {
    await fulfilment.fulfillOrder(queueCtx(), {
      id: `o${Math.random().toString(36).slice(2)}`,
      kind: "xpress_listing",
      buyerId: 9,
      chain: "solana",
      native: "SOL",
      humanAmount: broadcast ? 3 : 1,
      payload: {
        listingInput: { chain: "solana", address: "So11111111111111111111111111111111111111112", sym: "ACAI", name: "Acai", tier: "XPRESS" },
        logoFileId: null,
        trendHours: 0,
        broadcast: broadcast || null,
      },
    });
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
