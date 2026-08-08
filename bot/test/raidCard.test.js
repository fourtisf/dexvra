// The raid card is a pure function — these call it directly.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-card-"));

const test = require("node:test");
const assert = require("node:assert");
const card = require("../src/raid/card");
const tpl = require("../src/templates");

const NOW = Date.parse("2026-08-08T12:33:57Z");

const raidOf = (over = {}) => ({
  status: "running",
  seq: 3,
  crewTarget: 10,
  crewOnly: false,
  baseline: { likes: 200, replies: 10, reposts: 0 },
  target: { likes: 215, replies: 15, reposts: 0 },
  current: { likes: 209, replies: 14, reposts: 0 },
  crew: [{ name: "@ana" }, { name: "@bo" }, { name: "cy" }],
  postText: "gm — like + reply 🚀",
  postUrl: "https://x.com/i/status/20",
  expiresAt: NOW + 42 * 60000,
  ...over,
});

// ── Progress is measured baseline → target ───────────────────────────────────

test("progress runs from the BASELINE, not from zero", () => {
  // A post that already had 200 likes must start the raid with an EMPTY bar.
  // Measuring from zero shows a full bar the instant a raid launches.
  assert.strictEqual(card.progress(200, 200, 215), 0);
  assert.strictEqual(card.progress(215, 200, 215), 1);
  assert.ok(Math.abs(card.progress(209, 200, 215) - 9 / 15) < 1e-9);
});

test("un-liking clamps to zero instead of throwing", () => {
  // A negative fraction would make String.repeat() throw and take the card down.
  assert.strictEqual(card.progress(190, 200, 215), 0);
  assert.doesNotThrow(() => card.bar(-1, card.STYLE_DEFAULT));
});

test("an untracked metric is invisible — target equal to baseline IS 'off'", () => {
  const raid = raidOf();
  assert.deepStrictEqual(card.activeMetrics(raid).map((m) => m.key), ["likes", "replies"]);
  assert.ok(!card.buildProgressBlock(raid).includes("Reposts"));
});

test("a crew-only raid shows no X rows at all", () => {
  const raid = raidOf({ crewOnly: true });
  assert.deepStrictEqual(card.activeMetrics(raid), []);
  const block = card.buildProgressBlock(raid);
  assert.ok(block.includes("Crew"));
  assert.ok(!block.includes("Likes"));
});

test("a raid with no goals whatsoever is never 'complete'", () => {
  const empty = raidOf({ crewTarget: 0, target: { likes: 200, replies: 10, reposts: 0 } });
  assert.strictEqual(card.isComplete(empty), false);
});

test("completion needs EVERY tracked goal, crew included", () => {
  const hitX = raidOf({ current: { likes: 215, replies: 15, reposts: 0 } });
  assert.strictEqual(card.isComplete(hitX), false, "crew is 3/10");
  hitX.crew = Array.from({ length: 10 }, (_, i) => ({ name: `u${i}` }));
  assert.strictEqual(card.isComplete(hitX), true);
});

// ── The signature ────────────────────────────────────────────────────────────

test("the signature ignores the clock, so a poll with no change never edits", () => {
  const raid = raidOf();
  assert.strictEqual(card.signature(raid, "running"), card.signature(raid, "running"));
  // Telegram answers "message is not modified" and the group's edit rate limit
  // gets spent on a redrawn timestamp.
  const later = { ...raid, expiresAt: raid.expiresAt - 60000 };
  assert.strictEqual(card.signature(later, "running"), card.signature(raid, "running"));
});

test("a crew join changes the signature, so the roster repaints", () => {
  const raid = raidOf();
  const before = card.signature(raid, "running");
  raid.crew.push({ name: "@new" });
  assert.notStrictEqual(card.signature(raid, "running"), before);
});

test("the error FLAG is in the signature, its wording is not", () => {
  const raid = raidOf();
  const ok = card.signature(raid, "running");
  raid.lastError = "X rate limit reached";
  const err = card.signature(raid, "running");
  assert.notStrictEqual(err, ok, "the transition itself is worth exactly one edit");
  raid.lastError = "something else entirely";
  assert.strictEqual(card.signature(raid, "running"), err, "a reworded error must not repaint");
});

// ── Style ────────────────────────────────────────────────────────────────────

test("raid_style falls back FIELD BY FIELD, so a typo can never break the card", () => {
  const real = tpl.t;
  try {
    // An admin who types "🟩|⬛" meaning filled|empty gets odd metric icons —
    // and still gets a card.
    tpl.t = (k) => (k === "raid_style" ? "🟩|⬛" : real(k));
    const s = card.raidStyle();
    assert.deepStrictEqual(s, ["🟩", "⬛", "🔁", "🤝", "▰", "▱"]);
    tpl.t = () => "   |||||   ";
    assert.deepStrictEqual(card.raidStyle(), card.STYLE_DEFAULT);
    tpl.t = () => { throw new Error("template layer down"); };
    assert.deepStrictEqual(card.raidStyle(), card.STYLE_DEFAULT);
  } finally {
    tpl.t = real;
  }
});

test("the progress block is PLAIN TEXT — it cannot carry entities", () => {
  // It is inserted into the template as a plain value, so any markup in it
  // would reach the group as literal characters.
  const block = card.buildProgressBlock(raidOf());
  assert.ok(!/[<>]/.test(block));
  assert.ok(!block.includes("**"));
});

// ── Rendering ────────────────────────────────────────────────────────────────

test("the live card shows the goals, the crew and the post", () => {
  const c = card.renderCard(raidOf(), { now: NOW });
  assert.match(c.text, /DEXVRA RAID #3/);
  assert.match(c.text, /57% complete/);
  assert.match(c.text, /209\/215/);
  assert.match(c.text, /Crew: 3/);
  assert.match(c.text, /@ana, @bo, cy/);
  assert.match(c.text, /12:33:57 UTC/);
});

test("only a LIVE card offers the join button", () => {
  const live = card.renderCard(raidOf(), { now: NOW });
  const labels = (r) => r.extra.reply_markup.inline_keyboard.flat().map((b) => b.text);
  assert.ok(labels(live).includes("🙋 Count me in"));
  const done = card.renderCard(raidOf(), { now: NOW, status: "completed" });
  assert.ok(!labels(done).includes("🙋 Count me in"), "a finished card must not invite taps");
  assert.ok(labels(done).some((l) => l.includes("Open the post")));
});

test("each end state renders its own card, and all of them keep the numbers", () => {
  for (const [status, re] of [
    ["completed", /TARGETS HIT/],
    ["expired", /TIME'S UP/],
    ["cancelled", /STOPPED/],
  ]) {
    const c = card.renderCard(raidOf(), { now: NOW, status });
    assert.match(c.text, re);
    assert.match(c.text, /209\/215/, `${status} keeps its numbers — the card is the record`);
  }
});

test("a stale read is LABELLED stale rather than silently frozen", () => {
  const c = card.renderCard(raidOf({ lastError: "X rate limit reached" }), { now: NOW });
  assert.match(c.text, /unavailable/i);
});

test("an X post's text can NEVER inject a link into the card", () => {
  // The post text is whatever anyone chose to tweet, and the card is premium
  // MARKUP — so an un-neutralised "[click me](url)" would become a real,
  // clickable link inside a paying project's pinned card. A scammer needs only
  // to write the tweet.
  const c = card.renderCard(
    raidOf({ postText: "gm **bold** [click me](https://evil.test) `code`" }),
    { now: NOW },
  );
  const links = (c.extra.entities || []).filter((e) => e.type === "text_link");
  assert.deepStrictEqual(links, [], "no link entity may come from the post text");
  assert.ok(!c.text.includes("[click me]"));
});

test("a crew member's display name can NEVER inject a link either", () => {
  // Worse than the post text: anyone can join any raid, and a Telegram display
  // name is free-form.
  const c = card.renderCard(
    raidOf({ crew: [{ name: "[free airdrop](https://evil.test)" }] }),
    { now: NOW },
  );
  const links = (c.extra.entities || []).filter((e) => e.type === "text_link");
  assert.deepStrictEqual(links, []);
});

test("ordinary punctuation in a post still reads normally", () => {
  // The sanitiser must neutralise delimiters without mangling real text.
  const c = card.renderCard(raidOf({ postText: "gm! we're at 90% — let's go (finally)" }), { now: NOW });
  assert.match(c.text, /gm! we're at 90% — let's go \(finally\)/);
});

test("a long post is clipped by CODE POINT, so an emoji is never split", () => {
  const clipped = card.clip("🚀".repeat(200));
  assert.strictEqual(Array.from(clipped).length, 141); // 140 + the ellipsis
  assert.ok(!clipped.includes("�"));
});

test("the roster names at most six people, then counts the rest", () => {
  const raid = raidOf({ crew: Array.from({ length: 9 }, (_, i) => ({ name: `u${i}` })) });
  assert.match(card.rosterOf(raid), /\+3 more$/);
});

test("time left reads in minutes, then hours, and never goes negative", () => {
  assert.strictEqual(card.timeLeft({ expiresAt: NOW + 42 * 60000 }, NOW), "42m");
  assert.strictEqual(card.timeLeft({ expiresAt: NOW + 125 * 60000 }, NOW), "2h 05m");
  assert.strictEqual(card.timeLeft({ expiresAt: NOW - 1 }, NOW), "0m");
});
