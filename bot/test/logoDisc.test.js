// "pastikan semuanya berjalan dengan benar dari logo tepat posisi" — a render of
// the pump clip with real-shaped logos found two coin faces drawn wrong: a black
// glyph on a transparent background went out as an all-black disc, and a 3:1
// wordmark was cropped to "OR". canvasKit.drawLogoDisc is the one rule both the
// pump clip's hub and the listing clip's coin draw through.
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
process.env.BOT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "dexvra-logodisc-"));

const test = require("node:test");
const assert = require("node:assert/strict");
const kit = require("../src/helpers/canvasKit");

const cv = kit.canvasLib();
const HAVE = !!cv;

/** A wide logo whose two ENDS are marked: red on the left tenth, blue on the right. */
function wideEnds(w = 600, h = 200) {
  const c = cv.createCanvas(w, h), x = c.getContext("2d");
  x.fillStyle = "#808080"; x.fillRect(0, 0, w, h);
  x.fillStyle = "#ff0000"; x.fillRect(0, 0, w * 0.1, h);
  x.fillStyle = "#0000ff"; x.fillRect(w * 0.9, 0, w * 0.1, h);
  return c.toBuffer("image/png");
}
/** A black keyhole on a fully transparent background. */
function darkOnClear() {
  const c = cv.createCanvas(400, 400), x = c.getContext("2d");
  x.fillStyle = "#111"; x.beginPath(); x.arc(200, 150, 90, 0, Math.PI * 2); x.fill(); x.fillRect(150, 220, 100, 140);
  return c.toBuffer("image/png");
}
function whiteOnClear() {
  const c = cv.createCanvas(400, 400), x = c.getContext("2d");
  x.fillStyle = "#fff"; x.beginPath(); x.arc(200, 200, 120, 0, Math.PI * 2); x.fill();
  return c.toBuffer("image/png");
}
function solid(color, w = 400, h = 400) {
  const c = cv.createCanvas(w, h), x = c.getContext("2d");
  x.fillStyle = color; x.fillRect(0, 0, w, h);
  return c.toBuffer("image/png");
}

/** Draw `buf` into a 200px circle face and hand back the pixels. */
async function face(buf) {
  const img = await cv.loadImage(buf);
  const c = cv.createCanvas(200, 200), x = c.getContext("2d");
  x.beginPath(); x.arc(100, 100, 100, 0, Math.PI * 2); x.clip();
  const how = kit.drawLogoDisc(x, img, 100, 100, 100, { backdrop: "#0B0F17" });
  return { how, d: x.getImageData(0, 0, 200, 200).data };
}
const px = (d, x, y) => { const i = (y * 200 + x) * 4; return [d[i], d[i + 1], d[i + 2], d[i + 3]]; };
const count = (d, pred) => {
  let n = 0;
  for (let y = 0; y < 200; y++) for (let x = 0; x < 200; x++) {
    if (Math.hypot(x - 100, y - 100) > 98) continue;
    if (pred(px(d, x, y))) n++;
  }
  return n;
};
const isRed = ([r, g, b]) => r > 200 && g < 60 && b < 60;
const isBlue = ([r, g, b]) => b > 200 && r < 60 && g < 60;
const lum = ([r, g, b]) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;

test("a square logo fills the coin, as it always did", { skip: !HAVE }, async () => {
  const { how, d } = await face(solid("#F7931A"));
  assert.equal(how.fit, "fill");
  assert.equal(how.backdrop, "dark");
  // edge to edge: a point just inside the rim is the logo's own colour
  const [r, g, b] = px(d, 100, 4);
  assert.ok(r > 200 && g > 100 && b < 60, `the rim is not the logo (${r},${g},${b})`);
});

test("a WIDE logo is fitted whole — both of its ends are on the coin", { skip: !HAVE }, async () => {
  const { how, d } = await face(wideEnds());
  assert.equal(how.fit, "whole");
  // cropped to fill, a 3:1 logo shows only its middle third: neither end band survives
  assert.ok(count(d, isRed) > 100, "the left end of the wordmark was cut off");
  assert.ok(count(d, isBlue) > 100, "the right end of the wordmark was cut off");
});

test("a TALL logo is fitted whole too", { skip: !HAVE }, async () => {
  const c = cv.createCanvas(200, 400), x = c.getContext("2d");
  x.fillStyle = "#808080"; x.fillRect(0, 0, 200, 400);
  x.fillStyle = "#ff0000"; x.fillRect(0, 0, 200, 40);
  x.fillStyle = "#0000ff"; x.fillRect(0, 360, 200, 40);
  const { how, d } = await face(c.toBuffer("image/png"));
  assert.equal(how.fit, "whole");
  assert.ok(count(d, isRed) > 100 && count(d, isBlue) > 100, "the top or bottom was cut off");
});

test("a DARK logo on a clear background gets a light backdrop — it does not vanish", { skip: !HAVE }, async () => {
  const { how, d } = await face(darkOnClear());
  assert.equal(how.backdrop, "light");
  // beside the glyph, inside the coin: the backdrop is light, and the glyph is still dark
  assert.ok(lum(px(d, 30, 100)) > 0.8, "the backdrop behind a black glyph is not light");
  assert.ok(lum(px(d, 100, 75)) < 0.2, "the glyph itself is no longer dark");
});

test("a LIGHT logo on a clear background keeps the dark backdrop", { skip: !HAVE }, async () => {
  const { how, d } = await face(whiteOnClear());
  assert.equal(how.backdrop, "dark");
  assert.ok(lum(px(d, 100, 100)) > 0.9, "the white glyph");
  assert.ok(lum(px(d, 100, 6)) < 0.15, "the dark backdrop around it");
});

test("an OPAQUE dark logo is the project's own art — never put on a light backdrop", { skip: !HAVE }, async () => {
  const { how, d } = await face(solid("#101010"));
  assert.equal(how.backdrop, "dark");
  assert.ok(lum(px(d, 100, 100)) < 0.15);
});

// ── both clips draw through it ──

test("the PUMP clip's hub: a black logo is visible and a wordmark is whole", { skip: !HAVE }, async () => {
  process.env.PUMP_MOTION = "1";
  const pm = require("../src/pumpMotion");
  const coin = { symbol: "$NOIR", name: "Noir", pct: 300, firstMc: "$250K", lastMc: "$1M" };
  const hub = (fr, pred) => {
    let n = 0;
    for (let y = 270; y < 370; y++) for (let x = 910; x < 1010; x++) {
      const i = (y * pm.W + x) * 4;
      if (pred([fr[i], fr[i + 1], fr[i + 2]])) n++;
    }
    return n;
  };
  const [dark] = await pm.frames(coin, darkOnClear(), { times: [0] });
  assert.ok(hub(dark, (p) => lum(p) > 0.75) > 800, "the hub behind a black logo is still black");
  const [wide] = await pm.frames(coin, wideEnds(), { times: [0] });
  const redish = ([r, g, b]) => r > 150 && r > g * 2 && r > b * 2;
  const bluish = ([r, g, b]) => b > 150 && b > r * 2 && b > g * 1.5;
  assert.ok(hub(wide, redish) > 20, "the wordmark's left end is not on the hub");
  assert.ok(hub(wide, bluish) > 20, "the wordmark's right end is not on the hub");
});

test("the LISTING clip's coin: a black logo on a clear background is visible", { skip: !HAVE }, async () => {
  process.env.LISTING_MOTION = "1";
  const lm = require("../src/listingMotion");
  const coin = { symbol: "$NOIR", name: "Noir", chain: "solana", badge: "XPRESS LISTING" };
  const [fr] = await lm.frames(coin, darkOnClear(), { count: 1 });
  let light = 0;
  for (let y = 186; y < 386; y++) for (let x = 858; x < 1058; x++) {
    const i = (y * lm.W + x) * 4;
    if (lum([fr[i], fr[i + 1], fr[i + 2]]) > 0.75) light++;
  }
  assert.ok(light > 2000, `the coin behind a black logo is still dark (${light} light px)`);
});

test("one rule: neither clip keeps a private copy of the logo fit", () => {
  for (const f of ["pumpMotion.js", "listingMotion.js"]) {
    const src = fs.readFileSync(path.join(__dirname, "..", "src", f), "utf8");
    assert.match(src, /kit\.drawLogoDisc\(/, `${f} draws its logo through canvasKit`);
    assert.ok(!/drawImage\(img,/.test(src), `${f} draws the logo image itself again`);
  }
});
