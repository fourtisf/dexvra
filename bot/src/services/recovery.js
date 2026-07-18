// Restart recovery. Two gaps to close, both safe because order payloads are
// serializable and temp-wallet keys are persisted:
//   (a) orders that took payment ('paid') but didn't finish fulfilment
//       (process died mid-post / internal API briefly down) → re-fulfil.
//   (b) 'pending' orders whose funds actually arrived while the bot was down
//       (user paid, then the bot restarted before they tapped Confirm) →
//       detect the balance, sweep, fulfil.
const orders = require("../payments/orders");
const wallets = require("../payments/wallets");
const { fulfillOrder } = require("../fulfillment");
const log = require("../helpers/logger");

const DAY = 24 * 3600 * 1000;

function fakeCtx(tg, order) {
  return {
    telegram: tg,
    from: { id: order.buyerId },
    reply: (t, e) => (order.buyerId ? tg.sendMessage(order.buyerId, t, e) : Promise.resolve()),
  };
}

async function refulfil(tg, order, why) {
  try {
    await fulfillOrder(fakeCtx(tg, order), order);
    await orders.setStatus(order.id, "fulfilled");
    log.info(`[recovery] ${why} order ${order.id} fulfilled`);
  } catch (e) {
    log.warn(`[recovery] ${order.id} still failing: ${e.message}`);
  }
}

async function runRecovery(tg) {
  // (a) paid-but-unfulfilled
  for (const order of orders.unfulfilledPaid()) await refulfil(tg, order, "paid");

  // (b) recent pending orders whose funds may have landed while we were down
  const now = Date.now();
  const pending = orders
    .allOrders()
    .filter((o) => o.status === "pending" && !o.adminFree && o.amountSmallest && now - o.createdAt < DAY);
  for (const o of pending) {
    try {
      const bal = await wallets.getBalance(o.chain, o.address);
      if (bal >= BigInt(o.amountSmallest)) {
        await orders.setStatus(o.id, "paid");
        wallets.sweepByAddress(o.chain, o.address).catch(() => {});
        await refulfil(tg, o, "late-paid");
      }
    } catch (e) {
      log.debug(`[recovery] pending ${o.id}: ${e.message}`);
    }
  }
}

module.exports = { runRecovery };
