// trendingBoard config + trendingPoster board rendering (tier-priority + format).
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-tb-"));

const test = require("node:test");
const assert = require("node:assert");

// Mock live market data BEFORE trendingPoster destructures fetchMarket.
const md = require("../src/marketdata");
const MOCK = {
  wif: { mcap: 1_793_783, change24h: 47.2 },
  bonk: { mcap: 1_291_521_621_468, change24h: 12.4 },
  alive: { mcap: 28_607, change24h: 39.9 },
  floki: { mcap: 3_925_360, change24h: 133 },
};
md.fetchMarket = async (_chain, addr) =>
  MOCK[addr] ? { priceUsd: 1, ...MOCK[addr] } : { priceUsd: 1, mcap: 1_000_000, change24h: 1.5 };
const api = require("../src/api/dexvra");

const tb = require("../src/services/trendingBoard");
const poster = require("../src/services/trendingPoster");

test("board: defaults, override, reset, rank fallback", async () => {
  assert.deepStrictEqual(tb.rankEmojis().slice(0, 3), ["🥇", "🥈", "🥉"]);
  assert.strictEqual(tb.chainLogo("solana"), "🟣");
  assert.strictEqual(tb.rankBadge(9), "9.", "ranks past 8 fall back to N.");
  await tb.setRankEmoji(1, "🔥");
  await tb.setChainLogo("solana", "◎");
  assert.strictEqual(tb.rankBadge(1), "🔥");
  assert.strictEqual(tb.chainLogo("solana"), "◎");
  await tb.reset();
  assert.strictEqual(tb.rankBadge(1), "🥇");
  assert.strictEqual(tb.chainLogo("solana"), "🟣");
});

test("board: rank must be 1–8", async () => {
  await assert.rejects(() => tb.setRankEmoji(9, "x"));
  await assert.rejects(() => tb.setRankEmoji(0, "x"));
});

test("poster: tier priority beats performance, fourtis format", async () => {
  api.getListings = async () => [
    { status: "approved", trendingRank: 1, trendExp: 0, chain: "solana", address: "bonk", sym: "BONK", tier: "BRONZE" },
    { status: "approved", trendingRank: 1, trendExp: 0, chain: "solana", address: "wif", sym: "WIF", tier: "DIAMOND" },
    { status: "approved", trendingRank: 1, trendExp: 0, chain: "solana", address: "alive", sym: "ALIVE", tier: "XPRESS" },
  ];
  const text = await poster.buildText();
  assert.ok(text.includes("🟣 <b>SOLANA - Trending</b>"), "chain header with logo");
  // Diamond (WIF) must rank above Bronze (BONK) and Xpress (ALIVE) despite lower mcap.
  const iWif = text.indexOf("$WIF");
  const iBonk = text.indexOf("$BONK");
  const iAlive = text.indexOf("$ALIVE");
  assert.ok(iWif < iBonk && iBonk < iAlive, `tier order wrong: WIF@${iWif} BONK@${iBonk} ALIVE@${iAlive}`);
  assert.ok(text.includes("🥇 +47.20% |"), "rank badge + signed % present");
  assert.ok(text.includes("1,793,783$"), "comma market cap present");
});

test("poster: ticker links to Telegram, market cap links to the Dexvra CA page", async () => {
  api.getListings = async () => [
    { status: "approved", trendingRank: 1, trendExp: 0, chain: "robinhood", address: "0xRH", sym: "RHT", tier: "GOLD", telegram: "@rht_official" },
    { status: "approved", trendingRank: 1, trendExp: 0, chain: "base", address: "0xNoTg", sym: "NOTG", tier: "SILVER" },
  ];
  const text = await poster.buildText();
  // Robinhood chain renders (it's in CHAIN_ORDER).
  assert.ok(text.includes("ROBINHOOD - Trending"), "robinhood chain present");
  // $ticker → the token's Telegram.
  assert.ok(text.includes('<a href="https://t.me/rht_official">$RHT</a>'), "ticker links to Telegram");
  // market cap → the Dexvra token page (its CA).
  assert.ok(text.includes('<a href="https://dexvra.io/token/robinhood/0xRH">'), "mcap links to Dexvra CA page");
  // No Telegram → ticker falls back to the Dexvra page (never a dead link).
  assert.ok(text.includes('<a href="https://dexvra.io/token/base/0xNoTg">$NOTG</a>'), "ticker falls back to Dexvra");
});

test("poster: no featured tokens → null (nothing to post)", async () => {
  api.getListings = async () => [{ status: "approved", trendingRank: null, chain: "solana", address: "x", sym: "X" }];
  assert.strictEqual(await poster.buildText(), null);
});
