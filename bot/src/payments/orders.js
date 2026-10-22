// Order persistence (data/orders.json) — restart-safe record of every payment
// intent + its serializable fulfilment payload. Unlike the reference bot (which
// keeps onSuccess only in memory), a paid-but-unfulfilled order can be recovered
// after a restart because its payload lives here.
const { loadJSONSync, saveJSON } = require("../helpers/persist");

const FILE = "orders.json";
const orders = loadJSONSync(FILE, {});

async function saveOrder(o) {
  orders[o.id] = o;
  await saveJSON(FILE, orders);
}
function getOrder(id) {
  return orders[id] || null;
}
function allOrders() {
  return Object.values(orders);
}
async function setStatus(id, status, extra) {
  if (!orders[id]) return null;
  orders[id].status = status;
  orders[id].updatedAt = Date.now();
  if (extra) Object.assign(orders[id], extra);
  await saveJSON(FILE, orders);
  return orders[id];
}
/**
 * Credit an order — pending → paid — for exactly ONE caller.
 *
 * ⚠️ THREE PATHS CAN SEE THE SAME PAYMENT: the Confirm tap, the watcher behind
 * it, and recovery's late-payment scan. Recovery reads a SNAPSHOT of pending
 * orders and then awaits a balance read, so a watcher that credited and
 * fulfilled the order inside that await was followed by a second setStatus and
 * a second fulfilment — two listings, two trending bookings, or two broadcasts
 * to the whole audience, for one payment. The check and the set happen here
 * with no await between them, which in one process is atomic; every crediting
 * path goes through it, and only the caller that gets `true` may fulfil.
 *
 * An order missing from the store (its first save failed) is claimable: no
 * other path can see it, so there is nobody to race.
 */
async function claimPaid(id) {
  const o = orders[id];
  if (!o) return true;
  if (o.status !== "pending") return false;
  o.status = "paid";
  o.updatedAt = Date.now();
  await saveJSON(FILE, orders);
  return true;
}

/** Orders that took payment (paid) but haven't been fulfilled — recovery target. */
function unfulfilledPaid() {
  return Object.values(orders).filter((o) => o.status === "paid");
}

module.exports = { saveOrder, getOrder, allOrders, setStatus, claimPaid, unfulfilledPaid };
