// Every icon the bot uses, on one screen.
//
// THE FAILURE, in the operator's own words: "saya capek set ulang 1/1". 141
// templates carry 395 emoji between them and only 74 DISTINCT glyphs — 🔹 alone
// appears in 39 places across 31 templates. Restyling the bot meant opening a
// template, tapping Swap emoji, choosing, going back, and repeating: thirty-nine
// times for ONE icon, with no way to know when you were finished.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-allemo-"));

const test = require("node:test");
const assert = require("node:assert");
const tpl = require("../src/templates");
const admin = require("../src/admin/adminBot");
const { allEmojiSlots, allEmojiKb, allEmojiText, allEmojiPages, ALL_EMOJI_PER_PAGE } = admin._allEmoji;

const flat = (kb) => kb.reply_markup.inline_keyboard.flat();

test("one screen reaches every icon in every template", () => {
  const slots = allEmojiSlots();
  const covered = new Set(slots.flatMap((s) => s.spots.map((p) => `${p.key}#${p.i}`)));
  const missing = [];
  for (const key of tpl.keys()) {
    if (key === "chain_emojis") continue;
    for (const e of tpl.listEmojis(key)) {
      if (!covered.has(`${key}#${e.i}`)) missing.push(`${key}#${e.i} ${e.char}`);
    }
  }
  assert.deepStrictEqual(missing, [], "an icon with no slot is an icon the operator cannot reach");
});

test("identical icons are ONE tap, which is the entire point", () => {
  // An operator thinks in icons, not in template rows. The ✅ on a position row
  // and the ✅ on a receipt are one decision, and a bot whose ✅ changed in some
  // places and not others reads as broken rather than as styled.
  const slots = allEmojiSlots();
  const chars = slots.map((s) => s.char);
  assert.strictEqual(new Set(chars).size, chars.length, "no glyph appears on two buttons");
  const busiest = slots[0];
  assert.ok(busiest.spots.length > 10, `the top slot covers many places, got ${busiest.spots.length}`);
  const places = slots.reduce((n, s) => n + s.spots.length, 0);
  assert.ok(places > slots.length * 3, `${places} places behind ${slots.length} buttons — that ratio IS the feature`);
});

test("the busiest icons come first — they are not on page four", () => {
  const slots = allEmojiSlots();
  for (let i = 1; i < slots.length; i++) {
    assert.ok(slots[i - 1].spots.length >= slots[i].spots.length, "sorted by reach, descending");
  }
});

test("each button says how many places it moves, before it is tapped", () => {
  // One tap here can change thirty-nine places. That is not a thing to discover
  // afterwards.
  const labels = flat(allEmojiKb(0)).map((b) => b.text);
  const busiest = allEmojiSlots()[0];
  assert.ok(labels.some((l) => l.includes(`×${busiest.spots.length}`)), `the reach is on the button: ${labels[0]}`);
  assert.match(allEmojiText(0), /×N/, "and the header explains what the number means");
});

test("paging covers every slot exactly once, and a button means the same slot on any page", () => {
  const slots = allEmojiSlots();
  const pages = allEmojiPages();
  const seen = [];
  for (let p = 0; p < pages; p++) {
    for (const b of flat(allEmojiKb(p))) {
      const m = /^aemx:(\d+)$/.exec(b.callback_data || "");
      if (m) seen.push(Number(m[1]));
    }
  }
  assert.deepStrictEqual([...seen].sort((a, b) => a - b), slots.map((_, i) => i), "every slot, once");
  assert.ok(pages > 1 && slots.length > ALL_EMOJI_PER_PAGE, "and it really does need paging");
});

test("network marks are NOT here — the bot picks those by chain", () => {
  // Same carve-out the buy-card screen makes: `plasma = 🟢` collides with the
  // buy-size 🟢, and folding them together would repaint every small buy the
  // day somebody rebranded a chain.
  const keys = new Set(allEmojiSlots().flatMap((s) => s.spots.map((p) => p.key)));
  assert.ok(!keys.has("chain_emojis"));
  assert.match(allEmojiText(0), /Chain emoji/, "…and the screen says where they live instead");
});

test("one swap really does move every place at once", async () => {
  const before = allEmojiSlots()[0];
  assert.ok(before.spots.length > 1);
  for (const spot of before.spots) await tpl.replaceEmojiAt(spot.key, spot.i, "🦊");
  try {
    for (const spot of before.spots) {
      const now = tpl.listEmojis(spot.key)[spot.i];
      assert.strictEqual(now.char, "🦊", `${spot.key}#${spot.i} followed the swap`);
    }
    // …and it is still ONE button afterwards, not one per template.
    const fox = allEmojiSlots().find((s) => s.char === "🦊");
    assert.strictEqual(fox.spots.length, before.spots.length, "the slot did not split apart");
  } finally {
    for (const key of new Set(before.spots.map((s) => s.key))) await tpl.resetTemplate(key);
  }
});

test("the screen is one tap from the main menu", () => {
  const labels = admin._menu.mainKb().reply_markup.inline_keyboard.flat();
  assert.ok(labels.some((b) => b.callback_data === "aem:0"), "an entry on the front page");
});
