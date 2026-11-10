// A recipient the attacker ground to look like a number.
//
// `wordAddr` calls a word an address only when the top four of its 20 address
// bytes carry something, so a small amount is never read as a recipient. The
// other side of that rule: an address with four leading zero bytes — about
// 2^32 work to grind — reads as a NUMBER. Put in the recipient slot of two
// trades of the attacker's own, it was classified `constant`, replayed verbatim
// into every victim's buy, and the tokens were minted to the attacker; the
// learned shape then carried it to every fresh launch on the same pad.
const test = require("node:test");
const assert = require("node:assert");
const { classifySlots, addrLike, _wordAddr } = require("./curveIface.js");
const { buildFromShape } = require("./curveRoute.js");

const TOKEN = "0x3f8c5ac4c9b9391c99f4796e56228852a6796ddf";
const WALLET = "0xa0000000000000000000000000000000000000a0";
const VANITY = "0x00000000" + "7e57".repeat(8);           // four leading zero bytes
const word = (a) => "0".repeat(24) + a.slice(2).toLowerCase();
const num = (n) => BigInt(n).toString(16).padStart(64, "0");
const S = (size, words) => ({ size: BigInt(size), value: BigInt(size), from: WALLET, args: words.map((w, i) => {
  const addr = _wordAddr(w);
  return { i, word: w, addr, num: BigInt("0x" + w), isToken: addr === TOKEN };
}) });
const leg = (samples) => ({ args: samples[0].args, samples });
const E17 = 10n ** 17n;

test("precondition: the reading rule really does call the ground address a number", () => {
  assert.strictEqual(_wordAddr(word(VANITY)), null);
  assert.strictEqual(addrLike(word(VANITY)), true, "…and the refusal rule does not");
  assert.strictEqual(addrLike(num(300n)), false, "a small constant is still a constant");
  assert.strictEqual(addrLike(num(0)), false, "the zero word is an unused slot, not a stranger");
});

test("a ground address constant across trades of DIFFERENT sizes is refused, never replayed", () => {
  const r = classifySlots(leg([
    S(E17, [word(TOKEN), num(1000n * 10n ** 18n), word(VANITY)]),
    S(3n * E17, [word(TOKEN), num(3000n * 10n ** 18n), word(VANITY)]),
  ]), TOKEN);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.slots[2].role, "unknown");
  assert.ok(!r.slots[2].short, "sizes varied and it did not — that is a verdict, not a shortage");
  assert.match(r.slots[2].why, /stranger's address/);
});

test("trades of the SAME size cannot tell an amount from an address — too little history, never a constant", () => {
  const big = num(500n * 10n ** 18n);   // 500 tokens: above 2^64, exactly like a ground address
  for (const w of [big, word(VANITY)]) {
    const r = classifySlots(leg([S(E17, [word(TOKEN), w]), S(E17, [word(TOKEN), w])]), TOKEN);
    assert.strictEqual(r.ok, false);
    assert.notStrictEqual(r.slots[1].role, "constant", "replaying it is the defect");
    assert.strictEqual(r.short, true, "so the build falls back to the pad's learned shape");
  }
});

// ── who the curve is ────────────────────────────────────────────────────────
const { decodeCurveIface, TRANSFER_TOPIC } = require("./curveIface.js");
const CURVE = "0xc0000000000000000000000000000000000000c0";
const FAKE = "0xf0000000000000000000000000000000000000f0";
const topic = (a) => "0x" + "0".repeat(24) + a.slice(2);
const xfer = (from, to, hash) => ({ topics: [TRANSFER_TOPIC, topic(from), topic(to)], transactionHash: hash });

function chainWith(balances) {
  // The real curve trades twice; the attacker's contract — which pays tokens
  // out of a small balance and ignores its min-out — is called five times.
  const logs = [xfer(CURVE, WALLET, "0xc1"), xfer(CURVE, WALLET, "0xc2")];
  const txs = {
    "0xc1": { to: CURVE, value: E17, data: "0xaabbccdd" + word(TOKEN) + num(1000n) },
    "0xc2": { to: CURVE, value: 2n * E17, data: "0xaabbccdd" + word(TOKEN) + num(2000n) },
  };
  for (let k = 0; k < 5; k++) {
    logs.push(xfer(FAKE, WALLET, "0xf" + k));
    txs["0xf" + k] = { to: FAKE, value: E17, data: "0x99999999" + word(TOKEN) + num(1n) };
  }
  return {
    async getLogs() { return logs; },
    async getTransaction(h) { return txs[h] || null; },
    ...(balances ? { async call({ data }) {
      const who = "0x" + data.slice(-40);
      if (!(who in balances)) throw new Error("unexpected balanceOf");
      return "0x" + balances[who].toString(16).padStart(64, "0");
    } } : {}),
  };
}

test("precondition: by call count alone the attacker's contract is elected", async () => {
  const r = await decodeCurveIface(chainWith(null), TOKEN, { head: 9000 });
  assert.strictEqual(r.curve, FAKE);
});

test("the holder of the unsold supply is the curve, however many calls the other one bought", async () => {
  const r = await decodeCurveIface(chainWith({ [CURVE]: 800_000_000n * 10n ** 18n, [FAKE]: 50_000n * 10n ** 18n }), TOKEN, { head: 9000 });
  assert.strictEqual(r.curve, CURVE);
  assert.strictEqual(r.buy.selector, "0xaabbccdd");
});

test("a tie in balance leaves the count's choice standing", async () => {
  const r = await decodeCurveIface(chainWith({ [CURVE]: 0n, [FAKE]: 0n }), TOKEN, { head: 9000 });
  assert.strictEqual(r.curve, FAKE, "no balance says otherwise, so nothing changes");
});

test("a learned shape stored with a ground address is refused when it is loaded back", () => {
  // curveShapes.json outlives this fix, and a stored file is not a proof.
  const shape = { selector: "0xaabbccdd", native: true, slots: [
    { i: 0, role: "token" }, { i: 1, role: "scales", ratioE18: 10n ** 21n }, { i: 2, role: "constant", value: word(VANITY) },
  ] };
  const r = buildFromShape(shape, { token: TOKEN, wallet: WALLET, valueWei: E17, minOutRaw: 900n * 10n ** 18n });
  assert.strictEqual(r.ok, false);
  assert.match(r.why, /constant address/);
  const fine = { ...shape, slots: [...shape.slots.slice(0, 2), { i: 2, role: "constant", value: num(3000n) }] };
  assert.strictEqual(buildFromShape(fine, { token: TOKEN, wallet: WALLET, valueWei: E17, minOutRaw: 900n * 10n ** 18n }).ok, true,
    "and a small constant (a fee tier, a flag) still builds");
});
