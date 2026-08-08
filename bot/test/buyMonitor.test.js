// The monitor's own logic: the block cursor, pool fan-in, tiers and rendering.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-mon-"));

const test = require("node:test");
const assert = require("node:assert");
const mon = require("../src/group/buyMonitor");

const buy = (block, tsMinutesAgo, tx) => ({
  txHash: tx || `0x${block}`,
  buyer: "0xb",
  usd: 100,
  tokenAmount: 10,
  blockNumber: block,
  blockTimeMs: Date.now() - tsMinutesAgo * 60000,
});

// ── The cursor ───────────────────────────────────────────────────────────────

test("first sight alerts only the last two minutes, never the 24h backlog", () => {
  // GT hands back a full day of trades. Replaying that into a group is hundreds
  // of alerts for buys that happened yesterday.
  const fresh = mon.selectFresh(null, [buy(1, 360), buy(2, 60), buy(3, 0.5)]);
  assert.strictEqual(fresh.length, 1);
  assert.strictEqual(fresh[0].blockNumber, 3);
});

test("first sight is capped even when everything is recent", () => {
  const many = Array.from({ length: 12 }, (_, i) => buy(i + 1, 0.2, `0x${i}`));
  const fresh = mon.selectFresh(null, many);
  assert.strictEqual(fresh.length, mon.FIRST_SIGHT_MAX);
  assert.strictEqual(fresh.at(-1).blockNumber, 12, "it keeps the NEWEST ones");
});

test("the block comparison is >=, so same-block siblings are not dropped", () => {
  // Several trades share a block. A strict > would silently drop every sibling
  // of the last one posted; the per-tx latch is what prevents actual repeats.
  const fresh = mon.selectFresh({ b: 100, t: 0 }, [buy(99, 1, "a"), buy(100, 1, "b"), buy(100, 1, "c"), buy(101, 1, "d")]);
  assert.deepStrictEqual(fresh.map((f) => f.txHash), ["b", "c", "d"]);
});

test("a cursor seeded on an empty feed judges by time, so no backlog replays later", () => {
  const seededAt = Date.now() - 10 * 60000;
  const fresh = mon.selectFresh({ b: 0, t: seededAt }, [buy(1, 60), buy(2, 1)]);
  assert.deepStrictEqual(fresh.map((f) => f.blockNumber), [2]);
});

// ── Pool fan-in ──────────────────────────────────────────────────────────────

test("groups watching the same token share ONE pool read", () => {
  const entries = mon.groupByPool([
    { chatId: "-1", chain: "bsc", address: "0xCA", pairAddress: "0xPOOL", minBuyUsd: 0 },
    { chatId: "-2", chain: "bsc", address: "0xCA", pairAddress: "0xpool", minBuyUsd: 50 },
    { chatId: "-3", chain: "base", address: "0xCA", pairAddress: "0xPOOL", minBuyUsd: 0 },
  ]);
  assert.strictEqual(entries.length, 2, "same chain+pool folds together; a different chain does not");
  const bsc = entries.find((e) => e.chain === "bsc");
  assert.strictEqual(bsc.groups.length, 2);
});

test("a group with no resolved pool keys on its contract, so it can self-heal", () => {
  const [entry] = mon.groupByPool([{ chatId: "-1", chain: "bsc", address: "0xCA", pairAddress: null, minBuyUsd: 0 }]);
  assert.strictEqual(entry.pool, null);
  assert.strictEqual(entry.key, "bsc:0xca");
});

// ── The cursor must not outrun a failed delivery ─────────────────────────────

test("the cursor holds at the OLDEST undelivered buy, not at the newest seen", async () => {
  // A 429 on an older buy while a newer one succeeds must not advance the
  // cursor past the failure — the retry alertLatch.release() allows would then
  // never be selected again, and the alert is lost silently in a healthy group.
  const latch = require("../src/group/alertLatch");
  const gt = require("../src/group/gtPairs");
  const trades = require("../src/group/gtTrades");
  latch._reset();

  const CA = "0x" + "a".repeat(40);
  // Distinguished by AMOUNT, because the alert renders the dollar figure into
  // the text while the tx hash only ever appears inside a link entity.
  const feed = [
    { txHash: "0xOLD", buyer: "0xb", usd: 111, tokenAmount: 10, blockNumber: 100, blockTimeMs: Date.now() },
    { txHash: "0xNEW", buyer: "0xb", usd: 222, tokenAmount: 10, blockNumber: 105, blockTimeMs: Date.now() },
  ];
  const realFetch = trades.fetchPoolBuys;
  const realPool = gt.fetchPoolCached;
  trades.fetchPoolBuys = async () => feed;
  gt.fetchPoolCached = async () => ({ priceUsd: 1, mcap: 1e6, liquidity: 1e5, change24h: 0, poolAddress: "0xpool" });

  const tg = {
    sendMessage: async (_chat, text) => {
      if (String(text).includes("$111")) throw new Error("429: Too Many Requests"); // the OLDER buy
      return { message_id: 1 };
    },
  };

  try {
    const entry = { key: "bsc:0xpool", chain: "bsc", address: CA, pool: "0xpool", groups: [{ chatId: "-1", chain: "bsc", address: CA, sym: "DEX", minBuyUsd: 0 }] };
    // Seed a cursor so we are past first-sight.
    mon._state.cursors[entry.key] = { b: 90, t: Date.now() };
    await mon._pollTrades(tg, entry);
    assert.strictEqual(mon._state.cursors[entry.key].b, 100, "held at the failed buy's block, not 105");
    assert.strictEqual(latch.isDelivered("-1", "0xNEW"), true);
    assert.strictEqual(latch.isDelivered("-1", "0xOLD"), false);
  } finally {
    trades.fetchPoolBuys = realFetch;
    gt.fetchPoolCached = realPool;
  }
});

// ── Tiers and rendering ──────────────────────────────────────────────────────

test("tier labels fall back field by field, so a half-typed override still renders", () => {
  const tpl = require("../src/templates");
  const real = tpl.t;
  try {
    tpl.t = (k) => (k === "group_buy_tiers" ? "Nibble||" : real(k));
    assert.deepStrictEqual(mon.buyTiers(), ["Nibble", "Whale Buy", "Mega Buy"]);
    tpl.t = () => "";
    assert.deepStrictEqual(mon.buyTiers(), ["New Buy", "Whale Buy", "Mega Buy"]);
  } finally {
    tpl.t = real;
  }
});

test("the verify row is omitted entirely on a chain we have no explorer for", () => {
  // A bare hash rendered as a relative URL is worse than no link at all.
  assert.strictEqual(mon.verifyRow("nosuchchain", { txHash: "0xabc", buyer: "0xdef" }), "");
  const row = mon.verifyRow("bsc", { txHash: "0xabc", buyer: "0xdef" });
  assert.match(row, /bscscan\.com\/tx\/0xabc/);
  assert.match(row, /bscscan\.com\/address\/0xdef/);
});

test("a buy with no buyer address still links the transaction", () => {
  const row = mon.verifyRow("solana", { txHash: "5xyz", buyer: "" });
  assert.match(row, /solscan\.io\/tx\/5xyz/);
  assert.ok(!row.includes("account"));
});

test("the real alert carries the verified links; the estimated one says it cannot", () => {
  const g = { chatId: "-1", chain: "bsc", address: "0x" + "a".repeat(40), sym: "DEX", minBuyUsd: 0 };
  const pool = { priceUsd: 0.0125, mcap: 2.4e6, liquidity: 1.8e5, change24h: 42.3 };
  const real = mon.renderRealAlert(g, { txHash: "0xt", buyer: "0xb", usd: 1234.5, tokenAmount: 98765 }, pool).text;
  assert.match(real, /Whale Buy/);
  assert.match(real, /\$1,235/, "a buy amount is exact to the dollar, not '$1.2K'");
  assert.match(real, /Txn/);

  const est = mon.renderEstimateAlert(g, { usd: 640, count: 3 }, pool).text;
  assert.match(est, /≈/);
  assert.ok(!est.includes("Txn"), "the estimated path has no transaction to link");
  assert.ok(!/[_*]{1,2}Live transaction/.test(est), "no raw markup leaks — the parser only knows **bold**, [links] and `code`");
});
