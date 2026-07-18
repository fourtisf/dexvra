// TON adapter (@ton/*). Native TON, 9 decimals (nanoton). The @ton libs are
// lazy-loaded so their weight/ESM-ish surface never affects boot. This is the
// least battle-tested chain (per the build plan); detection (getBalance) is
// solid, sweep is best-effort (a fresh wallet deploys on its first send).
const { RPC, TON_API_KEY } = require("../../config/constants");
const log = require("../../helpers/logger");

let _libs = null;
function libs() {
  if (_libs) return _libs;
  const core = require("@ton/core");
  const ton = require("@ton/ton");
  const crypto = require("@ton/crypto");
  _libs = { core, ton, crypto };
  return _libs;
}

function makeClient(ton) {
  return new ton.TonClient({ endpoint: RPC.ton, apiKey: TON_API_KEY || undefined });
}

async function generate() {
  const { ton, crypto } = libs();
  const mnemonic = await crypto.mnemonicNew(); // 24 words
  const key = await crypto.mnemonicToPrivateKey(mnemonic);
  const wallet = ton.WalletContractV4.create({ workchain: 0, publicKey: key.publicKey });
  // Non-bounceable (UQ…) so a plain wallet-to-wallet send doesn't bounce.
  const address = wallet.address.toString({ urlSafe: true, bounceable: false, testOnly: false });
  return { address, privateKey: mnemonic.join(" ") }; // store the mnemonic to re-derive
}

async function getBalance(_chain, address) {
  const { ton, core } = libs();
  const bal = await makeClient(ton).getBalance(core.Address.parse(address));
  return BigInt(bal);
}

async function sweep(_chain, wallet, treasury) {
  try {
    const { ton, core, crypto } = libs();
    const client = makeClient(ton);
    const mnemonic = String(wallet.privateKey).trim().split(/\s+/);
    const key = await crypto.mnemonicToPrivateKey(mnemonic);
    const w = ton.WalletContractV4.create({ workchain: 0, publicKey: key.publicKey });
    const balance = await client.getBalance(w.address);
    if (balance <= 0n) return { ok: false, error: "empty" };

    const contract = client.open(w);
    let seqno = 0;
    try {
      seqno = await contract.getSeqno();
    } catch {
      seqno = 0; // not deployed yet → first transfer deploys it
    }
    const internal = ton.internal || core.internal;
    await contract.sendTransfer({
      secretKey: key.secretKey,
      seqno,
      sendMode: 128, // CARRY_ALL_REMAINING_BALANCE — sweep everything
      messages: [
        internal({ to: core.Address.parse(treasury), value: 0n, bounce: false, body: "Dexvra sweep" }),
      ],
    });
    return { ok: true, txid: `seqno:${seqno}` };
  } catch (e) {
    log.debug(`[ton] sweep error: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

module.exports = { family: "ton", generate, getBalance, sweep };
