// Back-compat: templates saved by admins BEFORE the self-spacing {socials}/
// {overview} vars must keep rendering clean (no doubled blank lines, no raw
// leftovers). Isolated data dir — set BEFORE requiring any src module.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-tplc-"));

const test = require("node:test");
const assert = require("node:assert");
const tpl = require("../src/templates");

test("old string template with explicit blank line after {socials} stays clean", async () => {
  // pre-diff layout: template writes its own \n\n after the placeholder
  await tpl.setTemplate("post_listing", "X\n\n{socials}\n\nCTA [go]({coinUrl})");
  const r = tpl.render("post_listing", {
    socials: "🌐 [Website](https://a.io)\n\n", // new self-spacing var
    coinUrl: "https://dexvra.io/t",
  });
  assert.ok(!/\n{3,}/.test(r.text), `doubled blank lines: ${JSON.stringify(r.text)}`);
  await tpl.resetTemplate("post_listing");
});

test("old ENTITY-saved template: trailing newlines of self-spacing vars are trimmed", async () => {
  // entity-mode save (admin pasted a message): {socials} followed by the
  // template's own blank line — the var's trailing \n\n must be trimmed.
  await tpl.setTemplate("post_trending", {
    text: "HEAD\n\n{socials}\n\nCTA",
    entities: [{ type: "bold", offset: 0, length: 4 }],
  });
  const r = tpl.render("post_trending", {
    socials: "Website · X\n\n",
    overview: "",
  });
  assert.ok(!/\n{3,}/.test(r.text), `doubled blank lines: ${JSON.stringify(r.text)}`);
  assert.ok(r.text.includes("Website · X\n\nCTA"), r.text);
  await tpl.resetTemplate("post_trending");
});

test("resetAllTemplates wipes every custom override in one shot", async () => {
  await tpl.setTemplate("intro_tiered", "custom A");
  await tpl.setTemplate("pay_card", "custom B");
  assert.ok(tpl.isCustom("intro_tiered") && tpl.isCustom("pay_card"));
  const n = await tpl.resetAllTemplates();
  assert.ok(n >= 2, `expected ≥2 cleared, got ${n}`);
  assert.strictEqual(tpl.isCustom("intro_tiered"), false);
  assert.strictEqual(tpl.isCustom("pay_card"), false);
  // second call is a no-op → 0 cleared, never throws
  assert.strictEqual(await tpl.resetAllTemplates(), 0);
});

test("overrideCount sees orphaned keys from older template generations", async () => {
  assert.strictEqual(tpl.overrideCount(), 0);
  // a key saved under the OLD template structure, no longer in DEFAULTS —
  // reset-all must still offer to clear it instead of "nothing to reset"
  await tpl.setTemplate("post_listing", "old orphaned layout");
  assert.ok(!tpl.keys().includes("post_listing"), "sanity: key really is orphaned");
  assert.strictEqual(tpl.overrideCount(), 1);
  assert.strictEqual(await tpl.resetAllTemplates(), 1);
  assert.strictEqual(tpl.overrideCount(), 0);
});

test("new default layout still spaces correctly with empty optional vars", () => {
  const r = tpl.render("post_listing_xpress", {
    logoEmoji: "",
    name: "T",
    symbol: "$T",
    chain: "Solana",
    address: "So1",
    price: "$1",
    mcap: "$2",
    liq: "$3",
    coinUrl: "https://dexvra.io/t",
    coinUrlLabel: "dexvra.io/t",
    twitter: "https://x.com/t",
    website: "https://t.io",
    telegram: "https://t.me/t",
    site: "https://dexvra.io",
    listing: "https://t.me/l",
    trending: "https://t.me/tr",
    announce: "https://t.me/a",
  });
  assert.ok(!/\n{3,}/.test(r.text), JSON.stringify(r.text));
  assert.ok(r.text.includes("T ($T)") && r.text.includes("Chain:"));
});

test("entity-saved WYSIWYG template: socials strip remaps entity offsets", async () => {
  const fmt = require("../src/channels/format");
  const text =
    "HEAD\n\n🔗 {symbol} social links\n❌ [X]({twitter})\n🌐 [Website]({website})\n✈️ [Telegram]({telegram})\n\n📎 END {name}";
  const clipIdx = text.indexOf("📎");
  await tpl.setTemplate("post_trending", {
    text,
    entities: [
      { type: "bold", offset: 0, length: 4 },
      { type: "custom_emoji", offset: clipIdx, length: 2, custom_emoji_id: "123" },
    ],
  });
  // no socials at all → the whole social paragraph (incl. header line) drops
  const card = fmt.trendingPost({ name: "T", symbol: "T", chain: "solana", address: "So1", links: {} });
  assert.ok(!card.text.includes("social links"), card.text);
  assert.ok(card.text.includes("HEAD"));
  assert.ok(card.text.includes("📎 END T"));
  const clip = card.entities.find((e) => e.type === "custom_emoji");
  assert.ok(clip && card.text.slice(clip.offset, clip.offset + clip.length) === "📎", "custom emoji stays glued after strip");
  for (const e of card.entities) assert.ok(e.offset + e.length <= card.text.length);
  // one social present → only that line survives, header stays
  const partial = fmt.trendingPost({ name: "T", symbol: "T", chain: "solana", address: "So1", links: { website: "https://t.io" } });
  assert.ok(partial.text.includes("social links"));
  assert.ok(partial.text.includes("Website"));
  assert.ok(!/❌ X/.test(partial.text), partial.text);
  await tpl.resetTemplate("post_trending");
});
