// Solana adapter (@solana/web3.js). Native SOL, 9 decimals (lamports).
const {
  Keypair,
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} = require("@solana/web3.js");
const { RPC } = require("../../config/constants");
const log = require("../../helpers/logger");

// A sweep must leave the temp wallet at EXACTLY zero lamports.
//
// Solana deletes a zero-lamport account with no data at the end of the
// transaction, which is fine. But an account left with a NON-zero balance below
// the rent-exempt minimum (890,880 lamports for a 0-data account) makes the
// runtime reject the whole transaction with InsufficientFundsForRent — after
// the transfer instruction itself already succeeded. That is exactly the
// failure we shipped: a flat 10,000-lamport reserve against a 5,000-lamport
// fee left 5,000 lamports of dust, and every SOL sweep failed with
//   "Simulation failed … Logs: [Program 111…1 invoke [1], Program 111…1 success]"
// — a success log under a failed transaction, which reads like a bug in the
// program and is really the rent check firing afterwards.
//
// So: never reserve a guess. Ask the cluster what THIS message costs and send
// balance − fee.
const FALLBACK_FEE = 5000n; // one signature, if getFeeForMessage is unavailable
const ATTEMPTS = 3; // fee/blockhash can move between quote and send

function conn() {
  return new Connection(RPC.solana, "confirmed");
}

async function generate() {
  const kp = Keypair.generate();
  return {
    address: kp.publicKey.toBase58(),
    privateKey: Buffer.from(kp.secretKey).toString("hex"), // full 64-byte secret key, hex
  };
}

async function getBalance(_chain, address) {
  const lamports = await conn().getBalance(new PublicKey(address));
  return BigInt(lamports);
}

/** The fee the cluster will actually charge for this exact message. */
async function feeFor(c, tx) {
  try {
    const r = await c.getFeeForMessage(tx.compileMessage(), "confirmed");
    if (r && typeof r.value === "number" && r.value > 0) return BigInt(r.value);
  } catch (e) {
    log.debug(`[solana] getFeeForMessage: ${e.message}`);
  }
  return FALLBACK_FEE;
}

async function sweep(_chain, wallet, treasury) {
  let last = "unknown";
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const c = conn();
      const kp = Keypair.fromSecretKey(Uint8Array.from(Buffer.from(wallet.privateKey, "hex")));
      const to = new PublicKey(treasury);
      const bal = BigInt(await c.getBalance(kp.publicKey, "confirmed"));
      if (bal === 0n) return { ok: false, error: "empty" };

      const { blockhash } = await c.getLatestBlockhash("confirmed");
      const build = (lamports) => {
        const tx = new Transaction().add(
          SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: to, lamports }),
        );
        tx.recentBlockhash = blockhash;
        tx.feePayer = kp.publicKey;
        return tx;
      };

      // Quote against a same-shaped message (the amount doesn't change the fee).
      const fee = await feeFor(c, build(1));
      const value = bal - fee;
      // Dust: it cannot pay for its own sweep, so it stays. Flagged so the
      // retry pass stops re-checking it every six hours forever.
      if (value <= 0n) return { ok: false, dust: true, error: `balance ${bal} does not cover fee ${fee}` };

      const sig = await sendAndConfirmTransaction(c, build(Number(value)), [kp], {
        commitment: "confirmed",
      });
      log.info(`[solana] swept ${value} lamports (fee ${fee}) → ${treasury} tx=${sig}`);
      return { ok: true, txid: sig, lamports: value };
    } catch (e) {
      last = e.message;
      log.debug(`[solana] sweep attempt ${attempt}/${ATTEMPTS}: ${e.message}`);
    }
  }
  return { ok: false, error: last };
}

module.exports = { family: "solana", generate, getBalance, sweep };
