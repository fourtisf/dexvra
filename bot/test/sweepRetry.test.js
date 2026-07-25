// A failed sweep used to be a log line and nothing else — the buyer's money
// stayed in the temp wallet until a human opened an explorer. sweepRetry closes
// that, and its safety rule is the entire point: it may only touch wallets of
// orders that were already paid for. Sweeping a `pending` wallet would take
// funds for something we never delivered.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
const dir = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-sweepr-"));
process.env.BOT_DATA_DIR = dir;

const DAY = 24 * 3600 * 1000;
const now = 1800000000000;
const order = (id, o) => ({ id, chain: "solana", address: `addr_${id}`, createdAt: now - DAY, ...o });
// Written before the orders module is required — it loads its file at require.
fss.mkdirSync(dir, { recursive: true });
fss.writeFileSync(
  path.join(dir, "orders.json"),
  JSON.stringify({
    fulfilled: order("fulfilled", { status: "fulfilled" }),
    paid: order("paid", { status: "paid" }),
    pending: order("pending", { status: "pending" }),
    expired: order("expired", { status: "expired" }),
    free: order("free", { status: "fulfilled", adminFree: true }),
    done: order("done", { status: "fulfilled", sweptAt: now - 1000 }),
    ancient: order("ancient", { status: "fulfilled", createdAt: now - 400 * DAY }),
    noaddr: { id: "noaddr", status: "fulfilled", chain: "solana", createdAt: now - DAY },
  }),
);

const test = require("node:test");
const assert = require("node:assert");
const sweepRetry = require("../src/services/sweepRetry");

const ids = (list) => list.map((o) => o.id).sort();

test("only wallets whose order was actually paid for are candidates", () => {
  assert.deepStrictEqual(ids(sweepRetry.candidates(now)), ["fulfilled", "paid"]);
});

test("a pending order's wallet is never swept", () => {
  // The buyer may have sent funds we haven't credited. Taking those without
  // delivering is the one mistake that cannot be undone.
  assert.ok(!sweepRetry.candidates(now).some((o) => o.status === "pending"));
  assert.ok(!sweepRetry.candidates(now).some((o) => o.status === "expired"));
});

test("a FREE admin test order has no funds to chase", () => {
  assert.ok(!sweepRetry.candidates(now).some((o) => o.adminFree));
});

test("an order already marked swept is not re-checked forever", () => {
  assert.ok(!sweepRetry.candidates(now).some((o) => o.id === "done"));
});

test("orders without an address, or long past recovery, are skipped", () => {
  const got = ids(sweepRetry.candidates(now));
  assert.ok(!got.includes("noaddr"));
  assert.ok(!got.includes("ancient"));
});

test("the newest orders are attempted first", () => {
  // A pass is bounded, so ordering decides what gets recovered this cycle —
  // recent money is the money someone is waiting on.
  const c = sweepRetry.candidates(now);
  for (let i = 1; i < c.length; i++) assert.ok(c[i - 1].createdAt >= c[i].createdAt);
});

test("it is wired into the running bot, not just defined", () => {
  const src = fss.readFileSync(require.resolve("../src/services/attach.js"), "utf8");
  assert.match(src, /require\("\.\/sweepRetry"\)\.start\(\)/, "sweepRetry must actually start");
});

test("a successful sweep on the normal path marks the order, a failure does not", () => {
  // The retry pass finds work by the ABSENCE of sweptAt — so marking on failure
  // would silently strand the funds it exists to recover.
  const src = fss.readFileSync(require.resolve("../src/payments/verify.js"), "utf8");
  assert.match(src, /if \(r && r\.ok\) return noteSwept\(/, "marked only when the sweep landed");
  assert.match(src, /sweepRetry will retry/, "and the failure says so out loud");
});
