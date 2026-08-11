// Reading buys straight from the chain, with no indexer in front.
//
// GeckoTerminal refuses this server at the IP level — 429 on the second call
// from a fresh process, tracking one pool, needing 2.4 requests a minute
// against a 25/minute budget. No pacing argues with that. The chain cannot rate
// limit us out of our own product.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-ct-"));

const test = require("node:test");
const assert = require("node:assert");
const { ethers } = require("ethers");
const ct = require("../src/group/chainTrades");

const TOKEN = "0x" + "aa".repeat(20);
const WETH = "0x" + "bb".repeat(20);

const ifaceV2 = new ethers.Interface([
  "event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)",
]);
const ifaceV3 = new ethers.Interface([
  "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)",
]);
const topicAddr = (a) => ethers.zeroPadValue(a, 32);
const coder = ethers.AbiCoder.defaultAbiCoder();

const v2Log = (a0In, a1In, a0Out, a1Out) => ({
  topics: [ethers.id(ct.V2_SWAP), topicAddr(WETH), topicAddr(WETH)],
  data: coder.encode(["uint256", "uint256", "uint256", "uint256"], [a0In, a1In, a0Out, a1Out]),
});
const v3Log = (a0, a1) => ({
  topics: [ethers.id(ct.V3_SWAP), topicAddr(WETH), topicAddr(WETH)],
  data: coder.encode(["int256", "int256", "uint160", "uint128", "int24"], [a0, a1, 0, 0, 0]),
});

test("a V2 buy is read as a buy, either way round the pool sits", () => {
  // token is token0: it leaves the pool as amount0Out, paid for with amount1In.
  const asZero = ct.decodeEvmSwap(ethers, ifaceV2, ifaceV3, v2Log(0n, 10n ** 18n, 500n, 0n), true);
  assert.strictEqual(asZero.tokenOut, 500n);
  assert.strictEqual(asZero.spent, 10n ** 18n);
  // token is token1: the sides swap. A pool is free to be created either way
  // round, and guessing from address ordering costs a reversed alert.
  const asOne = ct.decodeEvmSwap(ethers, ifaceV2, ifaceV3, v2Log(10n ** 18n, 0n, 0n, 500n), false);
  assert.strictEqual(asOne.tokenOut, 500n);
  assert.strictEqual(asOne.spent, 10n ** 18n);
});

test("a V2 SELL is not reported as a buy", () => {
  // The token went INTO the pool. Posting this as a green buy alert is the
  // single most damaging thing a buy bot can do to a project's chat.
  assert.strictEqual(ct.decodeEvmSwap(ethers, ifaceV2, ifaceV3, v2Log(500n, 0n, 0n, 10n ** 18n), true), null);
});

test("V3's SIGNED amounts are read as signed, not as V2's unsigned ones", () => {
  // This is the failure that does not announce itself: reading a V3 log with
  // V2's shape does not throw, it reports the wrong direction. Negative means
  // the amount left the pool — i.e. the trader received it.
  const buy = ct.decodeEvmSwap(ethers, ifaceV3, ifaceV3, v3Log(-500n, 10n ** 18n), true);
  assert.strictEqual(buy.tokenOut, 500n, "our token came out");
  assert.strictEqual(buy.spent, 10n ** 18n, "and the other side went in");
  // Positive on our side = our token went IN = a sell.
  assert.strictEqual(ct.decodeEvmSwap(ethers, ifaceV3, ifaceV3, v3Log(500n, -(10n ** 18n)), true), null);
});

test("a log that is neither shape is skipped, not guessed at", () => {
  const alien = { topics: [ethers.id("Mint(address,uint256,uint256)")], data: "0x" };
  assert.strictEqual(ct.decodeEvmSwap(ethers, ifaceV2, ifaceV3, alien, true), null);
});

test("unreadable resolves to null, which is not the same as no buys", async () => {
  // The whole fallback rests on this distinction: null sends the caller to the
  // indexer, [] tells it the pool is quiet and to advance its cursor.
  assert.strictEqual(await ct.fetchPoolBuys("ethereum", null, TOKEN, {}), null, "no pool");
  assert.strictEqual(await ct.fetchPoolBuys("ethereum", "0xpool", null, {}), null, "no token");
  assert.strictEqual(await ct.fetchPoolBuys("nosuchchain", "0xpool", TOKEN, {}), null, "no reader");
});

test("every chain the buy bot runs on has a reader", () => {
  // A chain with no reader falls back to the indexer that is refusing us, which
  // is the state this whole module exists to get out of.
  for (const c of ["ethereum", "bsc", "base", "solana"]) {
    assert.ok(ct.supports(c), `${c} has no chain reader`);
  }
});

test("the buy bot tries the chain BEFORE the indexer, and falls back", () => {
  const src = fss.readFileSync(path.join(__dirname, "..", "src", "group", "buyMonitor.js"), "utf8");
  const fn = src.slice(src.indexOf("async function pollTrades"));
  const body = fn.slice(0, fn.indexOf("\nasync function"));
  // Matched with a regex, not indexOf: the call is wrapped across lines, and a
  // substring check on "chainTrades.fetchPoolBuys" quietly reports the reader as
  // absent rather than as differently formatted.
  const chainAt = body.search(/chainTrades\s*\.\s*fetchPoolBuys/);
  const gtAt = body.search(/\btrades\s*\.\s*fetchPoolBuys/);
  assert.ok(chainAt > -1, "the chain reader is used");
  assert.ok(gtAt > -1, "and the indexer is still there as a fallback");
  assert.ok(chainAt < gtAt, "chain first");
  assert.match(body, /buys === null && net/, "the indexer runs only when the chain could not be read");
});

test("a Solana cursor carries the signature, not just the slot", () => {
  // getSignaturesForAddress walks BACK until it recognises a signature; there is
  // no "read from slot N". And slots alone cannot stand in for it — several
  // transactions share a slot, so a slot cursor re-reads or skips.
  const src = fss.readFileSync(path.join(__dirname, "..", "src", "group", "buyMonitor.js"), "utf8");
  assert.match(src, /sig: newestSig/, "the cursor stores it");
  assert.match(src, /sinceSig: \(cursorNow && cursorNow\.sig\)/, "and the next read uses it");
});
