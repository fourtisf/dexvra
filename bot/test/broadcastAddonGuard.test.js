// The Broadcast add-on may only be charged where it is delivered, and only
// while the order's amount is still the amount being checked.
//
// Two defects, found by the security audit, both on the money path:
//  · the button was gated on the CURRENCY alone, so trending, banner and Mass
//    DM orders were offered it and charged for it — and only fulfillListing
//    ever reads `payload.broadcast`, so the buyer paid the fee for nothing;
//  · the toggle still worked after ✅ Confirm. The watcher polls against the
//    amount the order had when it started, so a buyer could tap Confirm, add
//    the broadcast, send only the base price, be credited, and get an
//    unreviewed DM to the whole audience for free.
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "dexvra-addon-guard-"));

const test = require("node:test");
const assert = require("node:assert");

const { TIER_MAP } = require("../src/config/packages");
const pay = require("../src/handlers/pay");
const payment = require("../src/payments/payment");
const verify = require("../src/payments/verify");
const wallets = require("../src/payments/wallets");
const orders = require("../src/payments/orders");

const XPRESS = TIER_MAP.XPRESS.price;
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
  return ((last.extra.reply_markup || {}).inline_keyboard || []).flat().map((b) => b.text);
};
const order = (over = {}) => ({
  kind: "xpress_listing",
  chain: "solana",
  native: "SOL",
  humanAmount: XPRESS.SOL,
  prices: XPRESS,
  label: "Xpress Listing — $HOLYFROG on Solana",
  payload: { listingInput: { chain: "solana", address: "So1111", sym: "HOLYFROG" }, trendHours: 0 },
  ...over,
});

async function arm(o) {
  const ctx = mkCtx();
  const realW = wallets.generateWallet;
  const realS = orders.saveOrder;
  wallets.generateWallet = async () => ({ address: ADDR });
  orders.saveOrder = async () => {};
  try { await pay.startPayment(ctx, o); } finally { wallets.generateWallet = realW; orders.saveOrder = realS; }
  return ctx;
}

for (const kind of ["trending", "banner", "mass_dm"]) {
  test(`⚠️ a ${kind} order is never offered — or charged — the listing add-on`, async () => {
    const ctx = await arm(order({ kind, label: `${kind} — $HOLYFROG` }));
    assert.ok(buttons(ctx).some((t) => /Confirm/.test(t)), "vacuity: this is the pay card");
    assert.ok(!buttons(ctx).some((t) => /Broadcast/.test(t)), "no button for a feature this order does not deliver");
    const before = ctx.session.pendingPayment.order.humanAmount;
    const realS = orders.saveOrder;
    orders.saveOrder = async () => {};
    try { await pay.broadcastToggle(ctx); } finally { orders.saveOrder = realS; }   // a stale or crafted tap
    assert.strictEqual(ctx.session.pendingPayment.order.humanAmount, before, "and a stale tap cannot add the fee");
    assert.ok(!ctx.session.pendingPayment.order.payload.broadcast);
  });
}

test("a listing order still gets the add-on — the gate is the kind, not the button", async () => {
  const ctx = await arm(order());
  assert.ok(buttons(ctx).some((t) => /Broadcast/.test(t)));
});

test("⚠️ once ✅ Confirm is checking the payment, the amount cannot move", async () => {
  const ctx = await arm(order());
  const realVerify = verify.verifyPayment;
  // The first read: not there yet. The watcher's poll: still running.
  verify.verifyPayment = async (_c, _a, _amt, opts) => (opts && opts.timeout === 0 ? { paid: false } : new Promise(() => {}));
  try {
    await payment.confirmPayHandler(ctx);
    const id = ctx.session.pendingPayment.order.id;
    assert.strictEqual(payment.inFlight(id), true, "vacuity: the watcher really is running");
    const before = ctx.session.pendingPayment.order.humanAmount;
    const realS = orders.saveOrder;
    orders.saveOrder = async () => {};
    try { await pay.broadcastToggle(ctx); } finally { orders.saveOrder = realS; }
    assert.strictEqual(ctx.session.pendingPayment.order.humanAmount, before, "the watcher is checking THIS amount");
    assert.ok(!ctx.session.pendingPayment.order.payload.broadcast, "and no broadcast was attached for free");
  } finally { verify.verifyPayment = realVerify; }
});

test("…nor after the order is already paid", async () => {
  const ctx = await arm(order());
  const realGet = orders.getOrder;
  orders.getOrder = () => ({ status: "paid" });
  try {
    const before = ctx.session.pendingPayment.order.humanAmount;
    await pay.broadcastToggle(ctx);
    assert.strictEqual(ctx.session.pendingPayment.order.humanAmount, before);
  } finally { orders.getOrder = realGet; }
});
