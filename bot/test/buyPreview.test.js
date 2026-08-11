// Seeing the buy card before a real buy does.
//
// An emoji on a button is not the card. 🪙 next to 🔵 in a keyboard grid says
// nothing about whether the 🪙 row reads well under the 💲 row, and the only way
// to find out was to wait for somebody to buy the token — hours on a quiet
// contract, in a customer's group, in public.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-bprev-"));

const test = require("node:test");
const assert = require("node:assert");
const tpl = require("../src/templates");
const mon = require("../src/group/buyMonitor");
const admin = require("../src/admin/adminBot");
const { payloadArgs } = require("../src/helpers/message");
const { buyPreviews, buyEmojiKb, buyEmojiSlots, BUY_CARD_EMOJI_KEYS } = admin._buyEmoji;

const preview = (label) => buyPreviews().find((p) => p.label === label).payload;
const reset = () => Promise.all([...BUY_CARD_EMOJI_KEYS, "chain_emojis"].map((k) => tpl.resetTemplate(k)));
async function swap(char, to) {
  const slot = buyEmojiSlots().find((s) => s.char === char && !s.chain);
  for (const t of slot.spots) await tpl.replaceEmojiAt(t.key, t.i, to);
}

test("both cards are previewed, not just the ordinary one", () => {
  assert.deepStrictEqual(buyPreviews().map((p) => p.label), ["Buy alert", "Whale alert"]);
});

test("the preview is the REAL card — every row a group would get", () => {
  // Rendered by the alert's own renderer, not a lookalike built in the admin
  // bot. A second renderer agrees with the real one right up until the day it
  // does not, and the whole point of looking is to trust what you see.
  const text = preview("Buy alert").text;
  for (const row of [/^🚨 NEW BUY ALERT alon BUY!/m, /^🟣 alon \$ALON$/m, /^💲 \$804\.72 \(4\.2318 SOL\)$/m,
                     /^🪙 [\d,.]+ \$ALON$/m, /^📊 .+ · MC .+$/m,
                     /^👤 .+ · Txn$/m, /^✅ Position: .+ · Wallet$/m]) {
    assert.match(text, row);
  }
  // The liquidity / 24h row was dropped: pool depth has not changed since the
  // last alert and will not change by the next, so repeating it under every buy
  // spent a line restating the background instead of reporting the event.
  assert.doesNotMatch(text, /24h/);
  assert.match(preview("Whale alert").text, /WHALE WALLET!/);
});

test("a swapped icon shows up in the preview immediately", async () => {
  // The reason the preview exists: choosing an icon, not just changing one.
  await swap("🪙", "🌊");
  try {
    assert.match(preview("Buy alert").text, /^🌊 /m);
    assert.doesNotMatch(preview("Buy alert").text, /🪙/);
    assert.match(preview("Whale alert").text, /^🌊 /m, "the whale card moves with it");
  } finally {
    await reset();
  }
});

test("a swapped CHAIN mark shows up too — it leads the token row", async () => {
  const solana = buyEmojiSlots().find((s) => s.chain && s.label === "solana");
  await tpl.replaceEmojiAt("chain_emojis", solana.spots[0].i, "🦊");
  try {
    assert.match(preview("Buy alert").text, /^🦊 alon \$ALON$/m);
  } finally {
    await reset();
  }
});

test("the preview goes out with ENTITIES, never wrapped in HTML", () => {
  // Entity offsets are counted against the message text. Wrapping the card in a
  // "here is your preview" header would slide every link — and every premium
  // emoji — onto the wrong characters.
  const payload = preview("Buy alert");
  const { text, extra } = payloadArgs(payload);
  assert.strictEqual(text, payload.text, "the card is its own message, unwrapped");
  assert.ok(extra.entities && extra.entities.length, "links ride as entities");
  assert.ok(!extra.parse_mode, "no parse_mode — the text is not markup any more");
});

test("the links a reader taps all survive into the preview", () => {
  const byLabel = {};
  const p = preview("Buy alert");
  for (const e of p.entities) if (e.type === "text_link") byLabel[p.text.substr(e.offset, e.length)] = e.url;
  assert.match(byLabel["⚡ Trade on Dexvra"], /^https:\/\/t\.me\/.+\?start=ca_solana_/);
  assert.match(byLabel["📈 Chart"], /^https:\/\/dexscreener\.com\//);
  assert.ok(byLabel["Txn"], "the proof link — the card's whole claim");
  assert.ok(byLabel["Wallet"], "the buyer's holdings");
});

test("a premium emoji reaches the preview as a real custom_emoji entity", async () => {
  // This is the honest answer to "does premium survive in a group?". The
  // preview is sent BY THE ADMIN BOT — a regular bot, exactly like the one that
  // posts into groups — so what the operator sees here is what the group gets.
  await swap("💲", "[🤑](emoji/5445284980978621387)");
  try {
    const p = preview("Buy alert");
    const prem = p.entities.filter((e) => e.type === "custom_emoji");
    assert.strictEqual(prem.length, 1);
    assert.strictEqual(prem[0].custom_emoji_id, "5445284980978621387");
    assert.strictEqual(p.text.substr(prem[0].offset, prem[0].length), "🤑", "over the right character");
  } finally {
    await reset();
  }
});

test("the preview is one tap from the emoji screen", () => {
  const flat = buyEmojiKb().reply_markup.inline_keyboard.flat();
  assert.ok(flat.some((b) => b.callback_data === "bemp"), "a look-at-it button");
});

test("previewing never writes anything", async () => {
  // It renders from the live templates and must not save a thing — an operator
  // pressing 👁 must not be able to turn a default template into a custom one.
  const before = tpl.overrideCount();
  buyPreviews();
  assert.strictEqual(tpl.overrideCount(), before);
});
