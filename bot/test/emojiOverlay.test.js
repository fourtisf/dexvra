// Swapping an icon must not freeze the card it sits on.
//
// THE FAILURE: replaceEmojiAt wrote the entire rendered template into
// data/templates.json, and an admin-saved template beats the code default. So
// changing ONE icon forked that card from every future release — permanently
// and invisibly. Ship a copy fix, the operator pulls, restarts, checks the boot
// sha, and the change is still not on the card. That happened, and it is
// indistinguishable from a deploy that never landed.
//
// Now a swap records "slot #i ships `from`, show `to`" and the overlay is
// re-applied to whatever the code ships. Rewording still saves text, as it must
// — that IS a fork, chosen on purpose. Swapping an icon is not.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-ovl-"));

const test = require("node:test");
const assert = require("node:assert");
const tpl = require("../src/templates");

const DIR = process.env.BOT_DATA_DIR;
const chars = (key) => tpl.listEmojis(key).map((e) => e.char);
const overlayFile = () => {
  try {
    return JSON.parse(fss.readFileSync(path.join(DIR, tpl.EMOJI_FILE), "utf8"));
  } catch {
    return {};
  }
};
const savedFile = () => {
  try {
    return JSON.parse(fss.readFileSync(path.join(DIR, "templates.json"), "utf8"));
  } catch {
    return {};
  }
};

test("a swap writes an overlay entry, never the template text", async () => {
  await tpl.replaceEmojiAt("group_buy_alert", 0, "🤑");
  try {
    assert.deepStrictEqual(overlayFile().group_buy_alert, [{ i: 0, from: "💲", to: "🤑" }]);
    assert.ok(!("group_buy_alert" in savedFile()), "templates.json must stay untouched");
    assert.strictEqual(chars("group_buy_alert")[0], "🤑");
  } finally {
    await tpl.resetTemplate("group_buy_alert");
  }
});

test("a later code change to the SAME template still reaches the card", async () => {
  // The whole point. The operator swapped an icon months ago; a row is dropped
  // from the shipped card today; their card must lose that row.
  await tpl.replaceEmojiAt("group_buy_alert", 0, "🤑");
  try {
    const shipped = String(tpl.DEFAULTS.group_buy_alert);
    const live = String(tpl.getRawValue("group_buy_alert"));
    // Same skeleton — only the one glyph differs.
    assert.strictEqual(live.replace("🤑", "💲"), shipped);
  } finally {
    await tpl.resetTemplate("group_buy_alert");
  }
});

test("a row removed ABOVE a swapped icon does not lose the swap", async () => {
  // Indices shift when copy moves. Losing an operator's icons because a line
  // was deleted three rows up is exactly the brittleness this replaces, so the
  // entry falls back to matching its `from` glyph anywhere.
  const base = "🍎 one\n🍊 two\n🍇 three";
  await tpl.setTemplate("group_buy_style", base);
  await tpl.replaceEmojiAt("group_buy_style", 2, "🔥");
  try {
    assert.strictEqual(chars("group_buy_style").join(""), "🍎🍊🔥");
    // The shipped copy loses its first row — 🍇 is now slot #1, not #2.
    await tpl.setTemplate("group_buy_style", "🍊 two\n🍇 three");
    assert.strictEqual(chars("group_buy_style").join(""), "🍊🔥", "the swap followed its glyph");
  } finally {
    await tpl.resetTemplate("group_buy_style");
  }
});

test("an entry whose glyph is gone from the template is dropped, not misapplied", async () => {
  // The row it belonged to no longer exists. There is nothing to recolour, and
  // painting some OTHER icon with it would be worse than doing nothing.
  await tpl.setTemplate("group_buy_style", "🍎 one\n🍇 three");
  await tpl.replaceEmojiAt("group_buy_style", 1, "🔥");
  try {
    await tpl.setTemplate("group_buy_style", "🍎 one");
    assert.strictEqual(chars("group_buy_style").join(""), "🍎", "🍎 must not inherit the swap");
  } finally {
    await tpl.resetTemplate("group_buy_style");
  }
});

test("swapping the same slot twice replaces the entry, it does not chain", async () => {
  await tpl.replaceEmojiAt("group_buy_alert", 0, "🤑");
  await tpl.replaceEmojiAt("group_buy_alert", 0, "🍏");
  try {
    assert.deepStrictEqual(overlayFile().group_buy_alert, [{ i: 0, from: "💲", to: "🍏" }]);
    assert.strictEqual(chars("group_buy_alert")[0], "🍏");
  } finally {
    await tpl.resetTemplate("group_buy_alert");
  }
});

test("several icons on one template all survive together", async () => {
  await tpl.replaceEmojiAt("group_buy_alert", 0, "🤑");
  await tpl.replaceEmojiAt("group_buy_alert", 1, "🌕");
  await tpl.replaceEmojiAt("group_buy_alert", 2, "📉");
  try {
    assert.deepStrictEqual(chars("group_buy_alert").slice(0, 3), ["🤑", "🌕", "📉"]);
  } finally {
    await tpl.resetTemplate("group_buy_alert");
  }
});

test("a premium swap keeps its id, and the card carries the entity", async () => {
  await tpl.replaceEmojiAt("group_buy_alert", 0, "[🤑](emoji/5445284980978621387)");
  try {
    const e = tpl.listEmojis("group_buy_alert")[0];
    assert.strictEqual(e.char, "🤑");
    assert.strictEqual(e.id, "5445284980978621387");
  } finally {
    await tpl.resetTemplate("group_buy_alert");
  }
});

test("a premium emoji inside a link label falls back to plain, keeping the button", async () => {
  // "[⚡ Trade](url)" would become "[[⚡](emoji/1) Trade](url)" — no parser reads
  // that as a link, and it reached the card as literal brackets. Losing the
  // animation on one icon beats losing the button it is sitting on.
  const i = chars("group_buy_alert").indexOf("⚡");
  assert.ok(i >= 0, "the CTA row still leads with ⚡");
  await tpl.replaceEmojiAt("group_buy_alert", i, "[🔥](emoji/555)");
  try {
    // A full bag: an empty {name} would render "[](url)" and leave brackets of
    // its own, which has nothing to do with what this test is checking.
    const payload = tpl.render("group_buy_alert", {
      name: "alon", tier: "BUY", usd: "$50", tokenAmt: "1", symbol: "$X", price: "$1", mcap: "$1",
      nameRow: "alon", emoji: "🟢", verify: "v", wallet: "w", native: "", intro: "", poweredBy: "",
      tradeUrl: "https://t.me/x", chartUrl: "https://c", coinUrl: "https://d",
    });
    const labels = payload.entities.filter((e) => e.type === "text_link").map((e) => payload.text.substr(e.offset, e.length));
    assert.ok(labels.includes("🔥 Trade on Dexvra"), `the button survived: ${labels.join(" | ")}`);
    assert.doesNotMatch(payload.text, /\[|\]/, "no literal brackets reached the card");
  } finally {
    await tpl.resetTemplate("group_buy_alert");
  }
});

test("reset clears the swapped icons too — 'default' means the card as shipped", async () => {
  await tpl.replaceEmojiAt("group_buy_alert", 0, "🤑");
  await tpl.resetTemplate("group_buy_alert");
  assert.strictEqual(chars("group_buy_alert")[0], "💲");
  assert.strictEqual(tpl.isCustom("group_buy_alert"), false);
  assert.ok(!overlayFile().group_buy_alert, "and the entry is gone from disk");
});

test("reset ALL clears both files, and counts what it cleared", async () => {
  await tpl.replaceEmojiAt("group_buy_alert", 0, "🤑");
  await tpl.setTemplate("group_start", "hello");
  const n = await tpl.resetAllTemplates();
  assert.strictEqual(n, 2, "one text override + one overlay");
  assert.strictEqual(tpl.overrideCount(), 0);
  assert.strictEqual(chars("group_buy_alert")[0], "💲");
});

test("a swapped icon counts as custom, so the editor marks it ✏️", async () => {
  assert.strictEqual(tpl.isCustom("group_buy_alert"), false);
  await tpl.replaceEmojiAt("group_buy_alert", 0, "🤑");
  try {
    assert.strictEqual(tpl.isCustom("group_buy_alert"), true);
    assert.strictEqual(tpl.overrideCount(), 1, "counted once, not twice");
  } finally {
    await tpl.resetTemplate("group_buy_alert");
  }
});

test("an overlay on a REWORDED template still applies", async () => {
  // Both kinds of edit coexist: the text is the operator's, the icons are their
  // swaps on top of it.
  await tpl.setTemplate("group_buy_style", "💲 mine");
  await tpl.replaceEmojiAt("group_buy_style", 0, "🤑");
  try {
    assert.strictEqual(String(tpl.getRawValue("group_buy_style")), "🤑 mine");
    assert.deepStrictEqual(overlayFile().group_buy_style, [{ i: 0, from: "💲", to: "🤑" }]);
  } finally {
    await tpl.resetTemplate("group_buy_style");
  }
});

test("a malformed overlay entry cannot take the template down", async () => {
  // Hand-edited data/ files exist. A template that throws on render is a bot
  // that posts nothing, which is far worse than an icon that did not change.
  fss.writeFileSync(
    path.join(DIR, tpl.EMOJI_FILE),
    JSON.stringify({ group_buy_alert: [{ i: 0, from: "💲", to: "" }, { i: 99, from: "🦄", to: "🔥" }] }),
  );
  try {
    const text = String(tpl.getRawValue("group_buy_alert"));
    assert.ok(text.includes("{usd}"), "the template still resolves");
  } finally {
    fss.writeFileSync(path.join(DIR, tpl.EMOJI_FILE), "{}");
    await tpl.resetTemplate("group_buy_alert");
  }
});

// ── Un-forking what the old code froze ──────────────────────────────────────

test("an icon-only override is converted, so the card follows releases again", async () => {
  // Every existing server has these: the operator tapped "😀 Swap emoji" and the
  // old code wrote the whole card into templates.json, where it stopped
  // following every later copy fix.
  const frozen = String(tpl.DEFAULTS.group_buyer_row).replace("👤", "🕵️");
  fss.writeFileSync(path.join(DIR, "templates.json"), JSON.stringify({ group_buyer_row: frozen }));
  try {
    assert.deepStrictEqual(await tpl.migrateEmojiOnlyOverrides(), ["group_buyer_row"]);
    assert.deepStrictEqual(overlayFile().group_buyer_row, [{ i: 0, from: "👤", to: "🕵️" }]);
    assert.ok(!("group_buyer_row" in savedFile()), "the frozen text is gone");
    assert.strictEqual(String(tpl.getRawValue("group_buyer_row")), String(tpl.DEFAULTS.group_buyer_row).replace("👤", "🕵️"));
  } finally {
    await tpl.resetAllTemplates();
  }
});

test("a REWORDED template is never touched — that wording is the operator's", async () => {
  // The strict half of the test. Silently discarding somebody's own copy to
  // adopt ours would be far worse than leaving one card behind.
  const mine = "Totally my own wording {buyer}";
  fss.writeFileSync(path.join(DIR, "templates.json"), JSON.stringify({ group_buyer_row: mine }));
  try {
    assert.deepStrictEqual(await tpl.migrateEmojiOnlyOverrides(), []);
    assert.strictEqual(String(tpl.getRawValue("group_buyer_row")), mine);
  } finally {
    await tpl.resetAllTemplates();
  }
});

test("a template that gained a row since the fork is left alone, not mangled", async () => {
  // group_buy_alert's real case: the saved copy has a row the shipped one no
  // longer has, so the icons cannot be paired up. Leaving it frozen is honest;
  // guessing which icon went with which row is not.
  const frozen = String(tpl.DEFAULTS.group_buy_alert).replace("💲", "🤑") + "\n💧 {liq} · 24h {change}";
  fss.writeFileSync(path.join(DIR, "templates.json"), JSON.stringify({ group_buy_alert: frozen }));
  try {
    assert.deepStrictEqual(await tpl.migrateEmojiOnlyOverrides(), []);
    assert.strictEqual(String(tpl.getRawValue("group_buy_alert")), frozen);
  } finally {
    await tpl.resetAllTemplates();
  }
});

test("premium icons survive the conversion", async () => {
  const frozen = String(tpl.DEFAULTS.group_buyer_row).replace("👤", "[🕵️](emoji/999)");
  fss.writeFileSync(path.join(DIR, "templates.json"), JSON.stringify({ group_buyer_row: frozen }));
  try {
    await tpl.migrateEmojiOnlyOverrides();
    const e = tpl.listEmojis("group_buyer_row")[0];
    assert.strictEqual(e.char, "🕵️");
    assert.strictEqual(e.id, "999");
  } finally {
    await tpl.resetAllTemplates();
  }
});

test("running it twice moves nothing the second time", async () => {
  const frozen = String(tpl.DEFAULTS.group_buyer_row).replace("👤", "🕵️");
  fss.writeFileSync(path.join(DIR, "templates.json"), JSON.stringify({ group_buyer_row: frozen }));
  try {
    await tpl.migrateEmojiOnlyOverrides();
    assert.deepStrictEqual(await tpl.migrateEmojiOnlyOverrides(), []);
  } finally {
    await tpl.resetAllTemplates();
  }
});

test("an entity-saved template is skipped — pasting formatting IS a rewrite", async () => {
  fss.writeFileSync(
    path.join(DIR, "templates.json"),
    JSON.stringify({ group_buyer_row: { text: "👤 {buyer}{txn}", entities: [{ type: "bold", offset: 0, length: 2 }] } }),
  );
  try {
    assert.deepStrictEqual(await tpl.migrateEmojiOnlyOverrides(), []);
  } finally {
    await tpl.resetAllTemplates();
  }
});
