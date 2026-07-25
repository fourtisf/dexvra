// Stranded-funds recovery.
//
// The sweep is deliberately fire-and-forget (verify.js): fulfilment must never
// wait on, or be gated by, a chain confirmation. The cost of that choice is
// that a failed sweep is a warning in the log and nothing else — the buyer's
// SOL/ETH/TRX sits in a temp wallet forever, and nobody notices until someone
// opens an explorer. A broken Solana sweep stranded real money exactly this
// way.
//
// So the sweep gets a retry loop. The safety rule is the whole design: only
// wallets belonging to an order that is already `paid` or `fulfilled` are
// touched. That money is earned. A `pending` order's wallet is never swept
// here — the buyer may have sent funds we haven't credited yet, and taking
// those without delivering is the one unrecoverable mistake available.
const orders = require("../payments/orders");
const wallets = require("../payments/wallets");
const log = require("../helpers/logger");

const EVERY_MS = 6 * 3600 * 1000; // a stranded balance is not urgent, just permanent
const BOOT_DELAY_MS = 90 * 1000; // let the bot finish starting first
const MAX_PER_PASS = 25; // bounded RPC work per pass
const GAP_MS = 1500; // public RPC endpoints rate-limit hard
const MAX_AGE_MS = 90 * 24 * 3600 * 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Orders whose wallet may still hold funds: earned, unswept, not ancient. */
function candidates(now = Date.now()) {
  return orders
    .allOrders()
    .filter(
      (o) =>
        (o.status === "paid" || o.status === "fulfilled") &&
        !o.adminFree &&
        o.chain &&
        o.address &&
        !o.sweptAt &&
        now - (o.createdAt || 0) < MAX_AGE_MS,
    )
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

/** One pass. Never throws — a bad RPC must not take the bot down. */
async function runOnce() {
  const due = candidates();
  if (!due.length) return { checked: 0, swept: 0 };
  let checked = 0;
  let swept = 0;
  for (const o of due.slice(0, MAX_PER_PASS)) {
    try {
      // BigInt() because ethers returns its own bigint-ish type per version.
      const bal = BigInt(await wallets.getBalance(o.chain, o.address));
      checked++;
      if (bal === 0n) {
        // Already emptied (the normal path swept it) — stop re-checking it.
        await orders.setStatus(o.id, o.status, { sweptAt: Date.now(), sweptNote: "already empty" });
        continue;
      }
      log.warn(`[sweepretry] ${o.chain}/${o.address} still holds ${bal} (order ${o.id}) — sweeping`);
      const r = await wallets.sweepByAddress(o.chain, o.address);
      if (r && r.ok) {
        swept++;
        await orders.setStatus(o.id, o.status, { sweptAt: Date.now(), sweptTx: r.txid || "" });
        log.info(`[sweepretry] recovered ${o.chain} order ${o.id} (tx=${r.txid})`);
      } else {
        // Left unmarked on purpose: the next pass tries again.
        log.warn(`[sweepretry] ${o.chain} order ${o.id} still stuck: ${(r && r.error) || "unknown"}`);
      }
    } catch (e) {
      log.debug(`[sweepretry] ${o.id}: ${e.message}`);
    }
    await sleep(GAP_MS);
  }
  if (checked) log.info(`[sweepretry] checked ${checked} wallet(s), recovered ${swept}`);
  return { checked, swept };
}

function start() {
  const boot = setTimeout(() => {
    runOnce().catch((e) => log.warn(`[sweepretry] ${e.message}`));
  }, BOOT_DELAY_MS);
  const iv = setInterval(() => {
    runOnce().catch((e) => log.warn(`[sweepretry] ${e.message}`));
  }, EVERY_MS);
  if (boot.unref) boot.unref();
  if (iv.unref) iv.unref();
  log.info(`[sweepretry] started — retrying failed sweeps every ${EVERY_MS / 3600000}h`);
  return {
    stop() {
      clearTimeout(boot);
      clearInterval(iv);
    },
    runOnce,
  };
}

module.exports = { start, runOnce, candidates };
