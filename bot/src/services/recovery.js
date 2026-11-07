// Payment recovery. Three gaps to close, all safe because order payloads are
// serializable and temp-wallet keys are persisted:
//   (a) orders that took payment ('paid') but didn't finish fulfilment
//       (process died mid-post / internal API briefly down) → re-fulfil.
//   (b) 'pending' orders whose funds actually arrived but were never credited
//       → detect the balance, mark paid, sweep, fulfil.
//   (c) the same check, running on a TIMER and not only at boot.
//
// (c) exists because (b) at boot alone is not enough. Sessions are in-memory
// (telegraf `session()` with no store), so a restart drops pendingPayment and
// the buyer's next "Confirm" tap answers "no pending payment on this chat".
// Their money is then in a temp wallet that nothing sweeps — sweepRetry only
// touches orders already marked paid — and nobody notices until the NEXT
// restart. A bot that stays up for a week loses a week of late payments: the
// customer is charged, receives nothing, and the funds never reach the
// treasury. The same applies to anyone who simply pays after the 5-minute
// window closes, which is common.
const orders = require("../payments/orders");
const wallets = require("../payments/wallets");
const verify = require("../payments/verify");
const { fulfillOrder } = require("../fulfillment");
const log = require("../helpers/logger");

const DAY = 24 * 3600 * 1000;
const LATE_SCAN_MS = 10 * 60 * 1000; // a paying customer should not wait 6h
const LATE_SCAN_BOOT_DELAY_MS = 45 * 1000;
const MAX_PER_SCAN = 30; // bounded RPC work per pass
const GAP_MS = 800; // public RPCs rate-limit

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

// When each pending order was last looked at by the scan, in memory.
//
// ⚠️ NEWEST-FIRST WAS A STARVATION BUG. Every pay-card tap mints an order, the
// scan reads only MAX_PER_SCAN of them, and newest-first meant ~30 abandoned
// taps every ten minutes kept a real buyer who paid late (after the watcher, or
// across a restart) out of the window for good — never credited, never swept,
// never fulfilled. Least-recently-checked first (never-checked leading) reaches
// every order within ceil(n / MAX_PER_SCAN) scans, whatever arrives after it.
const lastChecked = new Map();

/** Pending orders young enough that a late payment is still plausible. */
function pendingCandidates(now = Date.now()) {
  const due = orders
    .allOrders()
    .filter((o) => o.status === "pending" && !o.adminFree && o.amountSmallest && o.address && now - o.createdAt < DAY);
  for (const id of lastChecked.keys()) if (!due.some((o) => o.id === id)) lastChecked.delete(id);
  return due.sort((a, b) => (lastChecked.get(a.id) || 0) - (lastChecked.get(b.id) || 0) || (b.createdAt || 0) - (a.createdAt || 0));
}

/** Credit + fulfil + sweep any pending order whose funds have landed.
 *  Never throws — a dead RPC must not take the bot down. */
async function checkLatePayments(tg) {
  const due = pendingCandidates();
  if (!due.length) return { checked: 0, credited: 0 };
  let checked = 0;
  let credited = 0;
  for (const o of due.slice(0, MAX_PER_SCAN)) {
    try {
      lastChecked.set(o.id, Date.now());
      const bal = await wallets.getBalance(o.chain, o.address);
      checked++;
      // The SAME threshold the Confirm button uses — including the operator's
      // tolerance — so the two paths can never disagree about who has paid.
      if (BigInt(bal) < verify.acceptThreshold(o.amountSmallest)) continue;
      // `o` is a snapshot taken before that await; the Confirm tap or its
      // watcher may have credited and fulfilled it since. Only the winner of
      // the claim fulfils — see orders.claimPaid.
      if (!(await orders.claimPaid(o.id))) continue;
      credited++;
      log.warn(`[recovery] late payment detected on ${o.chain}/${o.address} (order ${o.id}) — crediting`);
      wallets.sweepByAddress(o.chain, o.address).catch((e) => log.warn(`[recovery] sweep threw: ${e.message}`));
      await refulfil(tg, o, "late-paid");
    } catch (e) {
      log.debug(`[recovery] pending ${o.id}: ${e.message}`);
    }
    await sleep(GAP_MS);
  }
  if (credited) log.info(`[recovery] late-payment scan: checked ${checked}, credited ${credited}`);
  return { checked, credited };
}

async function runRecovery(tg) {
  // (a) paid-but-unfulfilled
  for (const order of orders.unfulfilledPaid()) await refulfil(tg, order, "paid");
  // (b) funds that landed while we were down
  await checkLatePayments(tg);
}

/** Boot recovery + the recurring late-payment scan. */
function start(tg) {
  runRecovery(tg).catch((e) => log.warn(`[recovery] boot: ${e.message}`));
  const boot = setTimeout(() => {
    checkLatePayments(tg).catch((e) => log.warn(`[recovery] ${e.message}`));
  }, LATE_SCAN_BOOT_DELAY_MS);
  const iv = setInterval(() => {
    checkLatePayments(tg).catch((e) => log.warn(`[recovery] ${e.message}`));
  }, LATE_SCAN_MS);
  if (boot.unref) boot.unref();
  if (iv.unref) iv.unref();
  log.info(`[recovery] late-payment scan every ${LATE_SCAN_MS / 60000}min`);
  return {
    stop() {
      clearTimeout(boot);
      clearInterval(iv);
    },
    checkLatePayments,
  };
}

module.exports = { runRecovery, checkLatePayments, pendingCandidates, start, _lastChecked: lastChecked };
