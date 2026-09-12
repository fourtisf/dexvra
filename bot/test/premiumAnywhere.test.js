// "saya ingin semua template kaya tdi broadcast sama payment ini bisa di edit
// pakai emoji premium".
//
// ⚠️ AND IT ALREADY COULD — this file is what says so, because "it works" and
// "nobody could tell" are the same observation from the admin bot. Every
// template takes premium emoji two ways: paste a message carrying them (the
// editor stores it verbatim as {text, entities}) or 😀 Swap emoji on the
// template itself. What was missing is that the ONE screen built for bulk
// restyling says "hanya dua kartu ini yang tersentuh" — true of that screen,
// and read as "the rest cannot be styled at all" — and that the swap prompt
// said NOTHING true about a DM or a tweet.
//
// ⚠️ THE BULK SCREEN'S SCOPE IS DELIBERATELY UNCHANGED. "khusus buy alert dan
// raid, yang lainnya ga usah, jangan diubah apapun" is an instruction on the
// record, pinned by allEmojiScreen.test.js — and it is the right one: dedupe is
// by GLYPH, so folding 156 templates in would make one ✅ swap repaint a
// receipt, a prompt and a buy card together. Per template, a swap stays aimable.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-premany-"));

const test = require("node:test");
const assert = require("node:assert");

const tpl = require("../src/templates");
const admin = require("../src/admin/adminBot");
const { payloadArgs } = require("../src/helpers/message");
const { premiumSurface, premiumNoteFor } = admin._premium;

// The two the operator named, plus the pay card's sibling.
const NAMED = ["pay_card", "pay_pick", "massdm_done"];

// A message an operator PASTES out of Telegram: a premium emoji at the front,
// a bold run, and the placeholders the card needs. This is exactly the shape
// adminBot stores when hasAuthoredFormatting() is true.
const pasted = (text) => ({
  text,
  entities: [
    { type: "custom_emoji", offset: 0, length: 2, custom_emoji_id: "5368324170671202286" },
    { type: "bold", offset: 3, length: 3 },
  ],
});

test("⚠️ a template SAVED with a premium emoji still carries it when the card is sent", async () => {
  for (const [key, text, vars] of [
    ["pay_pick", "🔶 PAY now\n{label}", { label: "Xpress Listing — $ANTHROPIG on Robinhood" }],
    ["pay_card", "🔶 PAY {amount} {native} to {address} on {network}",
      { label: "L", amount: "0.06", native: "ETH", address: "0x04d6AAa3147B9f5b5dB255d3151561c07019BDC6", network: "Robinhood Chain" }],
    ["massdm_done", "🔶 GM done\n{reach}{fail}",
      { ref: "MD-1", reach: "📬 **Sent to all Dexvra users**", fail: "\n🚫 **Couldn't reach:** 418", reached: 2 }],
  ]) {
    await tpl.setTemplate(key, pasted(text));
    const { text: out, extra } = payloadArgs(tpl.render(key, vars), false);
    const ce = (extra.entities || []).filter((e) => e.type === "custom_emoji");
    assert.strictEqual(ce.length, 1, `${key}: the emoji reached the wire`);
    // ⚠️ THE OFFSET IS THE WHOLE TEST. substituteEntities shifts every entity as
    // the placeholders grow; an offset that lands one character off puts the
    // emoji on the wrong glyph, which is how "{💎}" once reached a group.
    assert.strictEqual(out.slice(ce[0].offset, ce[0].offset + ce[0].length), "🔶", `${key}: on the right character`);
    assert.strictEqual(extra.parse_mode, undefined, `${key}: sent as entities, never re-parsed`);
    await tpl.resetTemplate(key);
  }
});

test("⚠️ EVERY template does — not the three that were named", async () => {
  // "semua template bot message harus bisa edit pakai emoji premium di
  // dexvraadmin bot". The three above were the ones an operator asked about;
  // this is the promise itself, over every key the editor lists.
  //
  // ⚠️ It is the guard a real defect walked past. The Mass DM preview used to
  // substitute its attachment row in as a {media} MARKUP string, read from
  // tpl.getRaw().text — which keeps the characters and drops the entities, so a
  // pasted 💎 flattened on exactly the surface this file promises. The row is
  // rendered whole and appended now; what stops the next one is measuring the
  // promise for all of them rather than for a shortlist.
  const keys = tpl.keys();
  assert.ok(keys.length > 150, `only ${keys.length} templates scanned — this proves nothing`);
  const flattened = [];
  try {
    for (const k of keys) {
      await tpl.setTemplate(k, pasted("⚡ premium {amount} check"));
      const out = tpl.render(k, { ...admin._preview.SAMPLE_VARS, amount: "1 SOL" });
      const ents = (out && out.entities) || [];
      if (!ents.some((e) => e.type === "custom_emoji")) flattened.push(k);
    }
  } finally {
    await tpl.resetAllTemplates();
  }
  assert.deepStrictEqual(flattened, [], "these templates lose a pasted premium emoji");
});

test("⚠️ …and every one of them is NAMED in the editor, not shown as a raw key", () => {
  // ⚠️ THE FIRST CUT OF THIS ASSERTION COULD NOT FAIL. It walked tpl.groups()
  // looking for a template in no group — and tpl.meta() SYNTHESISES
  // {group:"Other", label:key} for any string at all, so an orphan is
  // impossible by construction and the mutation run said so. This file has
  // been caught by that exact synthesis once before.
  //
  // What the synthesis cannot hide is the LABEL: a template with no META entry
  // is filed under "Other" reading `flow_step_failed`, which is machine
  // internals on the screen an operator edits copy from. Two were, until this.
  const bare = tpl.keys().filter((k) => tpl.meta(k).label === k);
  assert.deepStrictEqual(bare, [], "these have no META entry — the editor shows their raw key");
  assert.strictEqual(tpl.meta("no_such_template_xyz").label, "no_such_template_xyz",
    "the synthesis this is written against is gone — re-read the rule above");
});

test("…and the 😀 Swap emoji route exists on the ones the operator named", () => {
  for (const key of NAMED) {
    assert.ok(tpl.listEmojis(key).length > 0, `${key} has icons to swap: ${JSON.stringify(tpl.listEmojis(key))}`);
  }
  // The button is gated on exactly that, so a template with icons always offers
  // it — the route being reachable is the half this test cannot render.
  const src = fss.readFileSync(path.join(__dirname, "..", "src", "admin", "adminBot.js"), "utf8");
  assert.match(src, /if \(tpl\.listEmojis\(key\)\.length\) rows\.push\(\[Markup\.button\.callback\("😀 Swap emoji"/);
});

// ── which caveat is TRUE of a template ──────────────────────────────────────
//
// It used to be `isGroupPosted(key)` — a prefix test over group_/buybot_. Right
// while the picker only pointed at those; silent the moment it could reach a
// pay card, and WRONG the moment it could reach a tweet.

test("⚠️ a DM template gets the owner-Premium caveat — it used to get nothing", () => {
  for (const key of NAMED) {
    assert.strictEqual(premiumSurface(key), "telegram", key);
    assert.match(premiumNoteFor(key), /PEMILIK bot/, `${key} names the one setting that lights it up`);
    assert.ok(!/GramJS/.test(premiumNoteFor(key)), `${key} is not a channel post`);
  }
});

test("a CHANNEL post is the GramJS account, never @BotFather", () => {
  const key = tpl.keys().find((k) => { try { return tpl.meta(k).group === "Channel Posts"; } catch { return false; } });
  assert.ok(key, "there is a channel template to test");
  assert.strictEqual(premiumSurface(key), "channel");
  assert.match(premiumNoteFor(key), /GramJS/);
  assert.ok(!/PEMILIK bot/.test(premiumNoteFor(key)), "sending them to @BotFather cannot help a channel");
});

// ⚠️ THE ONE SURFACE THAT CAN NEVER ANIMATE ONE. X has no custom emoji at all,
// so a 💎 swap on an x_* template publishes its fallback character to a public
// tweet — accepted, saved, invisible, which is the failure the group note was
// written about.
test("⚠️ an X template says the swap can never light up", () => {
  assert.strictEqual(premiumSurface("x_trending"), "x");
  assert.match(premiumNoteFor("x_trending"), /tidak punya custom emoji/);
});

test("a slot spanning two surfaces carries BOTH caveats", () => {
  const both = premiumNoteFor(["pay_card", "x_trending"]);
  assert.match(both, /PEMILIK bot/);
  assert.match(both, /tidak punya custom emoji/);
});

// ⚠️ tpl.meta() SYNTHESISES {group:"Other"} for a key it does not know, so an
// unknown key must fall toward SHOWING a caveat rather than hiding one.
test("⚠️ an unknown key is treated as an ordinary bot message", () => {
  assert.strictEqual(premiumSurface("no_such_template_key"), "telegram");
  assert.match(premiumNoteFor("no_such_template_key"), /PEMILIK bot/);
});

// ⚠️ A CAVEAT NOBODY IS SHOWN IS NO CAVEAT, and four screens prompt for an
// emoji: the bulk slot, the buy slot, the per-template slot, and the picker
// that lists them. Deleting the call from any ONE of them is invisible to every
// assertion above — the whole point of this change would be gone from the
// screen an operator is looking at while they paste. Found by a mutation run,
// not by reading, so the rule is COUNTED rather than trusted.
test("⚠️ every emoji prompt carries it — counted, not trusted", () => {
  const src = fss
    .readFileSync(path.join(__dirname, "..", "src", "admin", "adminBot.js"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
  const uses = (src.match(/premiumNoteFor\(/g) || []).length;
  // Its own definition, plus one per prompting screen.
  assert.strictEqual(uses, 5, `1 definition + 4 prompts; found ${uses}`);
});

// The screen that produced the question has to answer it.
test("⚠️ the bulk screen says the rest is out of scope AND still styleable", () => {
  const t = admin._allEmoji.allEmojiText(0);
  assert.match(t, /tidak ikut berubah/, "its scope is stated — one swap may not drag a receipt along");
  assert.match(t, /tetap bisa pakai emoji premium/, "…and the route for the rest is named, not left implied");
  assert.match(t, /Swap emoji/, "by the button an operator actually taps");
  // ⚠️ AND THE PATH IT NAMES HAS TO EXIST. There is no "📝 Templates" button —
  // the groups are on the main menu itself — and an instruction pointing at a
  // screen nobody can find is this repo's placeholder rule, one surface over.
  const groups = admin._menu.groupNames();
  for (const g of ["Bot Messages", "Mass DM"]) {
    assert.ok(groups.includes(g), `${g} is a real group on the main menu`);
    assert.match(t, new RegExp(g), `…and the screen names it`);
  }
  assert.ok(!/📝 Templates/.test(t), "a button that does not exist is worse than no instruction");
});
