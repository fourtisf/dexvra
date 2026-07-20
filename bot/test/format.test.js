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
  assert.ok(card.text.includes("Liquidity:") && card.text.includes("Market Cap:"), "Liquidity + Market Cap lines");
  assert.ok(card.text.includes("Chain:"), "Chain line present");
  assert.ok(card.text.includes("dexvra.io/token"), "token-page link line present");
  assert.ok(card.entities.some((e) => e.type === "code"), "address as code");
  // the CTA links to the token page
  assert.ok(card.entities.some((e) => e.type === "text_link" && e.url === coin.siteUrl));
  // the injected link in the name must NOT become a text_link entity
  assert.ok(!card.entities.some((e) => e.type === "text_link" && /scam\.io/.test(e.url || "")));
  // every entity stays inside the text bounds
  for (const e of card.entities) assert.ok(e.offset + e.length <= card.text.length);
});

test("listing post: clean layout, no overview paragraph, no stray blanks", () => {
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
  // The channel post no longer renders the overview paragraph (operator layout):
  // even when a coin carries one, it must not appear in the post body.
  const withOv = fmt.listingPost({ ...base, overview: "The Bull Cat is a community-driven memecoin on Solana." });
  assert.ok(!withOv.text.includes("community-driven memecoin"), "overview must NOT render in the post");
  const noOv = fmt.listingPost(base);
  assert.ok(!noOv.text.includes("undefined"));
  assert.ok(!noOv.text.includes("null"));
  // empty socials never leave 3+ consecutive newlines
  assert.ok(!/\n{3,}/.test(noOv.text), `stray blank lines: ${JSON.stringify(noOv.text.slice(0, 200))}`);
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

test("xpress listing post matches the operator's reference layout", () => {
  const coin = {
    name: "The Golden Whale",
    symbol: "WHALE",
    chain: "solana",
    tier: "XPRESS",
    address: "4rABHLfm7BDkkjrkyPYtRadg2BZTEZVoEy3MzrFQpump",
    price: 0.0000842,
    mcap: 84400,
    liq: 22300,
    links: { twitter: "https://x.com/gw", website: "https://gw.io", telegram: "https://t.me/gw" },
  };
  const { text } = fmt.listingPost(coin);
  assert.ok(text.startsWith("⚡ Xpress Listing — The Golden Whale live on Dexvra"), "header line");
  assert.ok(text.includes("💲 The Golden Whale ($WHALE)"), "💲 token line");
  assert.ok(text.includes("✅ dexvra.io/token/solana/4rABHLfm7BDkkjrkyPYtRadg2BZTEZVoEy3MzrFQpump"), "✅ full dexvra link line");
  assert.ok(text.includes("Chain: Solana"), "chain line");
  assert.ok(text.includes("📄 Contract:\n4rABHLfm7BDkkjrkyPYtRadg2BZTEZVoEy3MzrFQpump"), "contract block");
  assert.ok(text.includes("◼️ Liquidity: $22.3K"), "◼️ liquidity line");
  assert.ok(text.includes("📈 Market Cap: $84.4K"), "market-cap line");
  assert.ok(text.includes("🔗 $WHALE social links\n❌ X\n🌐 Website\n✈️ Telegram"), "socials block (❌ X)");
  assert.ok(text.includes("📎 Dexvra\n💎 Dexvra.io · 🚨 Listings · 🔥 Trending · 📢 Announcements"), "footer block");
});

test("pump post payload shows percent + MCs", () => {
  const coin = { name: "T", symbol: "$T", chain: "bsc", address: "0xabc", links: {}, siteUrl: "u" };
  const card = fmt.pumpPost(coin, 137.6, 310000, 128400000);
  assert.ok(card.text.includes("+138%"));
  assert.ok(card.text.includes("Market cap"));
  assert.ok(card.text.includes("2.4×"), "shows the × multiple"); // 1 + 137.6/100 = 2.376 → 2.4×
  assert.ok(card.text.includes("🚀"), "rocket emoji present (unicode fallback)");
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
