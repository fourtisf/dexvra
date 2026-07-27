// The Auto Trending panel showed six steppers crammed onto two rows, which
// Telegram truncated to "🕐 Mi…" and "Max 1…" — settings nobody could read, let
// alone change with confidence. And it printed the CONFIG without ever printing
// the BOARD, so the question the operator actually had ("why is Robinhood still
// empty?") had no answer anywhere on screen.
//
// These render the real panel, because the layout IS the thing that was wrong.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-atpanel-"));

const test = require("node:test");
const assert = require("node:assert");

const autoTrend = require("../src/services/autoTrend");
const admin = require("../src/admin/adminBot");

const plain = (s) => String(s).replace(/<\/?(b|i|code)>/g, "");
const rows = (kb) => kb.reply_markup.inline_keyboard.map((r) => r.map((b) => b.text));
/** A board where every interesting state is present at once. */
const COUNTS = {
  solana: { featured: 5, eligible: 12 }, // at target
  bsc: { featured: 1, eligible: 4 }, // short, fixable
  ethereum: { featured: 1, eligible: 0 }, // short, nothing left
  base: { featured: 1, eligible: 8 },
  robinhood: { featured: 0, eligible: 0 }, // empty and unfixable
  tron: { featured: 0, eligible: 2 }, // not auto-trended, but has listings
  sui: { featured: 0, eligible: 0 }, // nothing at all
};
async function panel(counts = COUNTS, cfg = {}) {
  await autoTrend.set({ enabled: true, perChain: 5, ...cfg });
  admin._test.setAtCounts(counts);
  return { text: plain(admin._test.atText()), kb: rows(admin._test.atKb()) };
}

test("no button label is long enough for Telegram to truncate", () => {
  // THE bug, measured. Telegram cuts a label to fit its share of the row, so a
  // six-button row loses the words and keeps the emoji: "🕐 Mi…".
  return panel().then(({ kb }) => {
    for (const row of kb) {
      assert.ok(row.length <= 3, `${row.length} buttons in one row: ${row.join(" | ")}`);
      for (const label of row) {
        // Three per row leaves roughly 16 chars each before Telegram elides.
        const budget = row.length === 1 ? 40 : row.length === 2 ? 22 : 16;
        assert.ok(label.length <= budget, `"${label}" is ${label.length} chars in a row of ${row.length}`);
      }
    }
  });
});

test("every stepper says what it changes, on its own row", async () => {
  const { kb } = await panel();
  const flat = kb.map((r) => r.join(" "));
  for (const setting of ["🎯 5 per chain", "⏱ Min 3h", "⏱ Max 18h", "🔁 Every 20m", "🔁 to 120m"]) {
    const row = kb.find((r) => r.includes(setting));
    assert.ok(row, `no row for "${setting}" — labels: ${flat.join(" / ")}`);
    assert.deepStrictEqual(row, ["➖", setting, "➕"], `"${setting}" must sit between its own two steppers`);
  }
});

test("the panel shows the BOARD, not just the settings", async () => {
  // The operator's question is "is it working", and the config cannot answer it.
  const { text } = await panel();
  assert.match(text, /📊 Board right now — target 5 per chain/);
  assert.match(text, /✅ .*Solana — 5\/5/, text);
  assert.match(text, /⏳ .*BSC — 1\/5 · 4 ready to promote/, text);
  assert.match(text, /🔴 .*Robinhood — 0\/5 · no listings left on this chain/, text);
});

test("a chain that cannot be filled is distinguished from one that just has not been yet", async () => {
  // Identical on screen before this: both simply absent from the board. One
  // needs patience, the other needs listings, and the operator cannot act
  // correctly without knowing which.
  const { text } = await panel();
  assert.match(text, /cannot be filled — they have no spare listings/);
  assert.match(text, /needs more tokens listed there, not another cycle/);

  // Every configured chain short but with spare listings — nothing is blocked,
  // so the panel must promise a cycle rather than ask for more listings.
  const fixable = await panel(
    Object.fromEntries(autoTrend.get().chains.map((id) => [id, { featured: 1, eligible: 9 }])),
  );
  assert.match(fixable.text, /below target; the next cycle tops them up/);
  assert.ok(!fixable.text.includes("cannot be filled"), "nothing here is blocked");
});

test("when everything is at target it says so, instead of leaving the reader to check five lines", async () => {
  const at = Object.fromEntries(autoTrend.get().chains.map((id) => [id, { featured: 5, eligible: 3 }]));
  const { text } = await panel(at);
  assert.match(text, /Every chain is at target\. Nothing to do until a slot expires\./);
});

test("the Run now buttons lead with the chains the panel is about", async () => {
  const { kb } = await panel();
  const runs = kb.flat().filter((t) => t.startsWith("⚡"));
  const cfg = autoTrend.get();
  for (let i = 0; i < cfg.chains.length; i++) {
    assert.ok(runs[i], `missing a Run now button for ${cfg.chains[i]}`);
    assert.match(runs[i], /\d\/5$/, `an auto-filled chain must show its progress: ${runs[i]}`);
  }
});

test("chains nobody has listed on are dropped, not printed as '0/5'", async () => {
  // The list was 20 rows of "0/5" for networks with no listings at all. A Run
  // now there can only fail, and the fraction invents a target the chain has no
  // part in.
  const { kb } = await panel();
  const runs = kb.flat().filter((t) => t.startsWith("⚡"));
  assert.ok(!runs.some((t) => t.includes("Sui")), `Sui has nothing listed: ${runs.join(" | ")}`);
  // Tron is not auto-trended but DOES have listings — still one tap away, and
  // deliberately without a fraction.
  const tron = runs.find((t) => t.includes("Tron"));
  assert.ok(tron, `Tron has listings and must stay reachable: ${runs.join(" | ")}`);
  assert.ok(!/\/\d/.test(tron), `a chain with no target must not show one: ${tron}`);
});

test("the board can be re-read without reopening the menu", async () => {
  // It is a snapshot taken when the panel opened; after a Run now, or after
  // waiting out a cycle, re-reading it is the whole point.
  const { kb } = await panel();
  assert.ok(kb.flat().includes("🔄 Refresh"), kb.flat().join(" | "));
  const src = fss.readFileSync(require.resolve("../src/admin/adminBot.js"), "utf8");
  assert.match(src, /bot\.action\("atref", async \(ctx\) => \{/);
  assert.match(src, /_atCounts = await autoTrend\.featuredByChain\(\)/);
});

test("changing the per-chain target moves every number on the panel together", async () => {
  const { text, kb } = await panel(COUNTS, { perChain: 6 });
  assert.match(text, /target 6 per chain/);
  assert.match(text, /Solana — 5\/6/, "at 5 it is no longer at target");
  assert.ok(kb.flat().includes("🎯 6 per chain"));
  assert.ok(kb.flat().some((t) => t.includes("Solana 5/6")), kb.flat().join(" | "));
  await autoTrend.set({ perChain: 5 });
});

test("an Xpress-only chain reads as sellable, never as 'can never trend'", async () => {
  // Two wrong readings had to go. "No listings left" sent the operator off to
  // list more, which would not have helped. And "never auto-promoted" read as
  // "Xpress can never trend" — false, and the kind of false that loses a sale:
  // any listed token, on any package, can BUY Trending and gets it.
  const { text } = await panel({
    solana: { featured: 5, eligible: 3, blocked: 0 },
    bsc: { featured: 2, eligible: 0, blocked: 3 },
    ethereum: { featured: 5, eligible: 1, blocked: 0 },
    base: { featured: 5, eligible: 1, blocked: 0 },
    robinhood: { featured: 5, eligible: 1, blocked: 0 },
  });
  assert.match(text, /⚡ .*BSC — 2\/5 · 3 Xpress — auto-fill skips them; tap ⚡ below to place one now/, text);
  assert.match(text, /Run now.*places one anyway/s, text);
  assert.match(text, /any package can buy Trending and will get it/, text);
  assert.ok(!text.includes("no spare listings"), "there ARE listings here");
  assert.ok(!/never auto-promoted|cannot be filled/.test(text), "nothing here is permanently stuck");
});


test("a chain with genuinely nothing listed still reads as nothing listed", async () => {
  const { text } = await panel({
    solana: { featured: 5, eligible: 3, blocked: 0 },
    bsc: { featured: 5, eligible: 1, blocked: 0 },
    ethereum: { featured: 5, eligible: 1, blocked: 0 },
    base: { featured: 5, eligible: 1, blocked: 0 },
    robinhood: { featured: 0, eligible: 0, blocked: 0 },
  });
  assert.match(text, /🔴 .*Robinhood — 0\/5 · no listings left on this chain/, text);
  assert.match(text, /needs more tokens listed there/, text);
  assert.ok(!text.includes("Xpress"), "nothing here is blocked by a tier rule");
});
