const test = require("node:test");
const assert = require("node:assert");
const { fmtPrice, fmtCap, formatNumber, escapeHtml } = require("../src/helpers/format");
const fmt = require("../src/channels/format");

test("price / cap / number formatting", () => {
  assert.strictEqual(fmtPrice(1.83), "$1.83");
  assert.strictEqual(fmtPrice(0.0000246), "$0.0000246"); // trailing zeros stripped
  assert.strictEqual(fmtPrice(0), "$0");
  assert.strictEqual(fmtCap(1.72e9), "$1.72B");
  assert.strictEqual(fmtCap(null), "—");
  assert.strictEqual(formatNumber(1720000000), "1.7B");
  assert.strictEqual(formatNumber("not a number"), "0"); // guarded, never throws
});

test("escapeHtml neutralizes markup", () => {
  assert.strictEqual(escapeHtml('<b>&"x'), "&lt;b&gt;&amp;\"x");
});

test("listing post card contains the essentials + is HTML-escaped", () => {
  const coin = {
    name: "Evil <script>",
    symbol: "$EVIL",
    chain: "solana",
    address: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
    tier: "DIAMOND",
    price: 0.0000246,
    mcap: 1.72e9,
    links: { website: "https://x.io", twitter: null, telegram: null },
    siteUrl: "https://dexvra.io/token/solana/Dez",
  };
  const card = fmt.listingPost(coin);
  assert.ok(card.includes("New Listing on Dexvra"));
  assert.ok(card.includes("$EVIL"));
  assert.ok(card.includes("Diamond"));
  assert.ok(card.includes("&lt;script&gt;")); // name escaped, not raw
  assert.ok(!card.includes("<script>"));
});

test("pump post shows percent + MCs", () => {
  const coin = { name: "T", symbol: "$T", chain: "bsc", address: "0xabc", links: {}, siteUrl: "u" };
  const card = fmt.pumpPost(coin, 137.6, 310000, 128400000);
  assert.ok(card.includes("138%"));
  assert.ok(card.includes("Pump Alert"));
});
