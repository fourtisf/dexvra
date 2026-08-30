// THE CHANNEL BOARD MIRRORS THE WEBSITE — with booked slots pinned.
//
// "di website sudah ada trending, nah itu aja yang diambil, harus sinkron" —
// a project opens dexvra.io and @dexvratrending side by side and sees two
// different sets of tokens, because the two ranked from different places. And
// a chain with fewer booked slots than the operator's minimum published a short
// board for six rounds running.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-sync-"));

const test = require("node:test");
const assert = require("node:assert");
const api = require("../src/api/dexvra");
const market = require("../src/marketdata");
const poster = require("../src/services/trendingPoster");
const autoTrend = require("../src/services/autoTrend");

const listing = (over) => ({
  status: "approved", chain: "solana", sym: "X", trendingRank: null, ...over,
});
const siteRow = (symbol, change, over) => ({
  chain: "solana", address: `site${symbol}`, symbol, name: symbol,
  change24h: change, mcap: 5e6, booked: false, ...over,
});

async function render({ listings, chains, live = true, perChainMin = 5 }) {
  const realGet = api.getListings;
  const realRank = api.boardRank;
  const realFetch = market.fetchMarket;
  api.getListings = async () => listings;
  api.boardRank = async () => ({ frame: "24h", live, chains });
  market.fetchMarket = async (_c, a) => ({ change24h: 1, mcap: 1e6, priceUsd: 1, poolAddress: `p${a}` });
  await autoTrend.set({ perChainMin, perChainMax: perChainMin });
  try {
    poster._resetState();
    return await poster.buildText();
  } finally {
    api.getListings = realGet;
    api.boardRank = realRank;
    market.fetchMarket = realFetch;
  }
}

test("a chain short of the minimum is topped up from the website's order", async () => {
  // Two booked slots against a minimum of five: the board used to publish two
  // rows and the operator counted them and asked, six times.
  const now = Date.now();
  const text = await render({
    listings: [
      listing({ address: "paid1", sym: "PAID1", trendingRank: 1, trendStart: now, trendExp: now + 3600_000, tier: "DIAMOND" }),
      listing({ address: "paid2", sym: "PAID2", trendingRank: 1, trendStart: now, trendExp: now + 3600_000, tier: "GOLD" }),
    ],
    chains: { solana: [siteRow("AAA", 90), siteRow("BBB", 50), siteRow("CCC", 10)] },
  });
  for (const s of ["PAID1", "PAID2", "AAA", "BBB", "CCC"]) {
    assert.ok(text.includes(`$${s}`), `${s} missing from the board:\n${text}`);
  }
});

test("⚠️ a PAID row is never displaced by the website's ranking", async () => {
  // The whole reason this is a top-up and not a mirror. Somebody bought that
  // row; a board that dropped it because the token was down today is a refund
  // conversation, and every other ranking surface in this repo demotes rather
  // than hides for exactly that reason.
  const now = Date.now();
  const text = await render({
    listings: [listing({ address: "paid1", sym: "SLUMP", trendingRank: 1, trendStart: now, trendExp: now + 3600_000, tier: "DIAMOND" })],
    chains: { solana: Array.from({ length: 9 }, (_, i) => siteRow(`HOT${i}`, 100 - i)) },
  });
  assert.ok(text.includes("$SLUMP"), `the paid row was displaced:\n${text}`);
  // …and it is ABOVE the site's rows, which is what the tier buys.
  assert.ok(text.indexOf("$SLUMP") < text.indexOf("$HOT0"), `a paid row sorted below a free one:\n${text}`);
});

test("the top-up stops at the minimum — it does not flood the board", async () => {
  const now = Date.now();
  const text = await render({
    listings: [listing({ address: "p", sym: "PAID", trendingRank: 1, trendStart: now, trendExp: now + 3600_000, tier: "DIAMOND" })],
    chains: { solana: Array.from({ length: 20 }, (_, i) => siteRow(`T${i}`, 50 - i)) },
    perChainMin: 3,
  });
  const rows = text.split("\n").filter((l) => /\| \[\$/.test(l));
  assert.strictEqual(rows.length, 3, `expected 3 rows, got ${rows.length}:\n${text}`);
});

test("⚠️ DEMO data never reaches the channel", async () => {
  // `live:false` is the site saying these are captured-at-listing numbers, not
  // readings. Publishing a board built from them is the fabricated figure this
  // board already refuses to render, arrived at one layer earlier.
  const now = Date.now();
  const text = await render({
    listings: [listing({ address: "p", sym: "PAID", trendingRank: 1, trendStart: now, trendExp: now + 3600_000, tier: "DIAMOND" })],
    chains: { solana: [siteRow("DEMO", 99)] },
    live: false,
  });
  assert.ok(text.includes("$PAID"), "the booked slot must still publish");
  assert.ok(!text.includes("$DEMO"), `demo data reached the channel:\n${text}`);
});

test("⚠️ a row with NO 24h reading is never chosen by us", async () => {
  // A slot this board books itself must carry a percentage — the promoter and
  // the market filler both honour that. A paid row keeps its space and renders
  // "—"; a row we chose has no such claim on it.
  const now = Date.now();
  const text = await render({
    listings: [listing({ address: "p", sym: "PAID", trendingRank: 1, trendStart: now, trendExp: now + 3600_000, tier: "DIAMOND" })],
    chains: { solana: [siteRow("BLANK", null), siteRow("REAL", 12)] },
  });
  assert.ok(text.includes("$REAL"), `a readable row was skipped:\n${text}`);
  assert.ok(!text.includes("$BLANK"), `we put an unreadable row on the board:\n${text}`);
});

test("the site being unreachable still publishes the booked slots", async () => {
  // A board that vanished is worse than one that is short: those rows are real
  // and somebody paid for them.
  const now = Date.now();
  const realGet = api.getListings;
  const realRank = api.boardRank;
  const realFetch = market.fetchMarket;
  api.getListings = async () => [listing({ address: "p", sym: "PAID", trendingRank: 1, trendStart: now, trendExp: now + 3600_000, tier: "DIAMOND" })];
  api.boardRank = async () => { throw new Error("fetch failed"); };
  market.fetchMarket = async () => ({ change24h: 5, mcap: 2e6, priceUsd: 1 });
  try {
    poster._resetState();
    const text = await poster.buildText();
    assert.ok(text.includes("$PAID"), `the board vanished when the site was down:\n${text}`);
  } finally {
    api.getListings = realGet;
    api.boardRank = realRank;
    market.fetchMarket = realFetch;
  }
});

test("⚠️ the bot does not rank for itself — it reads the site's order", async () => {
  // `byChange` on the site is the one owner of "which change may rank this".
  // A copy inside the bot is the fourth private answer to that question in this
  // repo, and the first three put `$MRNA +465%` on five cents of volume at the
  // top of a public board.
  const src = fss.readFileSync(path.join(__dirname, "..", "src", "services", "trendingPoster.js"), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.match(code, /api\.boardRank\(/, "the poster must read the site's ranking");
  assert.ok(
    !/changeRank|tradedEnough/.test(code),
    "the poster grew its own copy of the site's ranking rule",
  );
  assert.ok(/changeRank|tradedEnough/.test(fss.readFileSync(path.join(__dirname, "..", "..", "src", "lib", "home.ts"), "utf8")),
    "…and the site's owner must still exist, or this scan proves nothing");
});
