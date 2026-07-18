// Payment verification: a synchronous t=0 balance check, then a poll up to the
// timeout. On success the sweep is fired (not awaited) so onSuccess/fulfilment
// is never blocked by — or gated on — the sweep landing.
const { PAYMENT_POLL_MS, PAYMENT_TIMEOUT_MS } = require("../config/constants");
const wallets = require("./wallets");
const log = require("../helpers/logger");

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

/** Confirm `amount` (smallest-unit string/BigInt) has landed at `address`. */
async function verifyPayment(chain, address, amount) {
  const target = BigInt(amount);
  if (target <= 0n) return { paid: true, free: true };

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
    wallets.sweepByAddress(chain, address).catch((e) => log.warn(`[verify] sweep threw ${chain}: ${e.message}`));
  }
  return { paid };
}

module.exports = { verifyPayment, pollBalance };
