// One payment, one fulfilment — and no buyer left out of the late-payment scan.
//
// Recovery's scan reads a SNAPSHOT of pending orders and then awaits a balance
// read. A Confirm tap or its watcher that credited and fulfilled the order
// inside that await was followed by a second setStatus and a second
// fulfilment: two listings, or two broadcasts to the whole audience, for one
// payment. And it read only the 30 NEWEST pending orders, so a run of
// abandoned pay-card taps kept a real late payer out of the window for good.
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "dexvra-payrace-"));

const test = require("node:test");
const assert = require("node:assert");

const orders = require("../src/payments/orders");
const wallets = require("../src/payments/wallets");
const recovery = require("../src/services/recovery");

const pending = (id, over = {}) => ({
  id, status: "pending", chain: "solana", address: `ADDR_${id}`, amountSmallest: "1000",
  native: "SOL", humanAmount: "0.000001", createdAt: Date.now() - 60_000, payload: {}, ...over,
});

test("two crediting paths racing on one order: exactly one wins", async () => {
  await orders.saveOrder(pending("race-1"));
  const results = await Promise.all([orders.claimPaid("race-1"), orders.claimPaid("race-1")]);
  assert.deepStrictEqual(results.sort(), [false, true]);
  assert.strictEqual(orders.getOrder("race-1").status, "paid");
  assert.strictEqual(await orders.claimPaid("race-1"), false, "and a third, later, loses too");
});

test("an order the store never held is claimable — nothing else can see it to race", async () => {
  assert.strictEqual(await orders.claimPaid("never-saved"), true);
});

test("⚠️ recovery does not fulfil an order the watcher credited during its balance read", async () => {
  await orders.saveOrder(pending("race-2"));
  const realBal = wallets.getBalance;
  const realSweep = wallets.sweepByAddress;
  let swept = 0;
  wallets.sweepByAddress = async () => { swept += 1; };
  // The balance read is where the window is: the watcher wins the claim
  // while recovery is waiting on the RPC, and the money is genuinely there.
  wallets.getBalance = async (_c, addr) => {
    if (addr === "ADDR_race-2") assert.strictEqual(await orders.claimPaid("race-2"), true, "vacuity: the watcher got there first");
    return 10n ** 9n;
  };
  try {
    const r = await recovery.checkLatePayments({ sendMessage: async () => {} });
    assert.strictEqual(r.credited, 0, "the snapshot said pending; the claim said otherwise, and the claim is the truth");
    assert.strictEqual(swept, 0, "nothing swept or fulfilled a second time");
  } finally {
    wallets.getBalance = realBal;
    wallets.sweepByAddress = realSweep;
  }
});

test("⚠️ a late payer is reached even behind a wall of newer abandoned orders", () => {
  const now = Date.now();
  orders.saveOrder(pending("late-payer", { createdAt: now - 3 * 3600_000 }));
  const spam = Array.from({ length: 40 }, (_, k) => pending(`spam-${k}`, { createdAt: now - k * 1000 }));
  for (const o of spam) orders.saveOrder(o);
  const first = recovery.pendingCandidates(now).slice(0, 30).map((o) => o.id);
  assert.ok(!first.includes("late-payer"), "precondition: the first scan is the newest thirty");
  for (const id of first) recovery._lastChecked.set(id, now);   // what that scan stamps
  const second = recovery.pendingCandidates(now).slice(0, 30).map((o) => o.id);
  assert.ok(second.includes("late-payer"), "the next scan reaches the order nobody has looked at");
});
