// Restart recovery: re-fulfil orders that took payment ('paid') but didn't finish
// fulfilment (e.g. the process died mid-post, or the internal API was briefly
// down). Runs once at boot. Safe because order payloads are serializable.
const orders = require("../payments/orders");
const { fulfillOrder } = require("../fulfillment");
const log = require("../helpers/logger");

async function recoverPaidOrders(tg) {
  const paid = orders.unfulfilledPaid();
  if (!paid.length) return;
  log.info(`[recovery] re-fulfilling ${paid.length} paid order(s)`);
  for (const order of paid) {
    const ctx = {
      telegram: tg,
      from: { id: order.buyerId },
      reply: (t, e) => (order.buyerId ? tg.sendMessage(order.buyerId, t, e) : Promise.resolve()),
    };
    try {
      await fulfillOrder(ctx, order);
      await orders.setStatus(order.id, "fulfilled");
      log.info(`[recovery] fulfilled ${order.id}`);
    } catch (e) {
      log.warn(`[recovery] ${order.id} still failing: ${e.message}`);
    }
  }
}

module.exports = { recoverPaidOrders };
