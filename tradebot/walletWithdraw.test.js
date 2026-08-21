// Emptying a wallet, and then removing it.
//
// One report, 2026-08-21, with two screenshots. The first: "❌ this wallet still
// holds 2.15713 SOL on Solana — withdraw it (or export the key) first." on a
// user trying to delete what they thought of as an EVM wallet. The second: the
// withdrawal they were sent off to do, failing —
//
//     ❌ Simulation failed.
//     Message: Transaction simulation failed: Transaction results in an account
//     (0) with insufficient funds for rent.
//
// The two are the same defect seen from both ends: the guard told them to
// withdraw, and withdrawing did not work, so there was no sequence of taps that
// removed that wallet. These tests pin each half.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "dexvra-wdraw-"));
process.env.SKIP_DOTENV = "1";
// Solana is NOT in the shipped default set, and the whole two-keypair half of
// this file only exists when it is on — which it is on the box that reported
// this. chains.js freezes ENABLED at require time, so it has to be set here.
process.env.ENABLED_CHAINS = "ethereum,base,solana";
process.env.WALLET_SECRET = process.env.WALLET_SECRET || "0123456789abcdef0123456789abcdef";

const test = require("node:test");
const assert = require("node:assert");

const read = (f) => fs.readFileSync(path.join(__dirname, f), "utf8");
const code = (f) =>
  read(f)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

let core = null;
try {
  core = require("./core");
} catch {
  /* deps not installed in this checkout */
}

// The numbers the chain actually enforces, so the arithmetic below is checked
// against Solana's rule and not against a restatement of the code's.
const RENT_MIN = 890880n;   // rent-exempt minimum for a 0-byte system account
const FEE = 5000n;          // one signature at the base fee
const SOL = 1000000000n;

// ---------------------------------------------------------------- Solana sweep

test("`max` leaves the wallet at EXACTLY zero, never in the band Solana refuses", { skip: !core }, () => {
  const bal = 2157130000n;   // the 2.15713 SOL from the report
  const p = core.solWithdrawPlan(bal, FEE, RENT_MIN, "max");
  assert.equal(p.error, undefined, p.error);
  // The whole bug in one assertion: what is left after the transfer and its fee.
  assert.equal(bal - p.lamports - FEE, 0n, "a sweep must land on the balance exactly");
  assert.equal(p.lamports, bal - FEE);
  assert.equal(p.isMax, true);
});

test("the old 10,000-lamport reserve is what the chain rejected", { skip: !core }, () => {
  // Not a test of the new code so much as a statement of why the old code could
  // never work: the reserve it kept back sat between zero and the rent floor, so
  // EVERY max withdrawal this bot has ever offered was rejected before it landed.
  const OLD_RESERVE = 10000n;
  const leftBehind = OLD_RESERVE - FEE;
  assert.ok(leftBehind > 0n && leftBehind < RENT_MIN,
    "the old sweep left a rent-paying remainder — arithmetically certain, not unlucky");
});

test("a partial amount that would leave rent dust is refused, with the two amounts that work", { skip: !core }, () => {
  const bal = 2n * SOL;
  // Leaves ~0.0001 SOL — non-zero and far below the rent floor.
  const p = core.solWithdrawPlan(bal, FEE, RENT_MIN, "1.9999");
  assert.ok(p.error, "must not be sent — the simulator would reject it");
  assert.equal(p.lamports, undefined);
  assert.match(p.error, /max/, "names the sweep");
  assert.match(p.error, /0\.00089088/, "names the floor it would break");
  assert.match(p.error, /send at most/, "names the largest amount that keeps the wallet open");
});

test("an amount that leaves a rent-exempt remainder goes straight through", { skip: !core }, () => {
  const bal = 2n * SOL;
  const p = core.solWithdrawPlan(bal, FEE, RENT_MIN, "1.5");
  assert.equal(p.error, undefined, p.error);
  assert.equal(p.lamports, 1500000000n);
  assert.ok(bal - p.lamports - FEE >= RENT_MIN);
  assert.equal(p.isMax, false);
});

test("a wallet holding less than the fee is told so, not sent", { skip: !core }, () => {
  const p = core.solWithdrawPlan(4000n, FEE, RENT_MIN, "max");
  assert.match(p.error, /below the .* network fee/);
});

test("a wallet already below the rent floor can still be swept clean", { skip: !core }, () => {
  // A rent-paying account may shrink, and to zero — so someone who was sent
  // 0.0005 SOL is not locked out of their own dust.
  const bal = 500000n;
  const p = core.solWithdrawPlan(bal, FEE, RENT_MIN, "max");
  assert.equal(p.error, undefined, p.error);
  assert.equal(bal - p.lamports - FEE, 0n);
});

test("over-balance is refused with the number that fits", { skip: !core }, () => {
  const p = core.solWithdrawPlan(1n * SOL, FEE, RENT_MIN, "1");
  assert.match(p.error, /send at most 0\.999995 SOL/);
});

test("the fee and the rent floor are READ from the chain, never assumed", { skip: !core }, () => {
  const c = code("core.js");
  assert.match(c, /solana\.rentExemptMin\(conn\)/, "the floor is a chain read");
  assert.match(c, /solana\.transferFee\(conn, kp\.publicKey, to, bal\)/, "the fee is measured for this transfer");
  assert.doesNotMatch(c, /const feeReserve = 10000n/, "the reserve that caused this is gone");
  const s = code("solana.js");
  assert.match(s, /getMinimumBalanceForRentExemption\(0\)/);
  assert.match(s, /getFeeForMessage\(tx\.compileMessage\(\)/,
    "measured against the message that gets signed, not a per-signature constant");
});

// ---------------------------------------------------------------- EVM sweep

test("the gas reserved is the gas SIGNED — one fee object, both jobs", { skip: !core }, () => {
  const c = code("core.js");
  const body = c.slice(c.indexOf("async function withdraw(chatId"), c.indexOf("async function withdrawToken"));
  // The defect: the reserve read getFeeData().gasPrice while rawSend signed
  // gasOverrides().maxFeePerGas — different numbers, and on an L2 the reserve
  // came out several times too small.
  assert.match(body, /const fee = await gasOverrides\(chainKey\)/);
  assert.match(body, /perGas = fee\.maxFeePerGas \|\| fee\.gasPrice/);
  assert.match(body, /rawSend\([^)]*\{ fee \}\)/, "the same object is handed to the signer");
  assert.doesNotMatch(body, /let gp = gas\.gasPrice/, "the old mismatched read is gone");
});

test("an OP-stack chain's L1 data fee is part of the reserve", { skip: !core }, () => {
  const c = code("core.js");
  // op-geth's balance check is value + gas×price + l1Cost. A sweep that ignores
  // the third term is short by exactly it.
  assert.match(c, /_l1DataFee\(chainKey, \{/);
  assert.match(c, /getL1Fee\(bytes\) view returns \(uint256\)/);
  assert.match(c, /0x420000000000000000000000000000000000000F/);
  // Discovered, not listed: a chain without the predeploy answers 0 after one
  // getCode, so adding a chain needs no edit here.
  assert.match(c, /getCode\(OP_GAS_ORACLE\)/);
});

test("a max EVM withdrawal keeps back the whole reserve and no more", { skip: !core }, () => {
  const gasCost = 3000000000000000n;   // 0.003 ETH
  const bal = 1000000000000000000n;    // 1 ETH
  const p = core.evmWithdrawPlan(bal, gasCost, "max", "ETH");
  assert.equal(p.error, undefined, p.error);
  assert.equal(p.value, bal - gasCost);
  assert.equal(p.isMax, true);
});

test("an EVM balance under the gas cost says so instead of 'nothing to withdraw'", { skip: !core }, () => {
  const p = core.evmWithdrawPlan(1000000000000000n, 3000000000000000n, "max", "ETH");
  assert.match(p.error, /does not cover/);
  assert.match(p.error, /ETH/);
});

test("an over-balance EVM amount names the largest that fits", { skip: !core }, () => {
  const p = core.evmWithdrawPlan(1000000000000000000n, 3000000000000000n, "1", "ETH");
  assert.match(p.error, /send at most 0\.997000 ETH/);
});

// ---------------------------------------------------------------- removal

test("removeWallet surveys every chain, and the guard reads the same survey as the screen", { skip: !core }, () => {
  const c = code("core.js");
  assert.match(c, /async function walletFunds\(chatId, walletId\)/);
  // Concurrent: the old guard was a serial for-loop, so a throttled RPC cost one
  // full timeout per chain before the screen could say anything.
  assert.match(c, /return Promise\.all\(chains\.enabledChains\(\)\.map\(async \(ch\) => \{/);
  const rm = c.slice(c.indexOf("async function removeWallet(chatId"), c.indexOf("function listWallets"));
  assert.match(rm, /const funds = await walletFunds\(chatId, walletId\)/,
    "the guard must not grow a second idea of what the wallet holds");
  assert.match(rm, /e\.holdings = holding/, "the refusal carries the survey, so the screen can act on it");
  assert.match(rm, /if \(!\(opts && opts\.force\)\)/);
});

test("`ok:false` is not a zero — an unreadable chain never blocks removal", { skip: !core }, () => {
  const c = code("core.js");
  const wf = c.slice(c.indexOf("async function walletFunds(chatId"), c.indexOf("async function removeWallet(chatId"));
  assert.match(wf, /holds: ok && bal > dust/, "we could not look ≠ it is empty");
});

test("the removal screen offers a withdraw per holding chain, and explains the pair of keys", { skip: !core }, () => {
  const tg = code("telegram.js");
  const scr = tg.slice(tg.indexOf("async function removeWalletScreen"), tg.indexOf("function unroutableCard"));
  assert.match(scr, /await core\.walletFunds\(chatId, walletId\)/);
  // The hands the old refusal did not have.
  assert.match(scr, /wdw:\$\{walletId\}:\$\{f\.chain\}/, "one withdraw button per chain that holds something");
  assert.match(scr, /two keypairs/, "the question the report actually asked");
  assert.match(scr, /Solana address/, "both addresses, because both go");
  assert.match(scr, /rmwf:/, "the informed override");
  assert.match(scr, /Couldn't read/, "an unreadable chain says so rather than rendering as zero");
});

test("a blocked removal lands back on the screen with the buttons, never on a bare ❌", { skip: !core }, () => {
  const tg = code("telegram.js");
  const h = tg.slice(tg.indexOf("if (k === 'rmwok')"));
  const body = h.slice(0, h.indexOf("\n  if (k === 'rmwf')"));
  assert.match(body, /if \(e && e\.holdings\)/);
  assert.match(body, /removeWalletScreen\(chatId, ca\)/);
});

test("removing a funded wallet hands over the keys FIRST, and only then removes", { skip: !core }, () => {
  const tg = code("telegram.js");
  const h = tg.slice(tg.indexOf("if (k === 'rmwfy')"));
  const body = h.slice(0, h.indexOf("\n  if (k === 'wdw')"));
  const keys = body.indexOf("exportKeyMsg(chatId, ca)");
  const gone = body.indexOf("core.removeWallet(chatId, ca, { force: true })");
  assert.ok(keys > -1 && gone > -1, "both steps present");
  assert.ok(keys < gone, "the other order loses the keys if the send fails");
  assert.match(body, /the wallet was <b>not<\/b> removed/, "a failed export must not be followed by a removal");
  // `send` resolves with Telegram's answer and does not throw on an error_code,
  // so a try/catch alone would have removed the wallet after silently failing to
  // deliver the only copy of its keys.
  assert.match(body, /delivered = !!\(r && r\.ok\)/);
  assert.ok(body.indexOf("if (!delivered)") < gone, "the gate is BEFORE the removal");
});

test("export hands over BOTH keys — the row is two keypairs and it is about to go", { skip: !core }, () => {
  const tg = code("telegram.js");
  const fn = tg.slice(tg.indexOf("function exportKeyMsg(chatId, walletId)"), tg.indexOf("const _monitors = new Map()"));
  assert.match(fn, /EVM private key/);
  assert.match(fn, /Solana private key/);
  // The trap: it used to export whichever half matched the ACTIVE chain and
  // print a note telling the user to switch chain and come back — advice with a
  // destructive tap waiting on the other side of it.
  assert.doesNotMatch(fn, /switch 🌐 to/, "a note is not a safeguard before a delete");
  assert.doesNotMatch(fn, /if \(core\.chains\.isSvm\(ck\)\)/, "no longer branches on the active chain");
  assert.match(fn, /nothing was exported/, "a failed read must not pass for 'this wallet had one key'");
});

// ---------------------------------------------------------------- per-wallet withdraw

test("a withdrawal spends the wallet and chain it was OPENED on, not the active ones", { skip: !core }, () => {
  const tg = code("telegram.js");
  // Each step carries them forward. Re-deriving the chain at every step is how a
  // Solana withdrawal opened from an EVM screen bounced as an invalid address.
  assert.match(tg, /if \(p\.action === 'wd_addr'\) \{ const wch = \(p\.chain && core\.chainOf\(p\.chain\)\) \|\| activeChain\(chatId\)/);
  assert.match(tg, /setPending\(chatId, \{ action: 'wd_amt', to: t, chain: wch\.key, walletId: p\.walletId \}\)/);
  assert.match(tg, /setPending\(chatId, \{ action: 'wd_confirm', to: p\.to, amt: t, chain: ch\.key, walletId: p\.walletId \}\)/);
  assert.match(tg, /core\.withdraw\(chatId, pp\.to, pp\.amt, pp\.chain, pp\.walletId\)/,
    "the confirmed wallet is the wallet spent");
});

test("every entry into the withdraw flow names a chain, and 📤 is reachable per wallet", { skip: !core }, () => {
  const tg = code("telegram.js");
  assert.match(tg, /if \(k === 'wdw'\)/, "per-wallet, per-chain entry");
  assert.match(tg, /if \(data === 'wd'\) \{ const wch = activeChain\(chatId\); setPending\(chatId, \{ action: 'wd_addr', chain: wch\.key \}\)/);
  assert.match(tg, /if \(text === '\/withdraw'\) \{ const wch = activeChain\(chatId\)/);
  // The per-wallet screen: emptying wallet 9 used to mean switching to it first,
  // with the switch on the same screen as the button that needed it.
  assert.match(tg, /btn\(`📤 Withdraw \$\{ch\.native\}`\.slice\(0, 24\), `wdw:\$\{w\.id\}:\$\{ch\.key\}`\)/);
});

test("a swept wallet's receipt says it is empty — that is the errand, not a footnote", { skip: !core }, () => {
  const c = code("core.js");
  assert.match(c, /swept: plan\.isMax/, "both chains report it");
  assert.equal((c.match(/swept: plan\.isMax/g) || []).length, 2);
  const tg = code("telegram.js");
  assert.match(tg, /r\.swept \?/);
});

test("the confirm screen names the wallet whenever there is more than one", { skip: !core }, () => {
  const tg = code("telegram.js");
  assert.match(tg, /function wdWalletLine\(chatId, walletId\)/);
  assert.match(tg, /if \(list\.length < 2\) return ''/, "noise on a single-wallet account");
  const h = tg.slice(tg.indexOf("if (p.action === 'wd_amt')"));
  assert.match(h.slice(0, 900), /wdWalletLine\(chatId, p\.walletId\)/);
});

test("'max' is described as emptying the wallet, because that is now what it does", { skip: !core }, () => {
  const tg = code("telegram.js");
  // The old prompt promised "a little is kept back for network fees" — which was
  // both untrue of the new sweep and the exact thing that used to break it.
  assert.doesNotMatch(tg, /a little is kept back for network fees/);
  assert.match(tg, /to empty the wallet \(the network fee comes out of it\)/);
});

// ---------------------------------------------------------------- driven

// A source scan sees the calls and reads as fine; these run the renderers. Two
// wallets, because removal keeps the last one.
let tg = null;
try { tg = require("./telegram"); } catch { /* deps not installed */ }

const CHAT = "770001";
function twoWallets() {
  core.ensureUser(CHAT);
  const u = core.getUser(CHAT);
  if (u.wallets.length < 2) core.addWallet(CHAT);
  return u.wallets[1].id;
}
// The survey the screen reads. Stubbed rather than measured: what is under test
// is what the screen DOES with a holding, not whether an RPC answers.
function stubFunds(rows) {
  const real = core.walletFunds;
  core.walletFunds = async () => rows;
  return () => { core.walletFunds = real; };
}
const SOL_HELD = (addr) => ({ chain: "solana", name: "Solana", emoji: "🟣", native: "SOL", svm: true, address: addr, ok: true, bal: 2157130000n, holds: true, human: "2.15713" });
const ETH_CLEAN = (addr) => ({ chain: "ethereum", name: "Ethereum", emoji: "🔷", native: "ETH", svm: false, address: addr, ok: true, bal: 0n, holds: false, human: "0.00000" });
const BASE_UNREAD = (addr) => ({ chain: "base", name: "Base", emoji: "🔵", native: "ETH", svm: false, address: addr, ok: false, bal: 0n, holds: false, human: "0.00000" });

test("DRIVEN: the blocked screen answers the question the old refusal provoked", { skip: !core || !tg }, async () => {
  const wid = twoWallets();
  const u = core.getUser(CHAT);
  const evm = u.wallets[1].address;
  const sol = core.walletAddress(u.wallets[1], "solana");
  const undo = stubFunds([ETH_CLEAN(evm), BASE_UNREAD(evm), SOL_HELD(sol)]);
  try {
    const s = await tg._test.removeWalletScreen(CHAT, wid);
    // Both addresses, because both keys go.
    assert.ok(s.text.includes(evm), "the EVM address");
    assert.ok(s.text.includes(sol), "the Solana address");
    assert.match(s.text, /2\.15713 SOL/, "the amount that is blocking it");
    assert.match(s.text, /two keypairs/);
    assert.match(s.text, /Couldn't read Ethereum|Couldn't read Base/, "the unread chain is named");
    const flat = s.kb.inline_keyboard.flat();
    // The hands. One button per chain that holds something, and none for the
    // chains that do not.
    const wd = flat.filter((b) => String(b.callback_data).startsWith("wdw:"));
    assert.equal(wd.length, 1);
    assert.equal(wd[0].callback_data, `wdw:${wid}:solana`);
    assert.match(wd[0].text, /SOL/);
    assert.ok(flat.some((b) => b.callback_data === "rmwf:" + wid), "the informed override");
    assert.ok(!flat.some((b) => b.callback_data === "rmwok:" + wid), "no one-tap remove while it holds money");
    assert.ok(flat.some((b) => b.callback_data === "expw:" + wid));
  } finally { undo(); }
});

test("DRIVEN: an empty wallet gets the one-tap remove back", { skip: !core || !tg }, async () => {
  const wid = twoWallets();
  const evm = core.getUser(CHAT).wallets[1].address;
  const undo = stubFunds([ETH_CLEAN(evm), { ...SOL_HELD(evm), bal: 0n, holds: false, human: "0.00000" }]);
  try {
    const s = await tg._test.removeWalletScreen(CHAT, wid);
    const flat = s.kb.inline_keyboard.flat();
    assert.ok(flat.some((b) => b.callback_data === "rmwok:" + wid));
    assert.ok(!flat.some((b) => String(b.callback_data).startsWith("wdw:")), "nothing to withdraw, no button");
    assert.ok(!flat.some((b) => b.callback_data === "rmwf:" + wid), "no override where there is nothing to override");
    assert.match(s.text, /empty of native/);
  } finally { undo(); }
});

test("DRIVEN: export hands over both keys, and they are the wallet's own", { skip: !core || !tg }, () => {
  const wid = twoWallets();
  const u = core.getUser(CHAT);
  const out = tg._test.exportKeyMsg(CHAT, wid);
  assert.ok(out.includes(u.wallets[1].address), "the EVM address");
  assert.ok(out.includes(core.walletAddress(u.wallets[1], "solana")), "the Solana address");
  assert.ok(out.includes(core.exportKey(CHAT, wid)), "the EVM key");
  assert.ok(out.includes(core.exportKey(CHAT, wid, "solana")), "the Solana key");
  assert.match(out, /save both/);
});

test("DRIVEN: the withdraw flow carries the wallet and chain it was opened on", { skip: !core || !tg }, async () => {
  const wid = twoWallets();
  const sent = [];
  const realFetch = global.fetch;
  global.fetch = async (url, opt) => {
    try { const b = JSON.parse(opt.body); if (/sendMessage/.test(String(url))) sent.push(b.text); } catch (_) {}
    return { json: async () => ({ ok: true, result: { message_id: sent.length + 1 } }) };
  };
  const realWd = core.withdraw;
  let spent = null;
  core.withdraw = async (cid, to, amt, chain, walletId) => { spent = { to, amt, chain, walletId }; return { hash: "sig", sentEth: 2.157125, native: "SOL", swept: true }; };
  try {
    // Step 1 opened on a NAMED wallet + Solana, while the ACTIVE chain is not
    // Solana — the case that used to bounce as "not a valid address".
    core.setChain(CHAT, "ethereum");
    const DEST = "E9MRKqAUH5RA4dqFUkcW3Hair1GxeWtUVQzdXgWw1RPV";
    await tg._test.resolvePending(CHAT, { action: "wd_addr", chain: "solana", walletId: wid }, DEST, null);
    await tg._test.resolvePending(CHAT, { action: "wd_amt", chain: "solana", walletId: wid, to: DEST }, "max", null);
    const confirm = sent[sent.length - 1];
    assert.match(confirm, /Solana/, "confirmed against the chain it was opened on, not the active one");
    assert.match(confirm, /every SOL in this wallet/, "'max' is described as what it does");
    assert.match(confirm, /Wallet 2/, "and names which wallet it will empty");
    // A Solana sweep lands on zero, and a wallet at zero cannot pay the fee to
    // move an SPL bag — said before the tap, not discovered after it.
    assert.match(confirm, /can't pay the fee to move them/);
    // …and the confirmation actually spends that wallet on that chain.
    await tg._test.onCallback({ id: "1", data: "wdok", message: { message_id: 1, chat: { id: CHAT } }, from: { id: CHAT } });
    assert.deepEqual(spent, { to: DEST, amt: "max", chain: "solana", walletId: wid });
    assert.match(sent[sent.length - 1], /balance is now zero/, "a sweep says the wallet is empty — that is the errand");
  } finally { core.withdraw = realWd; global.fetch = realFetch; }
});
