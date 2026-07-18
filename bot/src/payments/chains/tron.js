// Tron adapter (tronweb v6). Native TRX, 6 decimals (sun).
const TronPkg = require("tronweb");
const TronWeb = TronPkg.TronWeb || TronPkg.default || TronPkg;
const { RPC } = require("../../config/constants");
const log = require("../../helpers/logger");

const FEE_RESERVE = 1500000n; // ~1.5 TRX left to cover bandwidth/energy burn on transfer

function client(privateKey) {
  const opts = { fullHost: RPC.tron };
  if (privateKey) opts.privateKey = privateKey.replace(/^0x/, "");
  return new TronWeb(opts);
}

async function generate() {
  // createAccount() generates locally (no network). Instance method in v5/v6.
  try {
    const acc = await client().createAccount();
    return { address: acc.address.base58, privateKey: acc.privateKey };
  } catch (e) {
    log.debug(`[tron] createAccount fell back: ${e.message}`);
    const acc = TronWeb.utils.accounts.generateAccount();
    return { address: acc.address.base58, privateKey: String(acc.privateKey).replace(/^0x/, "") };
  }
}

async function getBalance(_chain, address) {
  const sun = await client().trx.getBalance(address);
  return BigInt(sun);
}

async function sweep(_chain, wallet, treasury) {
  try {
    const tw = client(wallet.privateKey);
    const bal = BigInt(await tw.trx.getBalance(wallet.address));
    const value = bal - FEE_RESERVE;
    if (value <= 0n) return { ok: false, error: "empty" };
    const res = await tw.trx.sendTransaction(treasury, Number(value));
    const ok = res && (res.result === true || res.txid);
    if (!ok) return { ok: false, error: (res && res.code) || "tx rejected" };
    return { ok: true, txid: res.txid || (res.transaction && res.transaction.txID) };
  } catch (e) {
    log.debug(`[tron] sweep error: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

module.exports = { family: "tron", generate, getBalance, sweep };
