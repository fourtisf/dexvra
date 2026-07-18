const test = require("node:test");
const assert = require("node:assert");
const { isValidAddress, nativeOf, familyOf, CHAIN_IDS } = require("../src/config/chains");

test("per-chain address validation", () => {
  assert.ok(isValidAddress("ethereum", "0x6982508145454Ce325dDbE47a25d4ec3d2311933"));
  assert.ok(!isValidAddress("ethereum", "0x123")); // too short
  assert.ok(isValidAddress("solana", "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"));
  assert.ok(!isValidAddress("solana", "0x6982508145454Ce325dDbE47a25d4ec3d2311933")); // wrong shape
  assert.ok(isValidAddress("tron", "TJbzsH9B6tkZ9VuYJ331DHdhhUi9nRvwy7"));
  assert.ok(isValidAddress("ton", "UQBxxnts7h2SsM123456789012345678901234567890abcd"));
  assert.ok(!isValidAddress("bsc", "not-an-address"));
});

test("native + family mapping", () => {
  assert.strictEqual(nativeOf("solana"), "SOL");
  assert.strictEqual(nativeOf("base"), "ETH");
  assert.strictEqual(nativeOf("bsc"), "BNB");
  assert.strictEqual(nativeOf("tron"), "TRX");
  assert.strictEqual(familyOf("robinhood"), "evm");
  assert.strictEqual(familyOf("ton"), "ton");
});

test("all 7 chains present", () => {
  assert.deepStrictEqual(
    [...CHAIN_IDS].sort(),
    ["base", "bsc", "ethereum", "robinhood", "solana", "ton", "tron"].sort(),
  );
});
