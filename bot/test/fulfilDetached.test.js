// A paid order must not run inside the callback deadline.
//
// Telegraf is built with handlerTimeout: 120000 and confirmPayHandler used to
// AWAIT fulfillOrder, so a tiered listing — animated emoji build, market read,
// two ffmpeg clip composites, the X tweet raced to 30s, four media uploads, all
// serial — had two minutes to finish or the framework killed the promise.
//
// Hit for real on 2026-09-06: Confirm at 14:24, "Running your order — hang
// tight…", and at 14:26 the ops channel got
//   [telegraf] callback_query handler error: Promise timed out after 120000 ms
// The timeout does NOT cancel the work, so the listing still went live and the
// only thing that changed was that the buyer got an error instead of a receipt.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-fulfil-"));

const test = require("node:test");
const assert = require("node:assert");

const fulfilment = require("../src/fulfillment");
const { confirmPayHandler } = require("../src/payments/payment");

const fakeCtx = (order) => ({
  from: { id: 42, username: "buyer" },
  chat: { id: 42 },
  session: { pendingPayment: { order, address: "So1111", adminFree: true } },
  answerCbQuery: async () => true,
  reply: async () => ({ message_id: 1 }),
});

const order = {
  id: "ord_detach_1",
  kind: "tiered_listing",
  chain: "solana",
  native: "SOL",
  humanAmount: "0",
  amountSmallest: "0",
  label: "Diamond Listing",
  buyerId: 42,
  payload: { listingInput: { chain: "solana", address: "So1111", sym: "ZCAT", name: "ZCat" } },
};

test("the buyer's tap is answered while fulfilment is still running", async (t) => {
  const orig = fulfilment.fulfillOrder;
  t.after(() => (fulfilment.fulfillOrder = orig));

  // A fulfilment that does not finish — the two-minute listing, in miniature.
  let release;
  let started = 0;
  const gate = new Promise((r) => (release = r));
  fulfilment.fulfillOrder = () => {
    started += 1;
    return gate;
  };

  const handler = confirmPayHandler(fakeCtx(order)).then(() => "handler");
  const timer = new Promise((r) => setTimeout(r, 2000, "still-awaiting").unref?.());
  const winner = await Promise.race([handler, timer]);

  // On the old code the handler is parked on fulfillOrder and the timer wins —
  // which is precisely the 120s handlerTimeout, arrived at two seconds sooner.
  assert.strictEqual(winner, "handler", "confirmPayHandler must return before fulfilment finishes");

  // …and detaching must not mean DROPPING it. A handler that returned because
  // the work never started would pass the assertion above and deliver nothing.
  assert.strictEqual(started, 1, "fulfilment still runs, just off the deadline");

  release();
  await gate;
});

test("the pending payment is cleared inside the handler, not from the runner", () => {
  // Telegraf writes ctx.session back after next() resolves, so the assignment
  // has to happen while the middleware chain still owns the session. Made from
  // the detached runner it is dropped on the floor, and the buyer's spent pay
  // card stays live — a second Confirm on an order already being fulfilled.
  const src = fss.readFileSync(path.join(__dirname, "../src/payments/payment.js"), "utf8");
  const body = src.slice(src.indexOf("async function confirmPayHandler"), src.indexOf("async function runFulfilment"));
  const handlerPart = body.slice(0, body.indexOf("const fulfilling"));
  assert.match(handlerPart, /ctx\.session\.pendingPayment = null;/, "the handler must clear it itself");
  const runner = src.slice(src.indexOf("async function runFulfilment"));
  assert.ok(!/ctx\.session\.pendingPayment\s*=/.test(runner), "the detached runner must not write to the session");
});
