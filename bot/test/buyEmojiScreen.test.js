// Every icon on the buy card, on one screen, without rewriting a word of it.
//
// Restyling the buy alert used to mean visiting EIGHT templates: the banner in
// group_buy_intro, the size icons in group_buy_style, the buyer row, the
// Position tick, the network mark in chain_emojis, and the 💲🪙📊 column in
// group_buy_alert — with group_whale_alert carrying its own copy of that column.
// Eight screens, each with its own "😀 Swap emoji", and the only way to change
// an icon in some of them was to retype the whole card.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-bemo-"));

const test = require("node:test");
const assert = require("node:assert");
const tpl = require("../src/templates");
const mon = require("../src/group/buyMonitor");
const admin = require("../src/admin/adminBot");
const { buyEmojiSlots, buyEmojiKb, buyEmojiText, BUY_CARD_EMOJI_KEYS } = admin._buyEmoji;

const g = { chatId: "-1", chain: "solana", address: "So1", sym: "ALON", name: "alon", minBuyUsd: 0 };
const buy = { txHash: "t", buyer: "GDAtwgaaaaaaaaaaaaaaaaaaaaaaaaZ7tX", usd: 40, tokenAmount: 100 };
const pool = { priceUsd: 1, mcap: 1, liquidity: 1, change24h: 1 };
const pos = { held: 100, holdsUsd: 100, position: "+1%" };

/** Simulate the save path: one emoji, written to every spot the slot owns. */
async function swap(slot, to) {
  for (const t of slot.spots) await tpl.replaceEmojiAt(t.key, t.i, to);
}
const slotFor = (char) => buyEmojiSlots().find((s) => s.char === char && !s.chain);
const chainSlot = (label) => buyEmojiSlots().find((s) => s.chain && s.label === label);
const reset = () => Promise.all([...BUY_CARD_EMOJI_KEYS, "chain_emojis"].map((k) => tpl.resetTemplate(k)));

test("every icon the rendered card shows is reachable from this one screen", async () => {
  // The whole promise of the screen. If a card icon has no slot, the operator is
  // back to hunting through eight templates for the one that owns it.
  const card = mon.renderRealAlert(g, buy, pool, pos).text;
  const whale = tpl.render("group_whale_alert", mon.alertVars(g, buy, pool, pos)).text;
  const covered = new Set(buyEmojiSlots().map((s) => s.char));
  const onCards = [...new Set([...(card + whale).matchAll(/\p{Extended_Pictographic}/gu)].map((m) => m[0]))];
  assert.deepStrictEqual(onCards.filter((c) => !covered.has(c)), []);
});

test("swapping one slot moves BOTH cards — they are deliberately one grammar", async () => {
  // 💲 exists in group_buy_alert AND group_whale_alert. Every drift between
  // these two cards happened because one of them was edited alone.
  const slot = slotFor("💲");
  assert.strictEqual(slot.spots.length, 2, "the money row lives on both cards");
  await swap(slot, "🤑");
  try {
    assert.match(mon.renderRealAlert(g, buy, pool, pos).text, /^🤑 /m);
    assert.match(tpl.render("group_whale_alert", mon.alertVars(g, buy, pool, pos)).text, /^🤑 /m);
  } finally {
    await reset();
  }
});

test("a chain mark is NOT folded into a card icon that happens to look the same", async () => {
  // `plasma = 🟢` and the 🟢 buy-size icon are the same character and completely
  // different settings. Folding them would repaint every small buy the day
  // somebody rebranded a network — and the collision list is not fixed, so this
  // stays true whatever rows the cards gain.
  await swap(chainSlot("plasma"), "🥑");
  try {
    assert.strictEqual(slotFor("🟢").label, "buy", "the size icon is untouched");
    assert.match(mon.renderRealAlert(g, buy, pool, pos).text, /🟢/, "small buys still show 🟢");
  } finally {
    await reset();
  }
});

test("swapping a chain mark repaints only that network", async () => {
  await swap(chainSlot("solana"), "🦊");
  try {
    assert.match(mon.alertVars(g, buy, pool, pos).nameRow, /^🦊 /);
    assert.match(mon.alertVars({ ...g, chain: "base" }, buy, pool, pos).nameRow, /^🔵 /);
  } finally {
    await reset();
  }
});

test("the template's TEXT is never touched — only the character changes", async () => {
  // The point of the screen: an operator restyling the card must not have to
  // retype it, and must not risk mangling a {placeholder} while doing so.
  const before = String(tpl.getRawValue("group_buy_alert"));
  await swap(slotFor("🪙"), "🌕");
  try {
    assert.strictEqual(String(tpl.getRawValue("group_buy_alert")), before.replace("🪙", "🌕"));
    assert.strictEqual(admin._tpl.placeholderWarning("group_buy_alert"), "", "no placeholder disturbed");
  } finally {
    await reset();
  }
});

test("a premium emoji survives the swap, and the slot then shows 💎", async () => {
  await swap(slotFor("🚨"), "[🔥](emoji/5445284980978621387)");
  try {
    const s = slotFor("🔥");
    assert.strictEqual(s.id, "5445284980978621387");
    assert.match(buyEmojiText(), /💎 1 emoji sudah premium/);
  } finally {
    await reset();
  }
});

test("each button says what its icon is for, read out of the template itself", () => {
  // Derived, not hand-written: a hand-written table is a second copy of the
  // card's layout and starts lying the first time somebody rewords a row.
  const label = (c) => slotFor(c).label;
  assert.strictEqual(label("💲"), "usd");
  assert.strictEqual(label("📈"), "Chart");
  assert.strictEqual(label("✅"), "Position");
  assert.strictEqual(label("🟢"), "buy", "a pipe list has no words — the field position is the meaning");
  assert.strictEqual(chainSlot("solana").char, "🟣");
});

test("the hint follows a reworded row instead of going stale", async () => {
  await tpl.setTemplate("group_buyer_row", "👤 Pembeli {buyer}{txn}");
  try {
    assert.strictEqual(slotFor("👤").label, "Pembeli");
  } finally {
    await reset();
  }
});

test("the way in is on every template the card is built from", () => {
  // Whichever of the eight an operator happens to open, the whole palette is one
  // tap away rather than seven screens away.
  for (const key of [...BUY_CARD_EMOJI_KEYS, "chain_emojis"]) {
    const flat = admin._tpl.viewKb(key).reply_markup.inline_keyboard.flat();
    assert.ok(flat.some((b) => b.callback_data === "bem"), `${key} must offer the buy-card emoji screen`);
  }
  // And nowhere else — it would be a dead end on a channel post.
  const flat = admin._tpl.viewKb("post_trending").reply_markup.inline_keyboard.flat();
  assert.ok(!flat.some((b) => b.callback_data === "bem"));
});

test("every button maps back to the slot it was built from", () => {
  // The callback carries an INDEX, and the handler re-derives the list at press
  // time — an operator can leave this screen open while editing elsewhere.
  const slots = buyEmojiSlots();
  const taps = buyEmojiKb()
    .reply_markup.inline_keyboard.flat()
    .filter((b) => b.callback_data.startsWith("bemx:"));
  assert.strictEqual(taps.length, slots.length, "one button per slot, none dropped");
  for (const b of taps) {
    const s = slots[Number(b.callback_data.split(":")[1])];
    assert.ok(s, `${b.callback_data} points at nothing`);
    assert.ok(b.text.includes(s.char), `${b.text} should show ${s.char}`);
  }
});

test("the screen says the group cards cannot animate premium emoji", () => {
  // Telegram strips custom-emoji entities from a regular bot, and these cards
  // are posted by one. Saying it here beats an evening spent wondering.
  assert.match(buyEmojiText(), /bot biasa/);
});
