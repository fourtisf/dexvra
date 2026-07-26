// The ad slot is where the advertiser's creative lands inside the template
// frame. Two things went wrong at once on a custom "Banner Live" template: the
// creative sat right of the frame's centre with dead black space down the left,
// and the one control that fixes that was not reachable from the admin bot.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
const dir = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-slot-"));
process.env.BOT_DATA_DIR = dir;

const test = require("node:test");
const assert = require("node:assert");
const bannerTpl = require("../src/bannerTemplate");

const admin = fss.readFileSync(require.resolve("../src/admin/adminBot.js"), "utf8");

test("with the BUNDLED artwork the slot keeps its measured coordinates", () => {
  // Those numbers were measured against the bundled frame (left:410 top:140 at
  // 1280×640, ×2). Centring them would break the artwork that ships with the bot.
  const s = bannerTpl.getSettings("banner");
  assert.strictEqual(s.slotShape, "rect");
  assert.strictEqual(s.logoX, 836);
  assert.strictEqual(s.logoY, 296);
});

test("once the operator uploads their own template the slot starts centred", () => {
  // We no longer know where THEIR frame is, so the bundled coordinates stop
  // being a default and become a wrong guess. Centre is the only defensible
  // starting point for an unknown design.
  fss.writeFileSync(path.join(dir, "banner-media-banner.mp4"), "clip");
  delete require.cache[require.resolve("../src/bannerTemplate")];
  const fresh = require("../src/bannerTemplate");
  const s = fresh.getSettings("banner");
  assert.strictEqual(s.logoX, "center");
  assert.strictEqual(s.logoY, "center");
  assert.strictEqual(s.slotW, 1548, "only the position is a guess — the size is not touched");
});

test("an explicit admin tweak still beats the centred default", async () => {
  delete require.cache[require.resolve("../src/bannerTemplate")];
  const fresh = require("../src/bannerTemplate");
  await fresh.updateSettings("banner", { logoX: 700 });
  assert.strictEqual(fresh.getSettings("banner").logoX, 700, "the operator's own positioning wins");
});

test("the slot editor exposes centring — the control that fixes dead space", () => {
  // bxc/bxsn already handled elem "slot"; the buttons were simply never
  // rendered in the slot branch, so a 300px move meant ~15 taps of ➡ and
  // centring was impossible.
  const kb = admin.slice(admin.indexOf("function bxElemKb"));
  const slotKb = kb.slice(0, kb.indexOf("const c = BX[elem];"));
  assert.match(slotKb, /bxc:\$\{kind\}:slot/, "⬌ Centre must be reachable");
  assert.match(slotKb, /bxcy:\$\{kind\}:slot/, "⬍ Centre too — a frame is centred on both axes");
  assert.match(slotKb, /bxsn:\$\{kind\}:slot/, "and exact W×H entry, so a big resize is one message");
});

test("vertical centring is wired, not just drawn", () => {
  assert.match(admin, /\^bxcy:\$\{KL\}:\$\{EX\}\$/, "the handler exists");
  const h = admin.slice(admin.indexOf("bxcy:${KL}"), admin.indexOf("bxcy:${KL}") + 600);
  assert.match(h, /yKey: "logoY"/, "…and centres the slot on Y");
  assert.match(h, /\[c\.yKey\]: "center"/);
});

test("both axes accept `center` when typed by hand", () => {
  // The parser always allowed it; the prompt and the error only mentioned X,
  // which is how an operator concludes it cannot be done.
  assert.match(admin, /\^\(center\|-\?\\d\+\)\\s\*,\\s\*\(center\|-\?\\d\+\)\$/);
  assert.match(admin, /Or write <code>center<\/code> instead of a number/, "the prompt says so");
  assert.match(admin, /Or: <code>center,center<\/code>/, "and so does the error");
});

test("the editor says where the box sits, in words a beginner reads instantly", () => {
  // 1548x760 at (836, 296) tells an operator nothing about whether that is
  // inside their frame. The empty space on each side does. And the operator
  // asked outright what "Wider" meant, so no comparatives and no jargon.
  const t = admin.slice(admin.indexOf("the box for the client's picture") - 200);
  assert.match(t, /Empty space:/, "says how much room is left on each side");
  assert.match(t, /more empty space on the/, "and which side has more");
  assert.match(t, /The box is in the middle/);
  assert.match(t, /always fills the whole box/, "and that empty space means the box is wrong");
  assert.match(t, /What the buttons do/, "every button is explained on the same screen");
  for (const banned of ["cover-fit", "canvas", "Narrower", "Shorter", "Wider", "Taller"]) {
    assert.ok(!t.slice(0, 1600).includes(banned), `"${banned}" is exactly the wording that was not understood`);
  }
});

test("the buttons name the thing, not the comparison", () => {
  const kb = admin.slice(admin.indexOf("function bxElemKb"));
  const slotKb = kb.slice(0, kb.indexOf("const c = BX[elem];"));
  assert.match(slotKb, /"Width ➕"/);
  assert.match(slotKb, /"Height ➖"/);
  assert.match(slotKb, /"⌨ Set size"/);
  assert.match(slotKb, /"⌨ Set place"/);
  // Only the LABELS — the comment above them quotes the old words on purpose,
  // to explain to the next reader why they were replaced.
  const labels = [...slotKb.matchAll(/cb\("([^"]+)"/g)].map((m) => m[1]);
  assert.ok(labels.length >= 8, `expected the slot keyboard's labels, got ${labels.length}`);
  for (const banned of ["Wider", "Narrower", "Taller", "Shorter", "Type W×H", "Type X,Y"]) {
    assert.ok(!labels.includes(banned), `button label "${banned}" needs translating before it can be acted on`);
  }
});
