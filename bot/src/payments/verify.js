// Payment verification: a synchronous t=0 balance check, then a poll up to the
// timeout. On success the sweep is fired (not awaited) so onSuccess/fulfilment
// is never blocked by — or gated on — the sweep landing.
const { PAYMENT_POLL_MS, PAYMENT_TIMEOUT_MS, PAYMENT_TOLERANCE_PCT } = require("../config/constants");
const wallets = require("./wallets");
const log = require("../helpers/logger");

// Ceiling on the tolerance knob. A typo (PAYMENT_TOLERANCE_PCT=95) must not
// quietly hand out paid services for 5% of the price.
const MAX_TOLERANCE_PCT = 20;

/** The amount actually accepted as payment.
 *
 *  A customer withdrawing straight from an exchange routinely lands a hair
 *  short — the exchange takes its fee off the top — and with an exact-match
 *  check that payment is never credited: they get nothing, and their funds sit
 *  in a temp wallet that no sweep will ever touch (only paid orders are swept).
 *  PAYMENT_TOLERANCE_PCT was documented in .env.example and exported from
 *  constants, but read by no code at all; setting it did nothing. 0 keeps the
 *  exact-amount behaviour, so this changes nothing until an operator opts in. */
function acceptThreshold(amount) {
  const target = BigInt(amount);
  let pct = Math.floor(Number(PAYMENT_TOLERANCE_PCT) || 0);
  if (pct <= 0) return target;
  if (pct > MAX_TOLERANCE_PCT) {
    log.warn(`[verify] PAYMENT_TOLERANCE_PCT=${pct} is above the ${MAX_TOLERANCE_PCT}% ceiling — clamped`);
    pct = MAX_TOLERANCE_PCT;
  }
  return target - (target * BigInt(pct)) / 100n;
}

/** Resolve true once balance ≥ target, or false at timeout. Never rejects. */
function pollBalance(chain, address, target, timeout = PAYMENT_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const start = Date.now();
    const iv = setInterval(async () => {
      try {
        const bal = await wallets.getBalance(chain, address);
        if (bal >= target) {
          clearInterval(iv);
          return resolve(true);
        }
      } catch (e) {
        log.debug(`[verify] poll ${chain} err: ${e.message}`);
      }
      if (Date.now() - start >= timeout) {
        clearInterval(iv);
        return resolve(false);
      }
    }, PAYMENT_POLL_MS);
  });
}

/** Record a landed sweep on the order so sweepRetry stops re-checking that
 *  wallet. A failure is left unmarked on purpose — that is the retry's cue. */
async function noteSwept(chain, address, txid) {
  try {
    const orders = require("./orders");
    const o = orders.allOrders().find((x) => x.address === address && x.chain === chain);
    if (o) await orders.setStatus(o.id, o.status, { sweptAt: Date.now(), sweptTx: txid || "" });
  } catch (e) {
    log.debug(`[verify] noteSwept: ${e.message}`);
  }
}

/** Confirm `amount` (smallest-unit string/BigInt) has landed at `address`. */
async function verifyPayment(chain, address, amount) {
  if (BigInt(amount) <= 0n) return { paid: true, free: true };
  const target = acceptThreshold(amount);

  let bal = 0n;
  try {
    bal = await wallets.getBalance(chain, address);
  } catch (e) {
    log.debug(`[verify] t0 ${chain}: ${e.message}`);
  }
  let paid = bal >= target;
  if (!paid) paid = await pollBalance(chain, address, target, PAYMENT_TIMEOUT_MS);

  if (paid) {
    // Sweep BEFORE the caller runs fulfilment — but don't block on confirmation.
    // A failure here is not fatal and not final: sweepRetry picks it up.
    wallets
      .sweepByAddress(chain, address)
      .then((r) => {
        if (r && r.ok) return noteSwept(chain, address, r.txid);
        log.warn(`[verify] sweep ${chain} did not land: ${(r && r.error) || "unknown"} — sweepRetry will retry`);
      })
      .catch((e) => log.warn(`[verify] sweep threw ${chain}: ${e.message}`));
  }
  return { paid };
}

module.exports = { verifyPayment, pollBalance, acceptThreshold };
