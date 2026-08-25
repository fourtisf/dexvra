// The ⏳ pace controls on the Auto Listing panel, driven through REAL Telegraf
// updates.
//
// The reason this is a separate file from autoListerPace.test.js: a service
// test proves the engine paces, and says nothing about whether an operator can
// reach the setting. `alchKb()` once shipped with `cb` undefined — the module
// required cleanly, every service test was green, and each tap answered and
// then threw inside bot.catch, i.e. a button that visibly did nothing, live.
// Only DISPATCHING the tap fails on that revision.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
process.env.BOT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "dexvra-alpacepanel-"));
process.env.ADMIN_BOT_TOKEN = process.env.ADMIN_BOT_TOKEN || "123456:TEST_ALPACE_PANEL";

const test = require("node:test");
const assert = require("node:assert");

const { Telegram } = require("telegraf");
const adminBot = require("../src/admin/adminBot");
const autoLister = require("../src/services/autoLister");
const { ADMIN_IDS } = require("../src/config/constants");

const ADMIN = { id: Number(ADMIN_IDS[0]), is_bot: false, first_name: "Owner", username: "owner" };
const CHAT = { id: 4242, type: "private" };
const REAL_CALL_API = Telegram.prototype.callApi;

function harness() {
  const bot = adminBot.build();
  bot.botInfo = { id: 777, is_bot: true, first_name: "Dexvra Admin", username: "dexvraadminbot" };
  // A handler that throws must FAIL the test — swallowing it is exactly how the
  // live `cb undefined` bug looked healthy from every angle but the operator's.
  let thrown = null;
  bot.catch((e) => {
    thrown = e;
  });
  const calls = [];
  let mid = 100;
  Telegram.prototype.callApi = async function (method, payload) {
    calls.push({ method, payload });
    if (method === "sendMessage") return { message_id: ++mid, date: 0, chat: CHAT, text: payload && payload.text };
    return true;
  };
  let uid = 0;
  const tap = async (data) => {
    await bot.handleUpdate({
      update_id: ++uid,
      callback_query: {
        id: String(++uid),
        from: ADMIN,
        chat_instance: "1",
        data,
        message: { message_id: ++mid, date: 0, chat: CHAT, from: ADMIN, text: "panel" },
      },
    });
    if (thrown) throw thrown;
  };
  const edits = () => calls.filter((c) => c.method === "editMessageText");
  const answers = () => calls.filter((c) => c.method === "answerCallbackQuery");
  const lastText = () => {
    const e = edits();
    return e.length ? e[e.length - 1].payload.text : "";
  };
  const buttons = () => {
    const e = edits();
    return e.length ? e[e.length - 1].payload.reply_markup.inline_keyboard.flat() : [];
  };
  return { tap, edits, answers, lastText, buttons, calls };
}

const restore = () => {
  Telegram.prototype.callApi = REAL_CALL_API;
};

test("the panel states the pace, and drops the per-scan number it makes impossible", async (t) => {
  t.after(restore);
  await autoLister.reset();
  await autoLister.resetState();
  await autoLister.set({ maxPerRun: 3, maxPerDay: 12 });
  const h = harness();
  await h.tap("al");
  const txt = h.lastText();
  assert.match(txt, /Listing pace: 🟢 one free listing every 2h–3h/);
  // The arithmetic, out loud: "1 every 2h–3h" and "12/day" govern one feed and
  // it is not obvious which binds. The 🧲 "max 3/chain" label was misread for
  // exactly this reason.
  assert.match(txt, /a day/, "the panel must reconcile the pace against the daily cap itself");
  assert.ok(!/<b>3<\/b>\/scan/.test(txt), "a paced scan lists at most one — the panel must not offer 3");
  assert.match(txt, /🔢 Max <b>12<\/b>\/day/, "the daily cap still applies and is still shown");
});

test("the pace band is reachable and every tap ANSWERS and re-renders", async (t) => {
  t.after(restore);
  await autoLister.reset();
  await autoLister.resetState();
  const h = harness();
  await h.tap("al");
  const labels = h.buttons().map((b) => b.text);
  assert.ok(
    labels.some((l) => /Pace: 1 every 2h–3h/.test(l)),
    `no pace toggle on the panel: ${labels.join(" | ")}`,
  );
  assert.ok(labels.some((l) => /Every 2h/.test(l)) && labels.some((l) => /to 3h/.test(l)), "no band rows");

  const before = h.edits().length;
  await h.tap("alpmin:30");
  assert.strictEqual(autoLister.get().minListGapMin, 150);
  assert.ok(h.edits().length > before, "a tap must EDIT the panel, not only answer");
  assert.ok(h.answers().length >= 2, "…and it must answer, or the button spins");
  assert.match(h.answers().pop().payload.text, /2h30m–3h/, "the whole BAND is reported, not just the end tapped");

  await h.tap("alpmax:-120");
  const c = autoLister.get();
  // Dropping the ceiling under the floor moves the ceiling to the floor. An
  // answer naming one number while the other moved is the ✅-carrying-a-number-
  // nobody-asked-for defect the gainers settings paid for.
  assert.strictEqual(c.maxListGapMin, 150);
  // …and the note names the right REFUSAL: 1h is well inside the rails, it is
  // the 2h30m floor that pins it. Pointing at the limits would send the
  // operator to change the wrong setting.
  const said = h.answers().pop().payload.text;
  assert.match(said, /one every 2h30m/);
  assert.match(said, /ceiling under the 2h30m floor/);
  assert.ok(!/outside the limits/.test(said), "1h is not outside the limits — that is a different refusal");
});

test("the band cannot be pushed outside its rails, and a refused value SAYS so", async (t) => {
  t.after(restore);
  await autoLister.reset();
  await autoLister.resetState();
  const h = harness();
  await h.tap("al");
  for (let i = 0; i < 6; i++) await h.tap("alpmin:-30"); // 120 → below zero
  assert.strictEqual(autoLister.get().minListGapMin, 0, "0 is the floor, and it is legal");
  const last = h.answers().pop().payload.text;
  assert.match(last, /a negative wait is outside the limits/, "a clamped value is not answered as if it were stored");
});

test("turning the pace OFF is a show_alert that says what the feed will do", async (t) => {
  t.after(restore);
  await autoLister.reset();
  await autoLister.resetState();
  await autoLister.set({ maxPerRun: 3, maxPerDay: 12 });
  const h = harness();
  await h.tap("al");
  await h.tap("alpace");
  assert.strictEqual(autoLister.get().paceListings, false);
  const a = h.answers().pop().payload;
  assert.strictEqual(a.show_alert, true, "it changes what the PUBLIC feed does — a toast is furniture");
  assert.match(a.text, /3 listings can go out in one scan/);
  assert.match(a.text, /12\/day/, "…and names what is left holding it back");

  const txt = h.lastText();
  assert.match(txt, /Listing pace: 🔴 OFF/);
  assert.match(txt, /<b>3<\/b>\/scan/, "with the pace off the burst size is back on screen");
  // The band rows are hidden: a setting that governs nothing is one an operator
  // can change and never see act.
  assert.ok(!h.buttons().some((b) => /Every 2h/.test(b.text)), "the band rows must be hidden while it is off");

  await h.tap("alpace");
  assert.strictEqual(autoLister.get().paceListings, true);
  assert.notStrictEqual(h.answers().pop().payload.show_alert, true, "turning it ON needs no alert");
});

test("no bare '<' can reach Telegram — one would make it reject the whole panel", async (t) => {
  t.after(restore);
  await autoLister.reset();
  await autoLister.resetState();
  const h = harness();
  // The states whose copy is generated rather than fixed: no floor, a wait
  // longer than a day, a daily cap the pace cannot reach, and the pace off.
  const cases = [
    { minListGapMin: 0, maxListGapMin: 180 },
    { minListGapMin: 1440, maxListGapMin: 4320 },
    { minListGapMin: 30, maxListGapMin: 30, maxPerDay: 2 },
    { paceListings: false },
  ];
  for (const cfg of cases) {
    await autoLister.set(cfg);
    await h.tap("al");
    const bare = h.lastText().replace(/<\/?(?:b|i|u|s|a|code|pre)(?:\s[^>]*)?>/g, "");
    assert.ok(!bare.includes("<"), `a literal "<" survives for ${JSON.stringify(cfg)}: ${bare.slice(0, 300)}`);
  }
});
