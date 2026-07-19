// bannerTemplate — fourtis-style artwork compositor. Uses an isolated data dir
// so tests never touch real runtime state.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-bt-"));

const test = require("node:test");
const assert = require("node:assert");
const bt = require("../src/bannerTemplate");

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

function makePng(w, h, color) {
  const cv = require("@napi-rs/canvas");
  const c = cv.createCanvas(w, h);
  const g = c.getContext("2d");
  g.fillStyle = color;
  g.fillRect(0, 0, w, h);
  return c.toBuffer("image/png");
}

test("no template uploaded → hasTemplate false, compose null (fallback path)", async () => {
  assert.strictEqual(bt.hasTemplate("listing"), false);
  assert.strictEqual(await bt.compose("listing", null, { symbol: "X" }), null);
});

test("settings load defaults and persist updates per kind", async () => {
  const s = bt.getSettings("listing");
  assert.strictEqual(s.logoSize, 180);
  await bt.updateSettings("listing", { logoSize: 220, logoX: 900, logoY: 200 });
  const s2 = bt.getSettings("listing");
  assert.strictEqual(s2.logoSize, 220);
  assert.strictEqual(s2.logoX, 900);
  // trending untouched
  assert.strictEqual(bt.getSettings("trending").logoSize, 180);
});

test("saveTemplate + compose → PNG with logo composited; remove → null again", async () => {
  await bt.saveTemplate("listing", makePng(600, 300, "#101820"));
  assert.strictEqual(bt.hasTemplate("listing"), true);
  const logo = makePng(100, 100, "#ff0000");
  const out = await bt.compose("listing", logo, { symbol: "JIM", name: "Jimothy" });
  assert.ok(Buffer.isBuffer(out) && out.length > 500);
  assert.ok(out.subarray(0, 4).equals(PNG_MAGIC));
  // compose never throws on a broken logo buffer — artwork still posts
  const out2 = await bt.compose("listing", Buffer.from([1, 2, 3]), { symbol: "JIM" });
  assert.ok(Buffer.isBuffer(out2));
  await bt.removeTemplate("listing");
  assert.strictEqual(await bt.compose("listing", logo, { symbol: "JIM" }), null);
});
