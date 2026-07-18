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

const FEE_RESERVE = 10000n; // lamports left behind to pay the sweep tx fee

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

async function sweep(_chain, wallet, treasury) {
  try {
    const c = conn();
    const kp = Keypair.fromSecretKey(Uint8Array.from(Buffer.from(wallet.privateKey, "hex")));
    const bal = BigInt(await c.getBalance(kp.publicKey));
    const value = bal - FEE_RESERVE;
    if (value <= 0n) return { ok: false, error: "empty" };

    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: kp.publicKey,
        toPubkey: new PublicKey(treasury),
        lamports: Number(value),
      }),
    );
    const { blockhash } = await c.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.feePayer = kp.publicKey;
    const sig = await sendAndConfirmTransaction(c, tx, [kp], { commitment: "confirmed" });
    return { ok: true, txid: sig };
  } catch (e) {
    log.debug(`[solana] sweep error: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

module.exports = { family: "solana", generate, getBalance, sweep };
