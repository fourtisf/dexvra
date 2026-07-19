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
  assert.ok(card.text.includes("Listed on dexvra.io"), "CTA is 'Listed on dexvra.io'");
  assert.ok(card.entities.some((e) => e.type === "custom_emoji"), "premium emoji present");
  assert.ok(card.entities.some((e) => e.type === "code"), "address as code");
  // the CTA links to the token page
  assert.ok(card.entities.some((e) => e.type === "text_link" && e.url === coin.siteUrl));
  // the injected link in the name must NOT become a text_link entity
  assert.ok(!card.entities.some((e) => e.type === "text_link" && /scam\.io/.test(e.url || "")));
  // every entity stays inside the text bounds
  for (const e of card.entities) assert.ok(e.offset + e.length <= card.text.length);
});

test("listing post: overview paragraph included when set, collapses when absent", () => {
  const base = {
    name: "Bull Cat",
    symbol: "$BULLCAT",
    chain: "solana",
    address: "G9j8WWDeJXZdvwQgP82ooDuHmpc3Gy8NCSins71Lpump",
    tier: "XPRESS",
    price: 0.000725,
    mcap: 725100,
    links: {},
    siteUrl: "https://dexvra.io/token/solana/G9j8",
  };
  const withOv = fmt.listingPost({ ...base, overview: "The Bull Cat is a community-driven memecoin on Solana.\n\nBuilt for  cats." });
  // collapsed to one clean paragraph (inner newlines/double spaces gone)
  assert.ok(withOv.text.includes("The Bull Cat is a community-driven memecoin on Solana. Built for cats."));
  const noOv = fmt.listingPost(base);
  assert.ok(!noOv.text.includes("undefined"));
  assert.ok(!noOv.text.includes("null"));
  // empty overview + empty socials never leave 3+ consecutive newlines
  assert.ok(!/\n{3,}/.test(noOv.text), `stray blank lines: ${JSON.stringify(noOv.text.slice(0, 200))}`);
  // long overviews are truncated at a word boundary with an ellipsis
  const long = fmt.listingPost({ ...base, overview: "word ".repeat(120) });
  assert.ok(/…/.test(long.text));
});

test("overview with ** cannot break markup parsing (bold-injection regression)", () => {
  const base = {
    name: "T",
    symbol: "$T",
    chain: "solana",
    address: "So1anaAddr111111111111111111111111111111111",
    tier: "XPRESS",
    price: 0.01,
    mcap: 1000,
    links: {},
    siteUrl: "https://dexvra.io/token/solana/So1",
  };
  for (const overview of ["100** community owned memecoin", "**bold** attempt", "a ** b ** c"]) {
    const card = fmt.listingPost({ ...base, overview });
    // raw markup must never leak into the final text
    assert.ok(!card.text.includes("(emoji/"), `emoji markup leaked for ${JSON.stringify(overview)}`);
    assert.ok(!/\]\(http/.test(card.text), "link markup leaked");
    // the CA keeps its code entity and the CTA keeps its link entity
    assert.ok(card.entities.some((e) => e.type === "code"), "code entity survived");
    assert.ok(card.entities.some((e) => e.type === "text_link" && e.url === base.siteUrl), "CTA link survived");
  }
});

test("pump post payload shows percent + MCs", () => {
  const coin = { name: "T", symbol: "$T", chain: "bsc", address: "0xabc", links: {}, siteUrl: "u" };
  const card = fmt.pumpPost(coin, 137.6, 310000, 128400000);
  assert.ok(card.text.includes("+138%"));
  assert.ok(card.text.includes("Market cap"));
  assert.ok(card.entities.some((e) => e.type === "custom_emoji"));
});

test("overview truncation never splits surrogate pairs (no U+FFFD)", () => {
  const base = {
    name: "T", symbol: "$T", chain: "solana",
    address: "So1anaAddr111111111111111111111111111111111",
    tier: "XPRESS", price: 0.01, mcap: 1000, links: {},
    siteUrl: "https://dexvra.io/token/solana/So1",
  };
  // 299 ascii chars then an astral emoji straddling the 300-code-point cut
  const overview = "a".repeat(299) + "🚀🔥💎 and more text to force truncation beyond the boundary";
  const card = fmt.listingPost({ ...base, overview });
  assert.ok(!card.text.includes("�"), "replacement char leaked (split surrogate)");
  // emoji-heavy overview truncated purely inside emoji runs
  const emojiOnly = "🚀".repeat(400);
  const card2 = fmt.listingPost({ ...base, overview: emojiOnly });
  assert.ok(!card2.text.includes("�"));
});
