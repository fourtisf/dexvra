// ✏️ Typing a value instead of tapping ➖/➕ twenty-two times.
//
// "angkanya contoh kan 1 m nah itu bisa di ketik biar cpt" (2026-08-26) — the
// trigger ceiling steps in $100,000, so $1M → $3.2M was twenty-two taps.
//
// The property most worth pinning is NOT that typing works. It is that a value
// the bot cannot read changes NOTHING and says so. `clampInt` answers a
// non-finite value with the shipped default, so a parser that returns a number
// on bad input would store a figure nobody asked for under a ✅ — which is
// exactly what `500k` did to the gainers market-cap floor.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
process.env.BOT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "dexvra-altyped-"));
process.env.ADMIN_BOT_TOKEN = process.env.ADMIN_BOT_TOKEN || "123456:TEST_AL_TYPED";

const test = require("node:test");
const assert = require("node:assert");

const { Telegram } = require("telegraf");
const adminBot = require("../src/admin/adminBot");
const autoLister = require("../src/services/autoLister");
const { ADMIN_IDS } = require("../src/config/constants");

const ADMIN = { id: Number(ADMIN_IDS[0]), is_bot: false, first_name: "Owner", username: "owner" };
const CHAT = { id: 4242, type: "private" };
const REAL_CALL_API = Telegram.prototype.callApi;
const M = 1_000_000;

function harness() {
  const bot = adminBot.build();
  bot.botInfo = { id: 777, is_bot: true, first_name: "Dexvra Admin", username: "dexvraadminbot" };
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
  const throwIf = () => {
    if (thrown) {
      const e = thrown;
      thrown = null;
      throw e;
    }
  };
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
    throwIf();
  };
  const say = async (t) => {
    // Telegram ALWAYS attaches a bot_command entity to a message starting with
    // "/", and Telegraf's bot.command() matches on that entity — not on the
    // text. Without it "/cancel" arrives as ordinary text, bot.command never
    // fires, and a test would report the wait as surviving a cancel that was
    // never delivered. A fake update has to be faithful where the framework
    // looks, or it measures the fake instead of the code.
    const entities = t.startsWith("/")
      ? [{ type: "bot_command", offset: 0, length: t.split(/\s/)[0].length }]
      : undefined;
    await bot.handleUpdate({
      update_id: ++uid,
      message: { message_id: ++mid, date: 0, chat: CHAT, from: ADMIN, text: t, ...(entities ? { entities } : {}) },
    });
    throwIf();
  };
  const sent = () => calls.filter((c) => c.method === "sendMessage");
  const lastSent = () => {
    const m = sent();
    return m.length ? m[m.length - 1].payload.text : "";
  };
  const answers = () => calls.filter((c) => c.method === "answerCallbackQuery");
  const buttons = () => {
    const e = calls.filter((c) => c.method === "editMessageText");
    return e.length ? e[e.length - 1].payload.reply_markup.inline_keyboard.flat() : [];
  };
  return { tap, say, sent, lastSent, answers, buttons };
}

const restore = () => {
  Telegram.prototype.callApi = REAL_CALL_API;
};

async function fresh(cfg = {}) {
  await autoLister.reset();
  await autoLister.resetState();
  return autoLister.set({ enabled: true, ...cfg });
}

// ── The duration parser ─────────────────────────────────────────────────────

test("parseGap is the inverse of fmtGap, and generous about how it is written", () => {
  const g = autoLister.parseGap;
  assert.strictEqual(g("2h"), 120);
  assert.strictEqual(g("2.5h"), 150);
  assert.strictEqual(g("2h30m"), 150);
  assert.strictEqual(g("2h30"), 150);
  assert.strictEqual(g("90m"), 90);
  assert.strictEqual(g("45min"), 45);
  assert.strictEqual(g("4H"), 240);
  assert.strictEqual(g(" 2 h "), 120);
  // The operator here types Indonesian. A parser that refused it would be the
  // bot being pedantic about its own input box.
  assert.strictEqual(g("3jam"), 180);
  assert.strictEqual(g("90 menit"), 90);
  assert.strictEqual(g("1jam30menit"), 90);
  // …and it round-trips whatever fmtGap prints.
  for (const mins of [0, 45, 60, 150, 1440, 10080])
    assert.strictEqual(g(autoLister.fmtGap(mins)), mins, `fmtGap(${mins}) did not survive parseGap`);
});

test("⚠️ a BARE NUMBER is refused — 3 is three minutes or three hours and the difference is 20×", () => {
  assert.strictEqual(autoLister.parseGap("3"), null);
  assert.strictEqual(autoLister.parseGap("120"), null);
  // Being wrong here turns a 2-hour feed into a 2-minute one, which is the
  // firehose the pace exists to prevent. One character of unit is cheaper.
});

test("parseGap returns NULL, never a number, on anything it cannot read", () => {
  for (const bad of ["", "abc", "2x", "h", "m", "2h30x", "-2h", "1.2.3h", "2h m", null, undefined, {}, []])
    assert.strictEqual(autoLister.parseGap(bad), null, `parseGap(${JSON.stringify(bad)}) invented a number`);
});

// ── The panel ───────────────────────────────────────────────────────────────

test("every value row is a typed input, and the money labels no longer truncate", async (t) => {
  t.after(restore);
  await fresh({ pkgs: ["trending"] });
  const h = harness();
  await h.tap("al");
  const labels = h.buttons().map((b) => b.text);
  const datas = h.buttons().map((b) => b.callback_data);

  // Every row an operator would otherwise tap ±20 times.
  for (const key of ["minMcap", "maxMcap", "minLiq", "minVol24", "maxPerDay", "trendHours", "minListGapMin", "maxListGapMin"])
    assert.ok(datas.includes(`alset:${key}`), `no typed input for ${key}: ${datas.join(" ")}`);

  // ⚠️ `$1,000,000` renders as "From $1,000,0…" on a phone — the one row whose
  // job is showing a value showed everything but its last digits.
  const from = labels.find((l) => /From/.test(l));
  assert.match(from, /\$1\.00M/, `the money label is not compact: ${from}`);
  assert.ok(from.length < 24, `label still long enough to truncate: ${from}`);
});

test("a tap ARMS the input and stores nothing until the reply lands", async (t) => {
  t.after(restore);
  await fresh();
  const h = harness();
  await h.tap("al");
  await h.tap("alset:maxMcap");
  assert.strictEqual(autoLister.get().maxMcap, 1_500_000, "the tap alone changed the value");
  const prompt = h.lastSent();
  assert.match(prompt, /Trigger to/);
  assert.match(prompt, /sekarang/);
  assert.match(prompt, /3\.2M/, "the prompt must show what a valid value looks like");
  assert.match(prompt, /cancel/);
});

test("typing 3.2M does in one message what took twenty-two taps", async (t) => {
  t.after(restore);
  await fresh();
  const h = harness();
  await h.tap("al");
  await h.tap("alset:maxMcap");
  await h.say("3.2M");
  assert.strictEqual(autoLister.get().maxMcap, 3_200_000);
  assert.match(h.lastSent(), /✅/);
  assert.match(h.lastSent(), /\$3,200,000/);
});

test("the four money rows and the two counts all land through the same door", async (t) => {
  t.after(restore);
  await fresh({ pkgs: ["trending"] });
  const h = harness();
  await h.tap("al");
  for (const [key, typed, expected] of [
    ["minMcap", "1.2m", 1_200_000],
    ["minLiq", "25k", 25_000],
    ["minVol24", "30,000", 30_000],
    ["maxPerDay", "5", 5],
    ["trendHours", "24", 24],
  ]) {
    await h.tap(`alset:${key}`);
    await h.say(typed);
    assert.strictEqual(autoLister.get()[key], expected, `${key} did not take "${typed}"`);
  }
});

test("a duration row takes 2h30m — and reports the whole BAND, not the end that was typed", async (t) => {
  t.after(restore);
  await fresh({ minListGapMin: 120, maxListGapMin: 180 });
  const h = harness();
  await h.tap("al");
  await h.tap("alset:minListGapMin");
  await h.say("2h30m");
  assert.strictEqual(autoLister.get().minListGapMin, 150);
  assert.match(h.lastSent(), /one every 2h30m–3h/, `the band was not reported: ${h.lastSent()}`);

  // Raising the floor past the ceiling moves the ceiling too. An answer naming
  // one number while the other moved sends the operator to the wrong setting.
  await h.tap("alset:minListGapMin");
  await h.say("5h");
  const c = autoLister.get();
  assert.strictEqual(c.minListGapMin, 300);
  assert.strictEqual(c.maxListGapMin, 300);
  assert.match(h.lastSent(), /one every 5h/);
});

// ── The refusals — the point of the whole feature ───────────────────────────

test("⚠️ an unreadable value changes NOTHING and says so — never a ✅ over a default", async (t) => {
  t.after(restore);
  await fresh();
  const h = harness();
  await h.tap("al");
  for (const [key, junk] of [
    ["maxMcap", "tiga juta"],
    ["minLiq", "abc"],
    ["minVol24", "12kk"],
    ["minListGapMin", "2x"],
  ]) {
    const before = autoLister.get()[key];
    await h.tap(`alset:${key}`);
    await h.say(junk);
    assert.strictEqual(autoLister.get()[key], before, `"${junk}" was stored as something for ${key}`);
    assert.match(h.lastSent(), /Tidak ada yang diubah/, `no refusal for "${junk}"`);
    assert.ok(!/✅/.test(h.lastSent()), `"${junk}" was answered with a ✅`);
  }
});

test("⚠️ a bare number on a duration row names BOTH readings rather than guessing", async (t) => {
  t.after(restore);
  await fresh({ minListGapMin: 120, maxListGapMin: 180 });
  const h = harness();
  await h.tap("al");
  await h.tap("alset:minListGapMin");
  await h.say("3");
  assert.strictEqual(autoLister.get().minListGapMin, 120, "a bare number was guessed at");
  const said = h.lastSent();
  assert.match(said, /3 menit/);
  assert.match(said, /3 jam/);
  assert.match(said, /Tidak ada yang diubah/);
});

test("a CLAMPED value is reported as clamped — storing another number under a ✅ is the same defect", async (t) => {
  t.after(restore);
  await fresh();
  const h = harness();
  await h.tap("al");
  // HARD.mcap tops out at $1B.
  await h.tap("alset:maxMcap");
  await h.say("50b");
  assert.strictEqual(autoLister.get().maxMcap, 1_000_000_000);
  assert.match(h.lastSent(), /Disesuaikan dari/, `the clamp was applied silently: ${h.lastSent()}`);
});

test("an old ✏️ button from scrollback answers, and arms nothing", async (t) => {
  t.after(restore);
  await fresh();
  const h = harness();
  await h.tap("al");
  await h.tap("alset:someRowThatIsGone");
  assert.match(h.answers().pop().payload.text, /reopen/i);
  // …and the next plain message must NOT be eaten by a wait that was never armed.
  const before = autoLister.get().maxMcap;
  await h.say("3.2M");
  assert.strictEqual(autoLister.get().maxMcap, before);
});

test("/cancel disarms it, so the next message is not swallowed", async (t) => {
  t.after(restore);
  await fresh();
  const h = harness();
  await h.tap("al");
  await h.tap("alset:maxMcap");
  await h.say("/cancel");
  const before = autoLister.get().maxMcap;
  await h.say("3.2M");
  assert.strictEqual(autoLister.get().maxMcap, before, "the wait survived /cancel and ate the next message");
});
