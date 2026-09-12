// "harus pakai emoji premium kaya fourtis" — and it already does, because a DM
// is a PRIVATE chat.
//
// Telegram's rule: a bot may use custom-emoji entities if it holds a Fragment
// username, OR "in the messages directly sent by the bot to private, group and
// supergroup chats if the OWNER of the bot has a Telegram Premium
// subscription". A CHANNEL is in neither list — which is the whole reason
// channels/post.js reaches for the GramJS premium account, and the reason
// premium.js's old header said animation needs it. Applying that sentence to a
// DM is what made this feature read as unable to do something it does by
// itself.
//
// So nothing here makes the emoji animate; that is the BotFather owner's
// Premium. What IS this module's job is the pair of rules below: say which way
// it went, and never let the emoji cost the broadcast.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-mdprem-"));

const test = require("node:test");
const assert = require("node:assert");

const sender = require("../src/massdm/sender");
const store = require("../src/massdm/store");

const EMO = (id) => ({ type: "custom_emoji", offset: 0, length: 2, custom_emoji_id: id });
const job = (over = {}) => ({
  id: "j1",
  text: "gm 🔶 Dexvra",
  entities: [EMO("1"), EMO("2"), { type: "bold", offset: 3, length: 6 }],
  mediaPath: null,
  mediaFileId: null,
  mediaType: "photo",
  targets: [1, 2, 3],
  total: 3,
  sent: 0,
  failed: 0,
  cursor: 0,
  ref: "MD-1",
  reportChatId: 99,
  createdBy: null,
  // ⚠️ LAST, and its absence is what the first cut of this file got wrong: the
  // helper took an `over` argument and never spread it, so every test that
  // customised a job silently asserted against the DEFAULT one — and the
  // emoji-free case reported a premium verdict it could not have produced. A
  // test measuring its own fake, which is why the two that used it failed.
  ...over,
});

/**
 * A Telegram that behaves one of the three ways a real one can.
 *  "premium"  — accepts the entities and echoes them (the owner has Premium)
 *  "stripped" — accepts the message, echoes it WITHOUT the custom emoji
 *  "refused"  — rejects any message carrying them
 */
function tg(mode) {
  const sent = [];
  const reports = [];
  const reply = (extra) => {
    const ents = extra.entities || extra.caption_entities || [];
    const custom = ents.filter((e) => e.type === "custom_emoji");
    if (custom.length && mode === "refused") throw new Error("400: Bad Request: CUSTOM_EMOJI_INVALID");
    return { message_id: sent.length, entities: mode === "stripped" ? ents.filter((e) => e.type !== "custom_emoji") : ents };
  };
  return {
    sent,
    reports,
    sendMessage: async (chat, text, extra = {}) => {
      if (chat === 99) {
        reports.push(text);
        return { message_id: 0 };
      }
      sent.push({ chat, extra });
      return reply(extra);
    },
    sendPhoto: async (chat, media, extra = {}) => {
      sent.push({ chat, extra, photo: true });
      const m = reply(extra);
      return { ...m, photo: [{ file_id: "F1" }] };
    },
  };
}

async function run(mode, over) {
  const j = job(over);
  const t = tg(mode);
  const real = store.saveJob;
  store.saveJob = async () => {};
  try {
    await sender.runJob(t, j);
  } finally {
    store.saveJob = real;
  }
  return { job: j, tg: t, report: t.reports.join("\n") };
}

// ── the verdict is Telegram's, and it is recorded ───────────────────────────

test("⚠️ a bot whose owner HAS Premium: the emoji go out and the report says so", async () => {
  const { job: j, tg: t, report } = await run("premium");
  assert.strictEqual(j.sent, 3, "everyone was reached");
  assert.strictEqual(j.failed, 0);
  const wire = t.sent[0].extra;
  assert.strictEqual(wire.parse_mode, undefined, "entities are sent as entities, never re-parsed");
  assert.strictEqual(sender._customCount(wire.entities), 2, "both custom emoji reached the wire");
  assert.strictEqual(j.premiumOut, true);
  assert.match(report, /Premium emoji:<\/b> ✅ 2 accepted/);
});

// ⚠️ A PLAIN SEND MAY NEVER RENDER AS A ✅ — to anyone without Telegram Premium
// the two are identical, so the report is the only thing that can tell them
// apart. The trending board's 🔄 Refresh had to learn exactly this.
test("⚠️ a bot whose owner does NOT: Telegram strips them, and that is NOT a ✅", async () => {
  const { job: j, report } = await run("stripped");
  assert.strictEqual(j.sent, 3, "the message still goes out — a downgrade, not a failure");
  assert.strictEqual(j.premiumOut, false);
  assert.match(report, /Premium emoji:<\/b> ⚠️ PLAIN/);
  assert.match(report, /OWNER needs Telegram Premium/, "the report names what is missing");
  assert.ok(!/✅/.test(report.split("Premium emoji")[1] || ""), "never a tick over a plain send");
});

// ⚠️ The one that costs money: 12,000 sends failing identically over an entity.
test("⚠️ a REFUSAL never costs the broadcast — it is resent plain", async () => {
  // More targets than BROADCAST_CONCURRENCY, deliberately: the batches after
  // the first are what prove the strip was JOB-WIDE rather than per-recipient.
  const { BROADCAST_CONCURRENCY: CONC } = require("../src/config/constants");
  const targets = Array.from({ length: CONC * 3 }, (_, i) => i + 1);
  const { job: j, tg: t, report } = await run("refused", { targets, total: targets.length });
  assert.strictEqual(j.sent, targets.length, "everyone was still reached");
  assert.strictEqual(j.failed, 0, "a paid broadcast may not reach nobody over an emoji");
  assert.strictEqual(sender._customCount(j.entities), 0, "stripped job-wide, not per recipient");
  assert.ok(
    j.entities.some((e) => e.type === "bold"),
    "⚠️ ONLY the custom emoji go — the bold runs and links are not collateral",
  );
  assert.strictEqual(j.premiumOut, false);
  assert.match(report, /REFUSED/);
  // The FIRST batch is already in flight when the first refusal lands, so up to
  // CONC of them pay a wasted attempt. Every batch after it costs nothing —
  // which is the whole difference between a job-wide strip and a per-send one.
  assert.ok(
    t.sent.length <= targets.length + CONC,
    `only the first batch may retry — ${t.sent.length} sends for ${targets.length} targets`,
  );
});

test("…and a job with no custom emoji says nothing about them at all", async () => {
  const { job: j, report } = await run("premium", { entities: [{ type: "bold", offset: 0, length: 2 }] });
  assert.strictEqual(j.premiumOut, undefined, "a verdict on nothing is noise");
  assert.ok(!/Premium emoji/.test(report));
});

test("the verdict is read once, from the FIRST send", async () => {
  // It is a property of the BOT, not of the recipient: 12,000 identical
  // readings are one reading, and re-deciding per send would let a late
  // failure overwrite a true answer.
  const j = job();
  sender._notePremium(j, { entities: [EMO("1"), EMO("2")] });
  assert.strictEqual(j.premiumOut, true);
  sender._notePremium(j, { entities: [] }); // a later message with none
  assert.strictEqual(j.premiumOut, true, "the first answer stands");
});

// ⚠️ What the echo CANNOT say. Telegram accepting the entity is not the same as
// a given reader seeing it animated — that is their own Premium, client-side.
// Claiming it would be a fact nobody measured.
test("⚠️ the media path records it too — a photo job's first send is primeMedia", async () => {
  // ⚠️ ONE TARGET, and that is the whole point of the fixture. primeMedia sends
  // the first recipient itself and the batch loop starts at the cursor it left,
  // so on a wider job sendOne records the verdict anyway and removing
  // primeMedia's own call changes nothing — a mutation run said exactly that.
  // A single-recipient media job (an admin test run reaches one inbox) is the
  // shape where that call is the ONLY one, so it is the shape that proves it.
  const { job: j, report } = await run("stripped", { mediaPath: "/tmp/x.png", targets: [7], total: 1 });
  assert.strictEqual(j.sent, 1, "primeMedia is the only send this job makes");
  assert.strictEqual(j.premiumOut, false, "the caption's entities are judged the same way");
  assert.match(report, /PLAIN/);
});
