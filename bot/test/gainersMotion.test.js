"use strict";
// The 🎬 Top-Gainers family (gainersMotion.js, m1..m10). What is guarded is
// mechanics, not taste: the look is approved by eye.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const gm = require("../src/gainersMotion");
const kit = require("../src/helpers/canvasKit");

const coin = (i, extra = {}) => ({
  symbol: "TOK" + i,
  name: "Token Number " + i,
  pct: 900 / (i + 1),
  price: 0.004 * (i + 1),
  mcap: 1_000_000 * (12 - i),
  liq: 90_000,
  ...extra,
});
const many = (n) => Array.from({ length: n }, (_, i) => coin(i));

/** Every string a render draws, read back off fillText. */
async function drawnText(fn) {
  const cv = kit.canvasLib();
  const proto = Object.getPrototypeOf(cv.createCanvas(1, 1).getContext("2d"));
  const real = proto.fillText;
  const seen = [];
  proto.fillText = function (s, ...rest) {
    seen.push(String(s));
    return real.call(this, s, ...rest);
  };
  try {
    await fn();
  } finally {
    proto.fillText = real;
  }
  return seen;
}

test("ten counts, ten ids of their own, one layout function each", () => {
  assert.deepStrictEqual(gm.TEMPLATE_IDS, ["m1", "m2", "m3", "m4", "m5", "m6", "m7", "m8", "m9", "m10"]);
  const fns = gm.TEMPLATE_IDS.map((id) => gm.LAYOUTS[gm.countOf(id)]);
  assert.ok(fns.every((f) => typeof f === "function"));
  assert.strictEqual(new Set(fns).size, 10, "one function for several counts is the 'only the colour differs' board");
  for (const id of gm.TEMPLATE_IDS) assert.match(gm.labelOf(id), /^🎬 /);
  assert.strictEqual(gm.countOf("v5"), null);
});

test("every count renders its frame 0 as a full-HD still, from its own layout", { skip: !gm.available() }, async () => {
  const cv = kit.canvasLib();
  for (const id of gm.TEMPLATE_IDS) {
    const png = await gm.renderStill({ template: id, coins: many(10), dateText: "Friday | November 06 2026" });
    assert.ok(png && png.length > 1000, `${id} rendered nothing`);
    const img = await cv.loadImage(png);
    assert.deepStrictEqual([img.width, img.height], [1920, 1080], id);
  }
  // the board comes from LAYOUTS[n]: with it stubbed out, no card is built
  const real = gm.LAYOUTS[5];
  let called = 0;
  gm.LAYOUTS[5] = (b, coins) => { called++; return real(b, coins); };
  try {
    await gm.renderStill({ template: "m5", coins: many(5) });
  } finally {
    gm.LAYOUTS[5] = real;
  }
  assert.strictEqual(called, 1);
});

test("a thin day and nothing at all never throw", { skip: !gm.available() }, async () => {
  assert.strictEqual(await gm.renderStill({ template: "m4", coins: [] }), null, "nothing real → nothing posted");
  for (const [id, n] of [["m3", 1], ["m5", 2], ["m7", 3], ["m9", 4], ["m10", 2]]) {
    assert.ok(await gm.renderStill({ template: id, coins: many(n) }), `${id} with ${n} coin(s)`);
  }
  assert.strictEqual(await gm.renderStill({ template: "nope", coins: many(3) }), null);
});

test("awkward coins: no logo, bytes that are not one, a loss, no change, no market line", { skip: !gm.available() }, async () => {
  const coins = [
    coin(0, { symbol: "SUPERLONGTICKER24CHARSXX", name: "A Very Long Project Name That Keeps Going On" }),
    coin(1, { logo: Buffer.from("not an image") }),
    coin(2, { pct: -14.2 }),
    coin(3, { pct: null }),
    coin(4, { price: null, mcap: null }),
    coin(5, { symbol: "$牛来", name: "牛来 Finance" }),
  ];
  for (const id of ["m6", "m8", "m10"]) assert.ok(await gm.renderStill({ template: id, coins }), id);
});

test("a figure the feed did not carry, or the operator hid, is never drawn", { skip: !gm.available() }, async () => {
  const { fmtCap } = require("../src/helpers/format");
  const coins = many(5);
  const cap = fmtCap(coins[1].mcap);
  const shown = await drawnText(() => gm.renderStill({ template: "m5", coins }));
  assert.ok(shown.some((s) => /%$/.test(s)), "vacuity: the gains must be drawn when on");
  assert.ok(shown.includes(cap), `vacuity: the market cap ${cap} must be drawn when on`);
  const hidden = await drawnText(() => gm.renderStill({ template: "m5", coins, showPct: false, showMcap: false }));
  assert.ok(!hidden.some((s) => /%$/.test(s)), "a hidden % was drawn");
  assert.ok(!hidden.includes(cap), "a hidden market cap was drawn");
  for (const id of ["m1", "m2", "m5"]) {
    const none = await drawnText(() => gm.renderStill({ template: id, coins: many(5).map((c) => ({ ...c, pct: null, price: null, mcap: null, liq: null })) }));
    // "$0", "—" or a "%" is a figure nobody measured, as much as a wrong number is
    const bad = none.filter((s) => /%$|\$0\b|—/.test(s));
    assert.deepStrictEqual(bad, [], `${id}: an unread figure was drawn: ${bad.join(", ")}`);
  }
});

test("a figure decodes into place, and only its digits move", () => {
  assert.strictEqual(gm._decode("+3981%", 1, 7), "+3981%");
  const mid = gm._decode("+3981%", 0, 7);
  assert.match(mid, /^\+\d{4}%$/);
});

test("the loop settles before it wraps, and the plates really switch off and back on", () => {
  const items = Array.from({ length: 10 }, (_, order) => ({ order }));
  for (const it of items) {
    assert.deepStrictEqual(gm._itemState(it, 0, 10), { a: 1, s: 1, p: 1, flash: 0 }, "frame 0 is the board at rest");
    const st = gm._itemState(it, 0.999, 10);
    assert.ok(st.a === 1 && st.s > 0.999 && st.p === 1, `plate ${it.order} has not settled at the wrap: ${JSON.stringify(st)}`);
    assert.strictEqual(gm._itemState(it, 0.69, 10).a, 0, "between off and on every plate is dark");
  }
  assert.ok(gm._itemState(items[9], 0.8, 10).p < 1, "the figures do not decode");
  assert.ok(gm._itemState(items[0], 0.66, 10).s < 1, "the switch-off is a no-op");
});

test("a mid-entrance frame differs from frame 0, and the frames are full HD RGBA", { skip: !gm.available() }, async () => {
  const frames = [];
  await gm.drawFrames({ template: "m5", coins: many(5) }, { times: [0, 0.76], onFrame: (b) => frames.push(Buffer.from(b)) });
  assert.strictEqual(frames.length, 2);
  assert.strictEqual(frames[0].length, 1920 * 1080 * 4);
  let diff = 0;
  for (let i = 0; i < frames[0].length; i += 4 * 97) diff += Math.abs(frames[0][i] - frames[1][i]);
  assert.ok(diff > 1000, "the entrance moved nothing");
});

test("the clip encodes as an MP4, and a cancel leaves no half-written file", { skip: !gm.available() }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dexvra-gm-"));
  const out = path.join(dir, "a.mp4");
  const r = await gm.render({ template: "m2", coins: many(2) }, { outPath: out, count: 12 });
  if (!r) return; // no ffmpeg on this runner: the caller falls back to the still
  assert.strictEqual(r.type, "animation");
  assert.strictEqual(fs.readFileSync(out).subarray(4, 8).toString(), "ftyp");
  const cut = path.join(dir, "b.mp4");
  // cancelled MID-clip: ffmpeg has frames and has created the file by then,
  // so a version that kept it would leave it behind
  let polls = 0;
  const cancel = { get cancelled() { return ++polls > 6; } };
  assert.strictEqual(await gm.render({ template: "m2", coins: many(2) }, { outPath: cut, cancel, count: 12 }), null);
  await new Promise((res) => setTimeout(res, 50));
  assert.ok(!fs.existsSync(cut), "a cancelled clip was left on disk");
});
