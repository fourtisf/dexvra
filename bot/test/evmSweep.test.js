// EVM sweep audit. Same class of defect as the Solana one that stranded a real
// payment: the adapter guessed what to hold back for gas instead of asking, and
// the guess was double the real cost — so every order left a full extra
// transaction's worth of ETH/BNB in a temp wallet, permanently.
//
// Two further findings pinned here: a hardcoded 21,000 gas silently fails when
// the treasury is a contract (Safe/multisig), and an unknown chain used to fall
// back to the Ethereum RPC — reporting "empty" while the funds sat on the real
// chain.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-evm-"));

const test = require("node:test");
const assert = require("node:assert");

const GWEI = 1000000000n;
const state = {
  balance: 0n,
  feeData: { maxFeePerGas: 20n * GWEI, maxPriorityFeePerGas: 1n * GWEI, gasPrice: 15n * GWEI },
  gasEstimate: 21000n,
  baseFee: 10n * GWEI,
  blockThrows: false,
  estimateThrows: false,
  balanceFailures: 0,
  sendThrows: null,
  waitThrows: null,
  sent: [],
  lastEstimateArgs: null,
};

class JsonRpcProvider {
  constructor(url) {
    this.url = url;
  }
  async getBalance() {
    if (state.balanceFailures > 0) {
      state.balanceFailures--;
      throw new Error("SERVER_ERROR 429");
    }
    return state.balance;
  }
  async getFeeData() {
    return state.feeData;
  }
  async getBlock() {
    if (state.blockThrows) throw new Error("no block");
    return { baseFeePerGas: state.baseFee };
  }
  async estimateGas(tx) {
    state.lastEstimateArgs = tx;
    if (state.estimateThrows) throw new Error("execution reverted");
    return state.gasEstimate;
  }
}
class Wallet {
  constructor(pk, provider) {
    this.privateKey = pk;
    this.provider = provider;
    this.address = "0xTEMPWALLET";
  }
  static createRandom() {
    return { address: "0xNEW", privateKey: "0xKEY" };
  }
  async sendTransaction(tx) {
    if (state.sendThrows) throw new Error(state.sendThrows);
    state.sent.push(tx);
    return {
      hash: "0xHASH",
      async wait() {
        if (state.waitThrows) throw new Error(state.waitThrows);
        return { status: 1 };
      },
    };
  }
}

const ethersPath = require.resolve("ethers");
require.cache[ethersPath] = {
  id: ethersPath,
  filename: ethersPath,
  loaded: true,
  exports: { ethers: { JsonRpcProvider, Wallet } },
};

const evm = require("../src/payments/chains/evm");
const WALLET = { address: "0xTEMPWALLET", privateKey: "0xKEY" };
const TREASURY = "0xTREASURY";
function reset(balance) {
  state.balance = balance;
  state.feeData = { maxFeePerGas: 20n * GWEI, maxPriorityFeePerGas: 1n * GWEI, gasPrice: 15n * GWEI };
  state.gasEstimate = 21000n;
  state.baseFee = 10n * GWEI;
  state.blockThrows = false;
  state.estimateThrows = false;
  state.balanceFailures = 0;
  state.sendThrows = null;
  state.waitThrows = null;
  state.sent = [];
}

test("the fee cap is 1.5× base fee + tip, not the RPC's generous 2×", async () => {
  // Whatever cap is signed, the node RESERVES gasLimit × cap and charges only
  // gasLimit × (base + tip); the refund lands back in the temp wallet as dust
  // worth less than the gas to collect it. So the cap is money left behind on
  // every order, and halving the headroom halves it.
  reset(1000000000000000000n); // 1 ETH, base 10 gwei, tip 1 gwei
  const r = await evm.sweep("ethereum", WALLET, TREASURY);
  assert.ok(r.ok, r.error);
  const cap = 16n * GWEI; // 10 × 1.5 + 1
  assert.strictEqual(state.sent[0].maxFeePerGas, cap, "signed with the tightened cap");
  assert.strictEqual(state.sent[0].value, 1000000000000000000n - 21000n * cap, "…and reserves exactly that");
  // The value must still clear the node's own check: value + gas × cap ≤ balance.
  assert.ok(state.sent[0].value + 21000n * cap <= state.balance);
  // What is actually left: gas × (cap − base − tip) = 21,000 × 5 gwei.
  const leftBehind = 21000n * (cap - 11n * GWEI);
  assert.strictEqual(leftBehind, 105000000000000n, "0.000105 ETH — half of what the RPC quote would strand");
});

test("the cap still covers a base fee that rises while the tx waits", async () => {
  // The protocol caps the rise at 12.5% per block, so 1.5× survives ~3 blocks
  // of worst case. Pinned as a number so nobody tightens it into a stuck sweep.
  reset(1000000000000000000n);
  await evm.sweep("ethereum", WALLET, TREASURY);
  const cap = Number(state.sent[0].maxFeePerGas) / 1e9;
  let base = 10;
  for (let block = 0; block < 3; block++) base *= 1.125;
  assert.ok(cap >= base, `cap ${cap} gwei must outlast 3 blocks of max increase (${base.toFixed(2)} gwei)`);
});

test("if the base fee cannot be read, the RPC's own cap is used — never a guess", async () => {
  reset(1000000000000000000n);
  state.blockThrows = true;
  const r = await evm.sweep("ethereum", WALLET, TREASURY);
  assert.ok(r.ok, r.error);
  assert.strictEqual(state.sent[0].maxFeePerGas, 20n * GWEI, "falls back to getFeeData's quote");
});

test("a legacy-gas chain sweeps clean, with nothing left behind", async () => {
  // No EIP-1559 fields → the price charged IS the price reserved, so the wallet
  // ends at exactly zero.
  reset(500000000000000000n);
  state.feeData = { maxFeePerGas: null, maxPriorityFeePerGas: null, gasPrice: 3n * GWEI };
  const r = await evm.sweep("bsc", WALLET, TREASURY);
  assert.ok(r.ok, r.error);
  const cost = 21000n * 3n * GWEI;
  assert.strictEqual(state.sent[0].value, 500000000000000000n - cost);
  assert.strictEqual(state.sent[0].gasPrice, 3n * GWEI);
  assert.strictEqual(state.sent[0].maxFeePerGas, undefined, "no 1559 fields on a legacy chain");
});

test("a contract treasury gets the gas it needs, not a hardcoded 21000", async () => {
  // Sending to a Safe/multisig runs code on receive. 21,000 is the intrinsic
  // cost of an EOA send — with a contract recipient it reverts out of gas and
  // burns the fee, every single time, delivering nothing.
  reset(1000000000000000000n);
  state.gasEstimate = 55000n;
  const r = await evm.sweep("ethereum", WALLET, TREASURY);
  assert.ok(r.ok, r.error);
  assert.strictEqual(state.sent[0].gasLimit, (55000n * 12n) / 10n, "estimate + 20% headroom");
  assert.strictEqual(state.lastEstimateArgs.to, TREASURY, "estimated against the real recipient");
});

test("an un-estimatable send still goes out at the plain-transfer cost", async () => {
  reset(1000000000000000000n);
  state.estimateThrows = true;
  const r = await evm.sweep("ethereum", WALLET, TREASURY);
  assert.ok(r.ok, r.error);
  assert.strictEqual(state.sent[0].gasLimit, 21000n);
});

test("a balance below its own gas cost is dust, not a failure to retry forever", async () => {
  reset(1000n);
  const r = await evm.sweep("ethereum", WALLET, TREASURY);
  assert.ok(!r.ok);
  assert.strictEqual(r.dust, true, "flagged so sweepRetry stops re-checking it");
  assert.strictEqual(state.sent.length, 0);
});

test("an unknown chain fails loudly instead of sweeping on Ethereum", async () => {
  // The old fallback read the Ethereum balance for an unconfigured chain,
  // reported "empty", and left the real funds untouched and unmentioned.
  reset(1000000000000000000n);
  const r = await evm.sweep("some-new-l2", WALLET, TREASURY);
  assert.ok(!r.ok);
  assert.match(r.error, /no RPC configured/i);
  assert.strictEqual(state.sent.length, 0);
  await assert.rejects(() => evm.getBalance("some-new-l2", "0x1"), /no RPC configured/i);
});

test("a rate-limited RPC is retried before giving up", async () => {
  reset(1000000000000000000n);
  state.balanceFailures = 2;
  const r = await evm.sweep("base", WALLET, TREASURY);
  assert.ok(r.ok, `gave up too early: ${r.error}`);
});

test("a broadcast that does not confirm is never retried, and never claimed", async () => {
  // Retrying past a broadcast reuses the nonce and fights its own pending tx.
  // Claiming success would stop the retry pass from ever re-checking, so it
  // reports not-ok WITH the hash and lets the balance be the judge.
  reset(1000000000000000000n);
  state.waitThrows = "timeout";
  const r = await evm.sweep("ethereum", WALLET, TREASURY);
  assert.ok(!r.ok);
  assert.strictEqual(r.txid, "0xHASH", "the hash is still reported so it can be traced");
  assert.strictEqual(state.sent.length, 1, "exactly one broadcast");
});

test("an empty wallet is a no-op", async () => {
  reset(0n);
  const r = await evm.sweep("ethereum", WALLET, TREASURY);
  assert.ok(!r.ok);
  assert.strictEqual(r.error, "empty");
});
