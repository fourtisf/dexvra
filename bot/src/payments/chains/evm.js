// EVM adapter (ethers v6) — covers ethereum / bsc / base / robinhood. One keypair
// is valid on all of them; the chain only selects the RPC + gas market.
const { ethers } = require("ethers");
const { rpcRead, rpcUrls } = require("../../config/rpc");
const log = require("../../helpers/logger");

const PLAIN_TRANSFER_GAS = 21000n; // intrinsic cost of an EOA → EOA send
const ATTEMPTS = 3; // public RPCs rate-limit; a quote can also go stale
const CONFIRM_TIMEOUT_MS = 120000; // never block a sweep pass on a stuck mempool

function provider(chain, url) {
  // No silent fallback to the Ethereum RPC: reading (or sweeping) the wrong
  // chain reports an empty wallet while the funds sit untouched on the real
  // one — a silent loss. A missing RPC is a config error and must say so.
  const endpoint = url || rpcUrls(chain)[0];
  if (!endpoint) throw new Error(`no RPC configured for EVM chain "${chain}"`);
  return new ethers.JsonRpcProvider(endpoint);
}

async function generate() {
  const w = ethers.Wallet.createRandom();
  return { address: w.address, privateKey: w.privateKey };
}

// Every provider built during one call, so they can all be torn down when it
// ends. A JsonRpcProvider pointed at an unreachable node retries network
// detection once a second FOREVER and holds the event loop open doing it — so
// one left behind per failed sweep attempt is a permanent background request
// loop, and a CLI pass (treasury --live, a sweep run) never exits.
function tracked(chain, url, made) {
  const p = provider(chain, url);
  made.set(url, p);
  return p;
}
function dropAll(made) {
  for (const p of made.values()) {
    try {
      p.destroy?.();
    } catch {
      /* best effort */
    }
  }
  made.clear();
}

/** Native balance in wei (BigInt).
 *
 *  This is the read that decides whether a customer has paid, so it walks every
 *  endpoint the chain has. A node that is down must surface as an ERROR — an
 *  unreadable balance is unknown, never zero. Returning 0 here reports a paid
 *  order as unpaid and the buyer is told their payment timed out. */
async function getBalance(chain, address) {
  const made = new Map();
  try {
    const { value } = await rpcRead(chain, (url) => tracked(chain, url, made).getBalance(address));
    return value;
  } finally {
    dropAll(made);
  }
}

/** The fee cap to sign with on an EIP-1559 chain.
 *
 *  Whatever cap is set, the node RESERVES gasLimit × cap and charges only
 *  gasLimit × (baseFee + tip); the difference is refunded — back into the temp
 *  wallet, as dust worth less than the gas it would cost to collect. So the
 *  cap is not free headroom: every gwei of it is money left behind on every
 *  order.
 *
 *  ethers' getFeeData quotes 2×baseFee + tip, which is right for a user's
 *  time-sensitive transaction and wasteful for a sweep. The protocol caps the
 *  base fee rise at 12.5% per block, so 1.5× still covers roughly three blocks
 *  of worst-case increase — and a sweep that does sit pending is not an
 *  incident: the funds are safe where they are and sweepRetry comes back.
 *
 *  Halving the headroom halves the leftover. On a legacy-gas chain (BSC) there
 *  is no refund at all: the price reserved is the price charged, so the wallet
 *  ends at exactly zero. */
const FEE_CAP_TENTHS = 15n; // ×1.5 of base fee, plus the tip

async function feeCap(p, fee) {
  try {
    const blk = await p.getBlock("latest");
    if (blk && blk.baseFeePerGas != null) {
      const tip = BigInt(fee.maxPriorityFeePerGas);
      return (BigInt(blk.baseFeePerGas) * FEE_CAP_TENTHS) / 10n + tip;
    }
  } catch (e) {
    log.debug(`[evm] baseFee lookup failed, using the RPC's own cap: ${e.message}`);
  }
  return BigInt(fee.maxFeePerGas); // safe fallback: the generous quote
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
    const made = new Map();
    try {
      // The opening read PICKS THE ENDPOINT, and everything after it — the fee
      // quote, the gas estimate, the broadcast — stays on that same node.
      // Reading from a healthy backup and then broadcasting to the dead primary
      // only moves where it fails; and a send must never be retried on a second
      // node, because a broadcast that failed at the transport layer may still
      // have reached the network. Nothing is signed until a node has answered,
      // so choosing here cannot double-spend.
      const { value: opened } = await rpcRead(chain, async (url) => {
        const p = tracked(chain, url, made);
        return { p, bal: BigInt(await p.getBalance(wallet.address)) };
      });
      const { p, bal } = opened;
      const signer = new ethers.Wallet(wallet.privateKey, p);
      if (bal <= 0n) return { ok: false, error: "empty" };

      const fee = await p.getFeeData();
      const eip1559 = fee.maxFeePerGas != null && fee.maxPriorityFeePerGas != null;
      // The node's balance check is against the PRICE CAP, not the price it
      // will charge, so that is exactly what has to be held back.
      const priceCap = eip1559 ? await feeCap(p, fee) : fee.gasPrice != null ? BigInt(fee.gasPrice) : null;
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
          ? { maxFeePerGas: priceCap, maxPriorityFeePerGas: fee.maxPriorityFeePerGas }
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
    } finally {
      // Runs after every await above has settled — including `sent.wait()` — so
      // this can never tear down a provider a broadcast is still using.
      dropAll(made);
    }
  }
  return { ok: false, error: last };
}

module.exports = { family: "evm", generate, getBalance, sweep, gasFor };
