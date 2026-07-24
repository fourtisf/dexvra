// bannerTemplate — fourtis-style artwork compositor. Uses an isolated data dir
// so tests never touch real runtime state.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-bt-"));
// point the bundled-artwork dir at an empty temp dir so tests exercise the
// no-artwork fallback path deterministically
process.env.BANNER_BUNDLED_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-bt-bundled-"));

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
  assert.strictEqual(s.logoSize, bt.DEFAULTS.logoSize);
  await bt.updateSettings("listing", { logoSize: 220, logoX: 900, logoY: 200 });
  const s2 = bt.getSettings("listing");
  assert.strictEqual(s2.logoSize, 220);
  assert.strictEqual(s2.logoX, 900);
  // trending untouched — its own per-kind default (separate from listing)
  assert.strictEqual(bt.getSettings("trending").logoSize, bt.defaultsFor("trending").logoSize);
});

test("bundled artwork acts as fallback; upload overrides it", async () => {
  // drop a 'bundled' artwork into the overridden bundled dir
  fss.writeFileSync(path.join(process.env.BANNER_BUNDLED_DIR, "banner-artwork-trending.png"), makePng(400, 200, "#001122"));
  assert.strictEqual(bt.hasTemplate("trending"), true);
  assert.strictEqual(bt.hasUploaded("trending"), false);
  const viaBundled = await bt.compose("trending", null, { symbol: "T" });
  assert.ok(Buffer.isBuffer(viaBundled));
  await bt.saveTemplate("trending", makePng(500, 250, "#112233"));
  assert.strictEqual(bt.hasUploaded("trending"), true);
  await bt.removeTemplate("trending"); // reverts to bundled, not none
  assert.strictEqual(bt.hasTemplate("trending"), true);
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

test("postingEnabled: env default, admin toggle persists and wins", async () => {
  // default comes from POST_BANNERS env (true in tests)
  assert.strictEqual(typeof bt.postingEnabled(), "boolean");
  await bt.setPostingEnabled(false);
  assert.strictEqual(bt.postingEnabled(), false);
  await bt.setPostingEnabled(true);
  assert.strictEqual(bt.postingEnabled(), true);
  // per-kind settings survive the global toggle write
  await bt.updateSettings("listing", { logoSize: 444 });
  await bt.setPostingEnabled(false);
  assert.strictEqual(bt.getSettings("listing").logoSize, 444);
  await bt.setPostingEnabled(true);
});

test("stale saved layouts (no/old layoutVersion) are ignored — defaults win", async () => {
  const { loadJSONSync, saveJSON } = require("../src/helpers/persist");
  // simulate a config written by an older code version: full frozen snapshot,
  // no layoutVersion, ticker parked at the bottom edge of the old artwork
  const saved = loadJSONSync("bannerTemplate.json", {});
  saved.trending = { logoX: 100, logoY: 1200, tickerY: 1250, logoSize: 999 };
  await saveJSON("bannerTemplate.json", saved);
  const s = bt.getSettings("trending");
  assert.notStrictEqual(s.tickerY, 1250, "stale layout must not survive");
  assert.notStrictEqual(s.logoSize, 999);
  // a fresh edit persists (stamped with the current version) and defaults fill the rest
  const after = await bt.updateSettings("trending", { logoX: 1700 });
  assert.strictEqual(after.logoX, 1700);
  assert.strictEqual(bt.getSettings("trending").logoX, 1700);
  assert.strictEqual(bt.getSettings("trending").logoSize, bt.defaultsFor("trending").logoSize, "untouched keys come from CURRENT defaults");
  await bt.resetSettings("trending");
});

test("Telegram-compressed upload (1280×640) renders on the 2560×1280 reference canvas", async () => {
  // reproduce the live bug: admin uploaded artwork as a PHOTO → Telegram
  // recompressed it to half size → every layout coordinate landed off-canvas
  const cv = require("@napi-rs/canvas");
  const small = cv.createCanvas(1280, 640);
  const sg = small.getContext("2d");
  sg.fillStyle = "#0b1512";
  sg.fillRect(0, 0, 1280, 640);
  await bt.resetSettings("listing"); // earlier tests tweak listing's layout
  await bt.saveTemplate("listing", small.toBuffer("image/png"));
  try {
    const logo = cv.createCanvas(200, 200);
    logo.getContext("2d").fillStyle = "#ff0044";
    logo.getContext("2d").fillRect(0, 0, 200, 200);
    const out = await bt.compose("listing", logo.toBuffer("image/png"), {
      symbol: "SAMPLE", name: "Sample Token", chain: "SOLANA", price: "$1", mcap: "$1M", badge: "Diamond Tier",
    });
    assert.ok(out, "compose must succeed on a small artwork");
    const img = await cv.loadImage(out);
    assert.strictEqual(img.width, 2560, "output must be reference width");
    assert.strictEqual(img.height, 1280, "output must be reference height");
    // the logo slot (1890,410,420) must contain the red logo pixels now
    const chk = cv.createCanvas(2560, 1280);
    const cg = chk.getContext("2d");
    cg.drawImage(img, 0, 0);
    const px = cg.getImageData(2100, 620, 1, 1).data; // slot center
    assert.ok(px[0] > 150 && px[2] < 120, `logo not composited at slot center (rgb ${px[0]},${px[1]},${px[2]})`);
  } finally {
    await bt.removeTemplate("listing");
  }
});
