// Two checks of the same thing read two different numbers, and it produced the
// loudest bug in the product: "⚠️ A snipe on Ethereum failed: insufficient ETH
// — need ~0.016 incl. gas, have 0.01499 (muted 5 min)", every new Ethereum
// pair, all day, for a wallet that was simply too small to snipe.
//
// watchers.js pre-checked the balance against CFG.gasBufferEth (0.0004) and
// skipped silently if short. buy() then demanded ETH_GAS_BUFFER (0.006). A
// wallet holding 0.01499 cleared the cheap check, entered buy(), and threw —
// so the silent skip never ran and the loud failure always did.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const read = (f) => fs.readFileSync(path.join(__dirname, f), "utf8");
/** Source with comments stripped — the comments above these fixes quote the old
 *  constants on purpose, so counting "how many places read X" has to ignore
 *  them or it counts the explanation as a second reader. */
const code = (f) =>
  read(f)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
let ethersOk = true;
try {
  require("ethers");
} catch {
  ethersOk = false;
}

test("the gas reserve has exactly one definition", () => {
  const core = code("core.js");
  const hits = core.match(/ETH_GAS_BUFFER/g) || [];
  assert.strictEqual(hits.length, 1, "ETH_GAS_BUFFER must be read in one place only");
  assert.match(core, /function gasBufferWei\(chainKey\)/);
  assert.match(core, /module\.exports = \{\n\s*gasBufferWei,/, "and be exported for callers");
});

test("buy() and the snipe pre-check reserve the same amount", () => {
  // The whole defect in one assertion: if these ever read different numbers
  // again, a user gets the failure notice on every pair instead of a skip.
  assert.match(code("core.js"), /const gasBuf = gasBufferWei\(chainKey\);/);
  const w = code("watchers.js");
  // EVM paths only. Solana reserves CFG.solGasBuffer in BOTH its pre-check and
  // its buy, so it never had the divergence and must not be dragged into it.
  const needs = (w.match(/const need = [^;]+;/g) || []).filter((n) => !/solana\./.test(n));
  assert.ok(needs.length >= 2, "both EVM snipe paths pre-check a balance");
  for (const n of needs) {
    assert.match(n, /core\.gasBufferWei\(/, `still reading its own buffer: ${n}`);
    assert.ok(!/CFG\.gasBufferEth/.test(n), `must not reserve the L2 default on L1: ${n}`);
  }
});

test("Solana never had the bug, and keeps its own matching pair", () => {
  // Its pre-check and its buy both read CFG.solGasBuffer. Worth pinning: the
  // fix above would be pointless if the same mistake were sitting on Solana.
  assert.match(code("watchers.js"), /solana\.solToLamports\(core\.CFG\.solGasBuffer\)/);
  assert.match(code("core.js"), /const gasBuf = solana\.solToLamports\(CFG\.solGasBuffer\);/);
});

test("Ethereum reserves far more than the L2 default — that is the point", (t) => {
  if (!ethersOk) return t.skip("ethers not installed in this checkout");
  const { ethers } = require("ethers");
  const core = require("./core");
  const eth = core.gasBufferWei("ethereum");
  const l2 = core.gasBufferWei("base");
  assert.ok(eth > l2, "L1 gas dwarfs L2; the reserve has to follow");
  assert.strictEqual(ethers.formatEther(eth), "0.006");
  // The exact wallet from the incident: 0.01499 ETH, sniping 0.01.
  const bal = ethers.parseEther("0.01499");
  const need = ethers.parseEther("0.01") + eth;
  assert.ok(bal < need, "this wallet cannot afford the snipe…");
  assert.ok(bal > ethers.parseEther("0.01") + l2, "…but it DID clear the old, smaller check");
});

test("a wallet that cannot afford it is told once, not once per pair", () => {
  const w = code("watchers.js");
  assert.match(w, /function _shortfall\(u, chainKey, bal, need\)/);
  // Keyed on the BALANCE, not on a clock: the same balance never speaks twice,
  // and a top-up that is still short earns a fresh notice.
  assert.match(w, /if \(_shortAt\.get\(key\) === bal\) return;/);
  assert.ok(!/_shortAt[\s\S]{0,200}Date\.now\(\)/.test(w), "no timer — the condition is a balance, not a moment");
  assert.match(w, /Snipe skipped/, "and it says what happened");
  assert.match(w, /Top up, or lower the snipe amount/, "…and what to do about it");
});

test("both snipe paths route a shortfall through it", () => {
  const w = code("watchers.js");
  const calls = w.match(/return _shortfall\(u, [^)]+\)/g) || [];
  assert.strictEqual(calls.length, 2, "the launch sniper and the DEX-pair sniper");
});
