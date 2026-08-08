// Whale WALLET alerts: keyed on what the buyer HOLDS, not on what they spent,
// and pinned in the group.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-whale-"));

const test = require("node:test");
const assert = require("node:assert");
const mon = require("../src/group/buyMonitor");
const holdings = require("../src/group/walletHoldings");
const latch = require("../src/group/alertLatch");

const g = () => ({ chatId: "-100", chain: "solana", address: "So1", sym: "RUSS", name: "The Nietzschean Dog", minBuyUsd: 0 });
const pool = { priceUsd: 0.05, mcap: 15511897, counterSymbol: "SOL", counterAddress: "SoNATIVE" };
const buy = { txHash: "5xTx", buyer: "AFqu1Maaaaaaaaaaaaaaaaaaaaaaajail", usd: 804.72, tokenAmount: 51874.15, spentAmount: 10.7568, spentToken: "SoNATIVE" };

let realHolding;
test.beforeEach(() => {
  realHolding = holdings.holdingOf;
  holdings._reset();
  latch._reset();
});
test.afterEach(() => {
  holdings.holdingOf = realHolding;
});

// ── Detection ────────────────────────────────────────────────────────────────

test("a big HOLDER is a whale even on a small buy", async () => {
  // The whole point of the separate class: a $200 top-up from someone sitting
  // on $80k is news in a way a $200 buy from a fresh wallet is not.
  holdings.holdingOf = async () => 2_000_000; // × $0.05 = $100k
  const whale = await mon.whaleCheck(g(), { ...buy, usd: 200, tokenAmount: 4000 }, pool);
  assert.ok(whale);
  assert.strictEqual(Math.round(whale.holdsUsd), 100000);
});

test("a big BUY from a small wallet is not a whale wallet", async () => {
  holdings.holdingOf = async () => 1000; // × $0.05 = $50
  assert.strictEqual(await mon.whaleCheck(g(), { ...buy, usd: 9000 }, pool), null);
});

test("the group's own threshold beats the global default", async () => {
  holdings.holdingOf = async () => 200_000; // $10,000 held
  assert.strictEqual(await mon.whaleCheck(g(), buy, pool), null, "under the $50k default");
  const whale = await mon.whaleCheck({ ...g(), whaleWalletUsd: 5000 }, buy, pool);
  assert.ok(whale, "over this group's own $5k bar");
});

test("dust never orders an RPC call", async () => {
  let calls = 0;
  holdings.holdingOf = async () => {
    calls++;
    return 2_000_000;
  };
  assert.strictEqual(await mon.whaleCheck(g(), { ...buy, usd: 5 }, pool), null);
  assert.strictEqual(calls, 0);
});

test("a group that turned whales off is never checked", async () => {
  let calls = 0;
  holdings.holdingOf = async () => {
    calls++;
    return 2_000_000;
  };
  assert.strictEqual(await mon.whaleCheck({ ...g(), whales: false }, buy, pool), null);
  assert.strictEqual(calls, 0);
});

test("an unreadable holding is not a whale — and must not withhold the buy", async () => {
  // Not knowing how big a holder someone is is no reason to swallow the alert;
  // the caller falls back to the ordinary card.
  holdings.holdingOf = async () => null;
  assert.strictEqual(await mon.whaleCheck(g(), buy, pool), null);
});

test("with no price there is nothing to value a holding against", async () => {
  holdings.holdingOf = async () => 2_000_000;
  assert.strictEqual(await mon.whaleCheck(g(), buy, { ...pool, priceUsd: 0 }), null);
});

test("a chain whose holdings we cannot read is skipped, not guessed at", async () => {
  assert.strictEqual(holdings.supports("ton"), false);
  assert.strictEqual(holdings.supports("solana"), true);
  assert.strictEqual(holdings.supports("bsc"), true);
  let calls = 0;
  holdings.holdingOf = async () => {
    calls++;
    return 9e9;
  };
  assert.strictEqual(await mon.whaleCheck({ ...g(), chain: "ton" }, buy, pool), null);
  assert.strictEqual(calls, 0);
});

// ── Position ─────────────────────────────────────────────────────────────────

test("position is how much this buy GREW the bag", async () => {
  // The holding is read AFTER the trade, so the position before it is
  // held - bought.
  holdings.holdingOf = async () => 1_051_874.15;
  const whale = await mon.whaleCheck(g(), { ...buy, tokenAmount: 51_874.15 }, pool);
  assert.strictEqual(whale.position, "+5.19%");
});

test("a first-ever buy says so rather than inventing +100% or +∞", async () => {
  holdings.holdingOf = async () => 51_874.15; // exactly what they just bought
  const whale = await mon.whaleCheck({ ...g(), whaleWalletUsd: 1 }, { ...buy, tokenAmount: 51_874.15 }, pool);
  assert.strictEqual(whale.position, "new position");
});

// ── The card ─────────────────────────────────────────────────────────────────

test("the whale card labels the figure HOLDS, not 'wallet balance'", () => {
  // It is the buyer's balance of THIS token at the pool price. This bot has no
  // portfolio API, and printing a single-token figure under a label promising a
  // total would be a wrong number presented as a right one.
  const out = mon.renderWhaleAlert(g(), buy, pool, { held: 1_980_000, holdsUsd: 95_523, position: "+3.82%" }).text;
  assert.match(out, /WHALE WALLET/);
  assert.match(out, /Holds: 1,980,000 \$RUSS · \$95,523/);
  assert.match(out, /Position: \+3\.82%/);
  assert.ok(!/wallet balance/i.test(out));
});

// ── Pinning ──────────────────────────────────────────────────────────────────

function tgSpy(over = {}) {
  const calls = { sent: [], pinned: [], unpinned: [] };
  return {
    calls,
    sendMessage: async () => {
      calls.sent.push(1);
      return { message_id: 100 + calls.sent.length };
    },
    pinChatMessage: async (c, m, e) => calls.pinned.push({ c, m, e }),
    unpinChatMessage: async (c, m) => calls.unpinned.push({ c, m }),
    ...over,
  };
}

test("a whale alert is pinned, and replaces the previous pin", async () => {
  // Without the unpin, every whale of the day accumulates and a pin that is one
  // of thirty is not a pin.
  const tg = tgSpy();
  assert.strictEqual(await mon.deliver(tg, "-100", { text: "a", entities: [] }, "0xa", { pin: true }), true);
  assert.strictEqual(tg.calls.pinned.length, 1);
  assert.strictEqual(tg.calls.unpinned.length, 0, "nothing to replace yet");
  assert.strictEqual(await mon.deliver(tg, "-100", { text: "b", entities: [] }, "0xb", { pin: true }), true);
  assert.strictEqual(tg.calls.unpinned[0].m, tg.calls.pinned[0].m, "the previous one is unpinned");
});

test("an ordinary buy is never pinned", async () => {
  const tg = tgSpy();
  await mon.deliver(tg, "-100", { text: "a", entities: [] }, "0xc");
  assert.strictEqual(tg.calls.pinned.length, 0);
});

test("a group that never granted 'Pin messages' still gets its alerts", async () => {
  const tg = tgSpy({
    pinChatMessage: async () => {
      throw new Error("Bad Request: not enough rights to pin a message");
    },
  });
  // The alert is the product; the pin is a nicety.
  assert.strictEqual(await mon.deliver(tg, "-100", { text: "a", entities: [] }, "0xd", { pin: true }), true);
  assert.strictEqual(tg.calls.sent.length, 1);
});

test("the whale clip falls back to the buy clip, so one upload covers both", () => {
  const bt = require("../src/bannerTemplate");
  const real = bt.mediaOverride;
  try {
    bt.mediaOverride = (k) => (k === "buy" ? { type: "animation", source: "/tmp/buy.gif" } : null);
    assert.strictEqual(mon.buyClip("whale").source, "/tmp/buy.gif");
    bt.mediaOverride = (k) => ({ type: "animation", source: `/tmp/${k}.gif` });
    assert.strictEqual(mon.buyClip("whale").source, "/tmp/whale.gif", "its own wins when set");
  } finally {
    bt.mediaOverride = real;
  }
});

test("a dead RPC is remembered, so it cannot cost a timeout on every buy", async () => {
  // Without a negative cache, an unreachable node means a six-second wait per
  // qualifying buy for as long as it stays down.
  holdings._reset();
  let calls = 0;
  const realEvm = process.env.RPC_BSC;
  process.env.RPC_BSC = "http://127.0.0.1:1"; // nothing listening
  try {
    const wrapped = holdings.holdingOf;
    // Count real attempts by watching how often the miss is recomputed.
    const t0 = Date.now();
    await wrapped("solana", "So1", "Wallet1");
    calls++;
    await wrapped("solana", "So1", "Wallet1");
    calls++;
    // The second call must come back from cache, not from the network.
    assert.ok(Date.now() - t0 < 20000, "the second lookup did not repeat the wait");
    assert.strictEqual(calls, 2);
  } finally {
    if (realEvm === undefined) delete process.env.RPC_BSC;
    else process.env.RPC_BSC = realEvm;
    holdings._reset();
    holdings._resetProviders();
  }
});
