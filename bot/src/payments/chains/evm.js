// EVM adapter (ethers v6) — covers ethereum / bsc / base / robinhood. One keypair
// is valid on all of them; the chain only selects the RPC + gas market.
const { ethers } = require("ethers");
const { RPC } = require("../../config/constants");
const log = require("../../helpers/logger");

const PLAIN_TRANSFER_GAS = 21000n; // intrinsic cost of an EOA → EOA send
const ATTEMPTS = 3; // public RPCs rate-limit; a quote can also go stale
const CONFIRM_TIMEOUT_MS = 120000; // never block a sweep pass on a stuck mempool

function provider(chain) {
  const url = RPC[chain];
  // No silent fallback to the Ethereum RPC: reading (or sweeping) the wrong
  // chain reports an empty wallet while the funds sit untouched on the real
  // one — a silent loss. A missing RPC is a config error and must say so.
  if (!url) throw new Error(`no RPC configured for EVM chain "${chain}"`);
  return new ethers.JsonRpcProvider(url);
}

async function generate() {
  const w = ethers.Wallet.createRandom();
  return { address: w.address, privateKey: w.privateKey };
}

/** Native balance in wei (BigInt). */
async function getBalance(chain, address) {
  return provider(chain).getBalance(address);
}

/** Gas this exact send needs. 21000 is only right for an EOA recipient — a
 *  treasury that is a contract (Safe/multisig, exchange deposit proxy) runs
 *  code on receive, and a hardcoded 21000 burns the gas on an out-of-gas
 *  revert, every time, without ever delivering. */
async function gasFor(p, from, to) {
  try {
    const est = await p.estimateGas({ from, to, value: 1n });
    const e = BigInt(est);
    return e > PLAIN_TRANSFER_GAS ? (e * 12n) / 10n : PLAIN_TRANSFER_GAS;
  } catch (e) {
    log.debug(`[evm] estimateGas fell back to ${PLAIN_TRANSFER_GAS}: ${e.message}`);
    return PLAIN_TRANSFER_GAS;
  }
}

/** Sweep the native balance to `treasury`, keeping back only what the node
 *  actually reserves for gas. */
async function sweep(chain, wallet, treasury) {
  let last = "unknown";
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    let sent = null;
    try {
      const p = provider(chain);
      const signer = new ethers.Wallet(wallet.privateKey, p);
      const bal = BigInt(await p.getBalance(wallet.address));
      if (bal <= 0n) return { ok: false, error: "empty" };

      const fee = await p.getFeeData();
      const eip1559 = fee.maxFeePerGas != null && fee.maxPriorityFeePerGas != null;
      // The node's balance check is against the PRICE CAP, not the price it
      // will charge, so that is exactly what has to be held back.
      const priceCap = eip1559 ? BigInt(fee.maxFeePerGas) : fee.gasPrice != null ? BigInt(fee.gasPrice) : null;
      if (!priceCap) return { ok: false, error: "no gas price from RPC" };

      const gasLimit = await gasFor(p, wallet.address, treasury);
      // Reserve gasLimit × cap — no arbitrary multiplier. The old 2× buffer
      // stranded a full extra transaction's worth of native token in every
      // temp wallet, permanently, on every order.
      const reserve = gasLimit * priceCap;
      const value = bal - reserve;
      if (value <= 0n) {
        // Not a failure to retry forever: the balance cannot pay for its own
        // sweep, so it is dust and stays where it is.
        return { ok: false, dust: true, error: `balance ${bal} below sweep cost ${reserve}` };
      }

      const tx = {
        to: treasury,
        value,
        gasLimit,
        ...(eip1559
          ? { maxFeePerGas: fee.maxFeePerGas, maxPriorityFeePerGas: fee.maxPriorityFeePerGas }
          : { gasPrice: fee.gasPrice }),
      };
      sent = await signer.sendTransaction(tx);
      // Broadcast: committed. Never loop past this point — a second attempt
      // would reuse the nonce and fight its own pending transaction.
      await sent.wait(1, CONFIRM_TIMEOUT_MS);
      log.info(`[evm] swept ${value} wei (gas ${gasLimit}×${priceCap}) on ${chain} → ${treasury} tx=${sent.hash}`);
      return { ok: true, txid: sent.hash, value };
    } catch (e) {
      last = e.message;
      if (sent) {
        // In the mempool but not confirmed in time. Reported as not-ok so the
        // retry pass re-checks the BALANCE later — the truth is on-chain, and
        // claiming success here would stop anyone ever looking again.
        log.warn(`[evm] ${chain} sweep broadcast but unconfirmed (tx=${sent.hash}): ${e.message}`);
        return { ok: false, txid: sent.hash, error: `unconfirmed: ${e.message}` };
      }
      log.debug(`[evm] sweep ${chain} attempt ${attempt}/${ATTEMPTS}: ${e.message}`);
    }
  }
  return { ok: false, error: last };
}

module.exports = { family: "evm", generate, getBalance, sweep, gasFor };
