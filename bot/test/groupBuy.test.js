// Group buy bot — the volume-diff estimate (incl. the source-switch guard),
// address→chain candidate probing, emoji scaling, and config store.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-grp-"));

const test = require("node:test");
const assert = require("node:assert");
const mon = require("../src/group/buyMonitor");
const setup = require("../src/group/setup");
const cfg = require("../src/group/config");

test("estimateBuys: first observation and no-new-buys return null", () => {
  assert.strictEqual(mon.estimateBuys(null, { buys24h: 10, volume24h: 1000 }), null);
  const prev = { buys24h: 10, sells24h: 5, volume24h: 1000, source: "gt" };
  assert.strictEqual(mon.estimateBuys(prev, { buys24h: 10, sells24h: 5, volume24h: 1000, source: "gt" }), null);
});

test("estimateBuys: apportions the volume delta by buy share", () => {
  const prev = { buys24h: 10, sells24h: 10, volume24h: 1000, source: "gt" };
  // +3 buys, +1 sell, +$800 volume → buyShare 3/4 → $600 over 3 buys
  const est = mon.estimateBuys(prev, { buys24h: 13, sells24h: 11, volume24h: 1800, source: "gt" });
  assert.ok(est);
  assert.strictEqual(est.count, 3);
  assert.strictEqual(est.usd, 600);
  assert.strictEqual(est.avgUsd, 200);
});

test("estimateBuys: a GT↔DexScreener source switch never fabricates a buy", () => {
  const prev = { buys24h: 10, sells24h: 5, volume24h: 1000, source: "ds" };
  // counts/volume look higher only because GT reports a different 24h window
  const cur = { buys24h: 40, sells24h: 20, volume24h: 9000, source: "gt" };
  assert.strictEqual(mon.estimateBuys(prev, cur), null);
});

test("estimateBuys: a 24h-window rollover (counters drop) returns null", () => {
  const prev = { buys24h: 100, sells24h: 50, volume24h: 50000, source: "gt" };
  const cur = { buys24h: 98, sells24h: 49, volume24h: 48000, source: "gt" };
  assert.strictEqual(mon.estimateBuys(prev, cur), null);
});

test("buyEmojiRow scales with size and is capped", () => {
  assert.strictEqual(mon.buyEmojiRow(25).length / 2, 1); // 🟢 is a surrogate pair (length 2)
  assert.ok(mon.buyEmojiRow(1000000).length / 2 <= 60); // capped
  assert.ok(mon.buyEmojiRow(0).length >= 2); // at least one
});

test("candidateChains guesses by address shape", () => {
  assert.deepStrictEqual(setup.candidateChains("0x" + "a".repeat(40)).slice(0, 2), ["ethereum", "bsc"]);
  assert.deepStrictEqual(setup.candidateChains("T" + "1".repeat(33)), ["tron"]);
  assert.deepStrictEqual(setup.candidateChains("EQabcdef"), ["ton"]);
  assert.deepStrictEqual(setup.candidateChains("0xabc::coin::COIN"), ["sui"]);
  assert.deepStrictEqual(setup.candidateChains("So1anaBase58Mint"), ["solana"]);
});

test("config store: upsert, active filter, remove", async () => {
  await cfg.upsert(123, { chain: "solana", address: "AAA", pairAddress: "P", on: true });
  assert.strictEqual(cfg.get(123).address, "AAA");
  assert.strictEqual(cfg.active().length, 1);
  // off → not active
  await cfg.upsert(123, { on: false });
  assert.strictEqual(cfg.active().length, 0);
  // on but no token → not active
  await cfg.upsert(456, { on: true });
  assert.strictEqual(cfg.active().length, 0);
  await cfg.remove(123);
  assert.strictEqual(cfg.get(123), null);
});
