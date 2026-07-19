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

test("listing post payload contains the essentials + premium emoji entities", () => {
  const coin = {
    name: "Evil [x](https://scam.io)", // markup-injection attempt in a user value
    symbol: "$EVIL",
    chain: "solana",
    address: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
    tier: "DIAMOND",
    price: 0.0000246,
    mcap: 1.72e9,
    links: { website: "https://x.io", twitter: null, telegram: null },
    siteUrl: "https://dexvra.io/token/solana/Dez",
  };
  const card = fmt.listingPost(coin); // → { text, entities }
  assert.ok(card.text.includes("New Listing on Dexvra"));
  assert.ok(card.text.includes("$EVIL"));
  assert.ok(card.text.includes("Diamond"));
  assert.ok(card.entities.some((e) => e.type === "custom_emoji"), "premium emoji present");
  assert.ok(card.entities.some((e) => e.type === "code"), "address as code");
  // the injected link in the name must NOT become a text_link entity
  assert.ok(!card.entities.some((e) => e.type === "text_link" && /scam\.io/.test(e.url || "")));
  // every entity stays inside the text bounds
  for (const e of card.entities) assert.ok(e.offset + e.length <= card.text.length);
});

test("pump post payload shows percent + MCs", () => {
  const coin = { name: "T", symbol: "$T", chain: "bsc", address: "0xabc", links: {}, siteUrl: "u" };
  const card = fmt.pumpPost(coin, 137.6, 310000, 128400000);
  assert.ok(card.text.includes("+138%"));
  assert.ok(card.text.includes("Market cap"));
  assert.ok(card.entities.some((e) => e.type === "custom_emoji"));
});
