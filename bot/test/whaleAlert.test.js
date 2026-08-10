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
const whaleCfg = require("../src/services/whaleConfig");

const g = () => ({ chatId: "-100", chain: "solana", address: "So1", sym: "RUSS", name: "The Nietzschean Dog", minBuyUsd: 0 });
const pool = { priceUsd: 0.05, mcap: 15511897, counterSymbol: "SOL", counterAddress: "SoNATIVE" };
const buy = { txHash: "5xTx", buyer: "AFqu1Maaaaaaaaaaaaaaaaaaaaaaajail", usd: 804.72, tokenAmount: 51874.15, spentAmount: 10.7568, spentToken: "SoNATIVE" };

let realHolding;
test.beforeEach(() => {
  realHolding = holdings.holdingOf;
  holdings._reset();
  latch._reset();
});
test.afterEach(async () => {
  holdings.holdingOf = realHolding;
  await whaleCfg.reset(); // no test may leave a bar behind for the next one
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

// ── The admin-set global bar ─────────────────────────────────────────────────

test("the bar ships at $50,000, and nothing overrides it out of the box", async () => {
  // Compared against defaults() rather than the literal, because a live box's
  // .env may legitimately move it — the assertion that must hold everywhere is
  // that get() resolves to whatever is configured, and that the SHIPPED value
  // (no .env, which is how this suite runs) is $50,000.
  const shipped = whaleCfg.defaults().walletUsd;
  if (!process.env.BUYBOT_WHALE_WALLET_USD) assert.strictEqual(shipped, 50000);
  assert.strictEqual(whaleCfg.get().walletUsd, shipped, "no admin override yet");
  // pool.priceUsd is $0.05, so the holding either side of the bar is bar/0.05.
  holdings.holdingOf = async () => (shipped / pool.priceUsd) * 0.999;
  assert.strictEqual(await mon.whaleCheck(g(), buy, pool), null, "a hair under");
  holdings.holdingOf = async () => (shipped / pool.priceUsd) * 1.001;
  assert.ok(await mon.whaleCheck(g(), buy, pool), "a hair over");
});

test("moving the bar in the admin bot lands on the very NEXT buy", async () => {
  // It is read fresh per check precisely because the admin bot is a separate
  // process: a cache here would never see the operator's change at all.
  holdings.holdingOf = async () => 200_000; // $10,000 held
  await whaleCfg.set({ walletUsd: 25000 });
  assert.strictEqual(await mon.whaleCheck(g(), buy, pool), null, "under the operator's $25k bar");
  await whaleCfg.set({ walletUsd: 8000 });
  assert.ok(await mon.whaleCheck(g(), buy, pool), "over their new $8k one");
});

test("a group's own /setwhale still beats the admin bar", async () => {
  // Three layers, most specific first: the group, the admin bot, then .env.
  holdings.holdingOf = async () => 200_000; // $10,000 held
  await whaleCfg.set({ walletUsd: 5000 });
  assert.strictEqual(await mon.whaleCheck({ ...g(), whaleWalletUsd: 25000 }, buy, pool), null, "this group wants a higher bar");
  assert.ok(await mon.whaleCheck(g(), buy, pool), "a group with no preference takes the admin's");
});

test("turning whales off in the admin bot silences every group at once", async () => {
  let calls = 0;
  holdings.holdingOf = async () => {
    calls++;
    return 9e9;
  };
  await whaleCfg.set({ enabled: false });
  assert.strictEqual(await mon.whaleCheck(g(), buy, pool), null);
  assert.strictEqual(await mon.whaleCheck({ ...g(), whaleWalletUsd: 1 }, buy, pool), null, "not even a group that asked for it");
  assert.strictEqual(calls, 0, "and no RPC call is spent finding that out");
});

test("a fat-finger cannot make every buy a whale, or silence them forever", async () => {
  // The rails are the difference between a typo costing a wrong screen and a
  // typo costing every group a pinned alert on every $5 buy.
  assert.strictEqual((await whaleCfg.set({ walletUsd: 5 })).walletUsd, whaleCfg.HARD_MIN_WALLET_USD);
  assert.strictEqual((await whaleCfg.set({ walletUsd: 5e12 })).walletUsd, whaleCfg.HARD_MAX_WALLET_USD);
  assert.strictEqual((await whaleCfg.set({ walletUsd: "not a number" })).walletUsd, whaleCfg.HARD_MAX_WALLET_USD, "kept the last good value");
});

test("reset drops the override and the shipped $50,000 comes back", async () => {
  await whaleCfg.set({ walletUsd: 1234, minBuyUsd: 0, enabled: false });
  const back = await whaleCfg.reset();
  assert.deepStrictEqual(back, whaleCfg.defaults());
  if (!process.env.BUYBOT_WHALE_WALLET_USD) assert.strictEqual(back.walletUsd, 50000);
});

test("the dust floor is admin-set too, and still costs no RPC call", async () => {
  let calls = 0;
  holdings.holdingOf = async () => {
    calls++;
    return 9e9;
  };
  await whaleCfg.set({ minBuyUsd: 2000 });
  assert.strictEqual(await mon.whaleCheck(g(), { ...buy, usd: 900 }, pool), null);
  assert.strictEqual(calls, 0);
  assert.ok(await mon.whaleCheck(g(), { ...buy, usd: 2500 }, pool));
  assert.strictEqual(calls, 1);
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
  assert.match(out, /🐋🐋/, "the row carries the whale icon, not the plain buy one");
  assert.match(out, /Holds: 1,980,000 \$RUSS · \$95,523/);
  assert.match(out, /Position: \+3\.82%/);
  assert.ok(!/wallet balance/i.test(out));
});

test("the card states the bar this wallet CLEARED, never a hardcoded $50,000", async () => {
  // The copy has to survive the operator retuning the bar, and a group setting
  // its own. A card asserting the wrong entry condition is worse than one
  // asserting none.
  holdings.holdingOf = async () => 200_000; // $10,000 held
  const whale = await mon.whaleCheck({ ...g(), whaleWalletUsd: 7500 }, buy, pool);
  assert.strictEqual(whale.threshold, 7500);
  assert.match(mon.renderWhaleAlert(g(), buy, pool, whale).text, /Whale bar: \$7,500/);

  const tplSrc = fss.readFileSync(path.join(__dirname, "..", "src", "templates.js"), "utf8");
  const card = tplSrc.slice(tplSrc.indexOf("group_whale_alert:"), tplSrc.indexOf("group_buy_style:"));
  assert.ok(!/\$50,?000/.test(card), "the default template hardcodes no threshold");
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

test("the whale clip is its OWN — it never borrows the ordinary buy one", () => {
  // The two slots exist so a whale LOOKS different scrolling past. Falling back
  // would give both alerts identical artwork with only the wording changed.
  const bt = require("../src/bannerTemplate");
  const real = bt.mediaOverride;
  try {
    bt.mediaOverride = (k) => (k === "buy" ? { type: "animation", source: "/tmp/buy.gif" } : null);
    assert.strictEqual(mon.buyClip("whale"), null, "no whale clip uploaded → no clip, not the buy one");
    assert.strictEqual(mon.buyClip("buy").source, "/tmp/buy.gif");
    bt.mediaOverride = (k) => ({ type: "animation", source: `/tmp/${k}.gif` });
    assert.strictEqual(mon.buyClip("whale").source, "/tmp/whale.gif");
    assert.strictEqual(mon.buyClip("buy").source, "/tmp/buy.gif");
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
