// Group buy bot — the volume-diff estimate (incl. the source-switch guard),
// address→chain candidate probing, emoji scaling, and config store.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-grp-"));

const test = require("node:test");
const assert = require("node:assert");
const mon = require("../src/group/buyMonitor");
const setup = require("../src/group/setup");
const cfg = require("../src/group/config");

test("estimateBuys: first observation and no-new-buys return null", () => {
  assert.strictEqual(mon.estimateBuys(null, { buys24h: 10, volume24h: 1000 }), null);
  const prev = { buys24h: 10, sells24h: 5, volume24h: 1000, source: "gt" };
  assert.strictEqual(mon.estimateBuys(prev, { buys24h: 10, sells24h: 5, volume24h: 1000, source: "gt" }), null);
});

test("estimateBuys: apportions the volume delta by buy share", () => {
  const prev = { buys24h: 10, sells24h: 10, volume24h: 1000, source: "gt" };
  // +3 buys, +1 sell, +$800 volume → buyShare 3/4 → $600 over 3 buys
  const est = mon.estimateBuys(prev, { buys24h: 13, sells24h: 11, volume24h: 1800, source: "gt" });
  assert.ok(est);
  assert.strictEqual(est.count, 3);
  assert.strictEqual(est.usd, 600);
  assert.strictEqual(est.avgUsd, 200);
});

test("estimateBuys: a GT↔DexScreener source switch never fabricates a buy", () => {
  const prev = { buys24h: 10, sells24h: 5, volume24h: 1000, source: "ds" };
  // counts/volume look higher only because GT reports a different 24h window
  const cur = { buys24h: 40, sells24h: 20, volume24h: 9000, source: "gt" };
  assert.strictEqual(mon.estimateBuys(prev, cur), null);
});

test("estimateBuys: a 24h-window rollover (counters drop) returns null", () => {
  const prev = { buys24h: 100, sells24h: 50, volume24h: 50000, source: "gt" };
  const cur = { buys24h: 98, sells24h: 49, volume24h: 48000, source: "gt" };
  assert.strictEqual(mon.estimateBuys(prev, cur), null);
});

// 🟢 is a surrogate pair, so string length is 2 per glyph.
const glyphs = (s) => s.length / 2;

test("buyEmojiRow scales with size, and is floored AND capped", () => {
  assert.strictEqual(glyphs(mon.buyEmojiRow(500)), 10); // one per $50
  assert.strictEqual(glyphs(mon.buyEmojiRow(1_000_000)), 16); // capped, never a wall
  assert.strictEqual(glyphs(mon.buyEmojiRow(0)), 3); // floored, never empty
  // The cap is the point: an uncapped row wraps to several lines on a phone and
  // pushes the numbers off the first screen.
  assert.ok(glyphs(mon.buyEmojiRow(9e9)) <= 16);
});

test("candidateChains guesses by address shape", () => {
  assert.deepStrictEqual(setup.candidateChains("0x" + "a".repeat(40)).slice(0, 2), ["ethereum", "bsc"]);
  assert.deepStrictEqual(setup.candidateChains("T" + "1".repeat(33)), ["tron"]);
  assert.deepStrictEqual(setup.candidateChains("EQabcdef"), ["ton"]);
  assert.deepStrictEqual(setup.candidateChains("0xabc::coin::COIN"), ["sui"]);
  assert.deepStrictEqual(setup.candidateChains("So1anaBase58Mint"), ["solana"]);
});

test("config store: upsert, active filter, remove", async () => {
  await cfg.upsert(123, { chain: "solana", address: "AAA", pairAddress: "P", on: true });
  assert.strictEqual(cfg.get(123).address, "AAA");
  assert.strictEqual(cfg.active().length, 1);
  // off → not active
  await cfg.upsert(123, { on: false });
  assert.strictEqual(cfg.active().length, 0);
  // on but no token → not active
  await cfg.upsert(456, { on: true });
  assert.strictEqual(cfg.active().length, 0);
  await cfg.remove(123);
  assert.strictEqual(cfg.get(123), null);
});

// ── The main-menu entry point ────────────────────────────────────────────────

test("the group button opens Telegram's group picker on the FIRST tap", () => {
  // It used to be a callback opening a how-to card whose only real content was
  // another button saying "➕ Add to your group" — one screen between the
  // operator and the thing they had already chosen.
  const { mainMenu } = require("../src/handlers/menu");
  const rows = mainMenu().reply_markup.inline_keyboard;
  const btn = rows.flat().find((b) => /group/i.test(b.text));
  assert.ok(btn, "the group entry is still on the main menu");
  assert.ok(!btn.callback_data, "no intermediate screen");
  assert.match(btn.url, /^https:\/\/t\.me\/[^/?]+\?startgroup=/, "a ?startgroup deep link");
});

test("the deep link points at THIS bot, never a hardcoded handle", () => {
  // Nothing calls getMe, so BOT_USERNAME is used verbatim. Hardcode a handle
  // here and every operator running their own instance is sending their users
  // to add somebody else's bot to their group — and this is now the most-tapped
  // button on the menu, not a link buried two screens deep.
  const { BOT_USERNAME } = require("../src/config/constants");
  const { mainMenu } = require("../src/handlers/menu");
  const btn = mainMenu()
    .reply_markup.inline_keyboard.flat()
    .find((b) => /group/i.test(b.text));
  assert.strictEqual(btn.url, `https://t.me/${BOT_USERNAME}?startgroup=true`);
  const src = fss.readFileSync(path.join(__dirname, "..", "src", "handlers", "menu.js"), "utf8");
  assert.ok(!/t\.me\/dexvrabot/.test(src), "the handle is read from config, not written in");
});

test("landing in a group still explains itself, which is what the skipped card said", () => {
  // Dropping the DM how-to costs nothing because the two in-group messages
  // cover it between them, in the place the work is actually done: group_added
  // (my_chat_member) asks for the rights, group_start (/start) points the bot
  // at a token. Asserted as a PAIR, not against one template — which of the two
  // carries which half is a copy decision, and pinning it to group_start is how
  // this test failed the moment the admin ask moved to where it belongs.
  const tpl = require("../src/templates");
  const flow = tpl.t("group_added") + "\n" + tpl.t("group_start", { bot: "@dexvrabot" });
  assert.match(flow, /settoken/, "it names the command that starts the buy bot");
  assert.match(flow, /admin/i, "and says the bot needs admin rights");
});
