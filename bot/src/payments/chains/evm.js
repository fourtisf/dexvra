// EVM adapter (ethers v6) — covers ethereum / bsc / base / robinhood. One keypair
// is valid on all of them; the chain only selects the RPC + gas market.
const { ethers } = require("ethers");
const { RPC } = require("../../config/constants");
const log = require("../../helpers/logger");

function provider(chain) {
  return new ethers.JsonRpcProvider(RPC[chain] || RPC.ethereum);
}

async function generate() {
  const w = ethers.Wallet.createRandom();
  return { address: w.address, privateKey: w.privateKey };
}

/** Native balance in wei (BigInt). */
async function getBalance(chain, address) {
  return provider(chain).getBalance(address);
}

/** Sweep the whole native balance (minus a gas buffer) to `treasury`. */
async function sweep(chain, wallet, treasury) {
  try {
    const p = provider(chain);
    const signer = new ethers.Wallet(wallet.privateKey, p);
    const bal = await p.getBalance(wallet.address);
    if (bal <= 0n) return { ok: false, error: "empty" };

    const fee = await p.getFeeData();
    const eip1559 = fee.maxFeePerGas && fee.maxPriorityFeePerGas;
    const gasPrice = fee.maxFeePerGas || fee.gasPrice;
    if (!gasPrice) return { ok: false, error: "no gas price from RPC" };

    const gasLimit = 21000n;
    const gasCost = gasLimit * gasPrice * 2n; // 2× buffer so it lands under a moving base fee
    const value = bal - gasCost;
    if (value <= 0n) return { ok: false, error: "balance below gas cost" };

    const tx = {
      to: treasury,
      value,
      gasLimit,
      ...(eip1559
        ? { maxFeePerGas: fee.maxFeePerGas, maxPriorityFeePerGas: fee.maxPriorityFeePerGas }
        : { gasPrice }),
    };
    const sent = await signer.sendTransaction(tx);
    await sent.wait(1);
    return { ok: true, txid: sent.hash };
  } catch (e) {
    log.debug(`[evm] sweep ${chain} error: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

module.exports = { family: "evm", generate, getBalance, sweep };
