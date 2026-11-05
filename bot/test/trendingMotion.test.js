// The trending post's clip (trendingMotion) — one design per run length
// (6H chronograph · 12H trophy · 24H the "Blue Flame" · 48H crown) — and its wiring.
//
// Every figure on the clip is the post's own: postMedia hands it the same
// bannerCoin the caption is built from (fulfillment.bannerFigures' spelling),
// and a figure nobody read is left OUT — never "$0", never "TBA" on the art.
//
// The suite runs with TRENDING_MOTION=0 (scripts/run-tests.js) so every other
// trending test keeps the ladder it was written for; this file turns it back on.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-trendmotion-"));
process.env.CLIP_BUDGET_MS = "2000"; // the hang test waits out the budget

const test = require("node:test");
const assert = require("node:assert");
const kit = require("../src/helpers/canvasKit");
const tm = require("../src/trendingMotion");

const cv = kit.canvasLib();
const HAVE = !!cv;
const { IGN } = tm._timeline;
const { PANEL_Y } = tm._layout;

const COIN = { symbol: "$CHOO", name: "Choo Train", chain: "SOLANA", price: "$0.004512", mcap: "$4.5M", liq: "$612K" };

/** Every fillText call made while `fn` runs: [{ text, x, y, px }] (px = the font size). */
async function drawnDuring(fn) {
  const proto = Object.getPrototypeOf(cv.createCanvas(1, 1).getContext("2d"));
  const orig = proto.fillText;
  const out = [];
  proto.fillText = function (text, x, y, ...rest) {
    const m = /(\d+(?:\.\d+)?)px/.exec(this.font || "");
    out.push({ text: String(text), x, y, px: m ? Number(m[1]) : null });
    return orig.call(this, text, x, y, ...rest);
  };
  try {
    await fn();
  } finally {
    proto.fillText = orig;
  }
  return out;
}
const texts = (calls) => calls.map((c) => c.text);
/** Glyphs drawn one at a time (tracked labels, the per-letter ticker) on one baseline. */
const runAt = (calls, y) => calls.filter((c) => Math.abs(c.y - y) < 0.01).map((c) => c.text).join("");
const LABELS_Y = PANEL_Y + 36;
const logoPng = (color) => {
  const c = cv.createCanvas(200, 200), x = c.getContext("2d");
  x.fillStyle = color; x.fillRect(0, 0, 200, 200);
  return c.toBuffer("image/png");
};

test("TRENDING_MOTION: blank or unset is ON, an explicit off is off", () => {
  const prev = process.env.TRENDING_MOTION;
  try {
    delete process.env.TRENDING_MOTION; assert.equal(tm.enabled(), true);
    process.env.TRENDING_MOTION = ""; assert.equal(tm.enabled(), true, "blank is not false");
    process.env.TRENDING_MOTION = "0"; assert.equal(tm.enabled(), false);
    process.env.TRENDING_MOTION = "off"; assert.equal(tm.enabled(), false);
  } finally {
    if (prev === undefined) delete process.env.TRENDING_MOTION; else process.env.TRENDING_MOTION = prev;
  }
});

test("the pill names the run the post announces — and a listing badge never lands on a trending clip", () => {
  assert.equal(tm._pillOf("Trending 24H"), "TRENDING 24H");
  assert.equal(tm._pillOf("Trending 4H"), "TRENDING 4H");
  assert.equal(tm._pillOf("trending 168h"), "TRENDING 168H");
  assert.equal(tm._pillOf("Xpress Listing"), "TRENDING", "the auto-lister passes its LISTING badge");
  assert.equal(tm._pillOf("Gold Tier"), "TRENDING");
  assert.equal(tm._pillOf(null), "TRENDING", "the admin force-post passes none");
});

test("a placeholder is not a figure", () => {
  for (const v of ["TBA", "", null, undefined, "$0", "0", "$0.00", "—", "NaN", "undefined"]) assert.equal(tm._realFigure(v), null, String(v));
  assert.equal(tm._realFigure("$0.004512"), "$0.004512");
  assert.equal(tm._realFigure("$612K"), "$612K");
});

test("frame 0 is the full card, and every figure on it is the coin's own", { skip: !HAVE }, async () => {
  const calls = await drawnDuring(() => tm.frames(COIN, logoPng("#F2B33D"), { times: [0], badge: "Trending 24H" }));
  const t = texts(calls);
  assert.equal(runAt(calls, 290), "$CHOO", "the ticker, letter by letter, exactly one $");
  assert.ok(t.includes("Choo Train"), "the name");
  assert.equal(runAt(calls, 163), "TRENDING 24H", "the pill");
  assert.equal(runAt(calls, 65), "SOLANA", "the chain chip");
  assert.equal(runAt(calls, LABELS_Y), "PRICEMARKET CAPLIQUIDITY", "the panel labels");
  assert.ok(t.includes("$0.004512") && t.includes("$4.5M") && t.includes("$612K"), "the three figures, spelt as handed in");
  assert.ok(t.includes("Live on the Dexvra trending board"));
  const fake = (s) => /^\$0(\.0+)?$|TBA|NaN|undefined|null/.test(s);
  assert.ok(!t.some(fake), `no fabricated figure: ${t.filter(fake)}`);
});

test("nothing drawn is smaller than the floor X's timeline copy can still read", { skip: !HAVE }, async () => {
  const calls = await drawnDuring(() => tm.frames(COIN, null, { times: [0], badge: "Trending 24H" }));
  const sized = calls.filter((c) => c.px != null);
  assert.ok(sized.some((c) => c.px === tm.LABEL_MIN), "the floor itself is in use (the labels)");
  const small = sized.filter((c) => c.px < tm.LABEL_MIN);
  assert.deepEqual(small, [], `drawn under ${tm.LABEL_MIN}px`);
});

test("a ticker that already carries $ is not drawn with two", { skip: !HAVE }, async () => {
  const calls = await drawnDuring(() => tm.frames({ ...COIN, symbol: "$$choo" }, null, { times: [0] }));
  assert.equal(runAt(calls, 290), "$CHOO");
});

test("a price nobody read (TBA) and a missing depth leave their cells OUT", { skip: !HAVE }, async () => {
  const calls = await drawnDuring(() => tm.frames({ ...COIN, price: "TBA", liq: null }, null, { times: [0] }));
  const t = texts(calls);
  assert.equal(runAt(calls, LABELS_Y), "MARKET CAP", "only the cell with a figure");
  assert.ok(t.includes("$4.5M"));
  assert.ok(!t.some((s) => /TBA|\$0\b/.test(s)));
});

test("no figure at all → no panel, and the clip still draws", { skip: !HAVE }, async () => {
  const calls = await drawnDuring(() => tm.frames({ ...COIN, price: "TBA", mcap: null, liq: null }, null, { times: [0] }));
  assert.equal(runAt(calls, LABELS_Y), "", "no panel labels");
  assert.equal(runAt(calls, 290), "$CHOO");
});

test("the figures decode on the way in and are exact long before the wrap", { skip: !HAVE }, async () => {
  const early = await drawnDuring(() => tm.frames(COIN, null, { times: [IGN + 0.9] }));
  const late = await drawnDuring(() => tm.frames(COIN, null, { times: [5.8, 5.96] }));
  const at = (calls) => calls.filter((c) => Math.abs(c.y - (PANEL_Y + 76)) < 0.01).map((c) => c.text);
  assert.ok(at(early).length && !at(early).includes("$0.004512"), `still decoding mid-intro: ${at(early)}`);
  assert.deepEqual(at(late), ["$0.004512", "$4.5M", "$612K", "$0.004512", "$4.5M", "$612K"], "settled before the loop wraps");
});

test("the loop is exact: t = 6 draws what t = 0 draws", { skip: !HAVE }, async () => {
  const [a, b] = await tm.frames(COIN, logoPng("#3355ff"), { times: [0, tm.SECONDS], badge: "Trending 24H" });
  let off = 0;
  for (let i = 0; i < a.length; i += 4) if (Math.abs(a[i] - b[i]) > 12 || Math.abs(a[i + 1] - b[i + 1]) > 12 || Math.abs(a[i + 2] - b[i + 2]) > 12) off++;
  assert.ok(off < 60, `${off} pixels differ across the seam`);
});

test("the vacuity guard: the seam test compares two DIFFERENT moments of the clip", { skip: !HAVE }, async () => {
  const [a, b] = await tm.frames(COIN, null, { times: [0, 1.5] });
  let off = 0;
  for (let i = 0; i < a.length; i += 4) if (Math.abs(a[i] - b[i]) > 12) off++;
  assert.ok(off > 2000, `t = 1.5 should differ from t = 0 (embers, sway, glint) — only ${off} px did`);
});

test("the ignition really fires: the burst frame is far from frame 0", { skip: !HAVE }, async () => {
  const [a, b] = await tm.frames(COIN, null, { times: [0, IGN + 0.15] });
  let off = 0;
  for (let i = 0; i < a.length; i += 4) if (Math.abs(a[i] - b[i]) > 20) off++;
  assert.ok(off > 20000, `only ${off} pixels changed`);
});

test("the token's logo is what the flame's bulb shows; no logo draws the ticker's monogram", { skip: !HAVE }, async () => {
  const red = await tm.frames(COIN, logoPng("#ff0000"), { times: [0] });
  const blue = await tm.frames(COIN, logoPng("#0000ff"), { times: [0] });
  const body = await tm._flameBody();
  const { OX, OY } = tm._layout;
  const cx = Math.round(OX + body.bulb.x), cy = Math.round(OY + body.bulb.y);
  let redder = 0;
  for (let y = cy - 20; y < cy + 20; y++) for (let x = cx - 20; x < cx + 20; x++) {
    const i = (y * tm.W + x) * 4;
    if (red[0][i] > blue[0][i] + 40) redder++;
  }
  assert.ok(redder > 300, `the logo did not reach the bulb (${redder} px)`);
  const calls = await drawnDuring(() => tm.frames(COIN, null, { times: [0] }));
  assert.ok(texts(calls).includes("CH"), "the monogram");
});

test("the sway never moves the bulb: the logo sits in the same place while the tips sway", { skip: !HAVE }, async () => {
  // t = 0 and t = 3 put the CAMERA in the same place (its drift is whole
  // periods of 6s and 3s) while the sway's two waves differ — so any movement
  // of the logo between them is the sway reaching the bulb. The flame's
  // breathing scale is about the logo's own centre, so it cannot move it.
  const fr = await tm.frames(COIN, logoPng("#ff0000"), { times: [0, 3] });
  const body = await tm._flameBody();
  const { OX, OY } = tm._layout;
  const cx = Math.round(OX + body.bulb.x), cy = Math.round(OY + body.bulb.y);
  const centroid = (f) => {
    let sx = 0, sy = 0, n = 0;
    for (let y = cy - 130; y < cy + 130; y++) for (let x = cx - 130; x < cx + 130; x++) {
      const i = (y * tm.W + x) * 4;
      if (f[i] > f[i + 1] + 70 && f[i] > f[i + 2] + 70) { sx += x; sy += y; n++; }
    }
    return { x: sx / n, y: sy / n, n };
  };
  const a = centroid(fr[0]), b = centroid(fr[1]);
  assert.ok(a.n > 2000 && b.n > 2000, `the logo was found (${a.n}, ${b.n} px)`);
  assert.ok(Math.abs(a.x - b.x) < 0.35 && Math.abs(a.y - b.y) < 0.35, `the logo moved: (${a.x.toFixed(2)}, ${a.y.toFixed(2)}) → (${b.x.toFixed(2)}, ${b.y.toFixed(2)})`);
});

test("an unreadable logo draws the monogram, never fails the clip", { skip: !HAVE }, async () => {
  const fr = await tm.frames(COIN, Buffer.from("not an image"), { times: [0] });
  assert.ok(fr && fr.length === 1);
});

test("render() writes a real, silent MP4 (an autoplaying Telegram animation)", { skip: !HAVE }, async () => {
  const out = path.join(os.tmpdir(), `tm-test-${process.pid}.mp4`);
  const r = await tm.render(COIN, logoPng("#F2B33D"), { badge: "Trending 24H", outPath: out, count: 8 });
  assert.ok(r, "rendered");
  assert.equal(r.type, "animation");
  assert.ok(fss.statSync(out).size > 2000);
  fss.unlinkSync(out);
});

test("a cancelled render stops and hands nothing on", { skip: !HAVE }, async () => {
  const out = path.join(os.tmpdir(), `tm-cancel-${process.pid}.mp4`);
  const r = await tm.render(COIN, null, { outPath: out, cancel: { cancelled: true } });
  assert.equal(r, null);
  assert.ok(!fss.existsSync(out), "a half-written clip is deleted");
});

test("the flame is marched once and cached on disk", { skip: !HAVE }, async () => {
  const a = await tm._flameBody();
  const b = await tm._flameBody();
  assert.strictEqual(a, b, "one body per process");
  for (let i = 0; i < 50 && !fss.existsSync(tm._cacheFile()); i++) await new Promise((r) => setTimeout(r, 100));
  assert.ok(fss.existsSync(tm._cacheFile()), "cached for the next process");
});

// ── one design per run length ──
const BADGE = { watch: "Trending 6H", trophy: "Trending 12H", flame: "Trending 24H", crown: "Trending 48H" };
const offBy = (a, b, thr = 12) => {
  let off = 0;
  for (let i = 0; i < a.length; i += 4) if (Math.abs(a[i] - b[i]) > thr || Math.abs(a[i + 1] - b[i + 1]) > thr || Math.abs(a[i + 2] - b[i + 2]) > thr) off++;
  return off;
};

test("each run length gets its own design; a run in between takes the next one up", () => {
  const d = tm._designFor;
  assert.deepEqual(tm.DESIGN_KEYS.slice().sort(), ["crown", "flame", "trophy", "watch"]);
  assert.equal(d("Trending 3H"), "watch");
  assert.equal(d("Trending 6H"), "watch");
  assert.equal(d("Trending 12H"), "trophy");
  assert.equal(d("Trending 16H"), "flame");
  assert.equal(d("Trending 18H"), "flame");
  assert.equal(d("Trending 24H"), "flame", "24H keeps the approved Blue Flame");
  assert.equal(d("Trending 48H"), "crown");
  assert.equal(d("trending 168h"), "crown");
  assert.equal(d("Xpress Listing"), "flame", "a listing badge names no run: the flame");
  assert.equal(d(null), "flame", "the force-post passes none");
});

test("the badge picks the design the clip draws", { skip: !HAVE }, async () => {
  const [byBadge] = await tm.frames(COIN, null, { times: [0], badge: "Trending 6H" });
  const [named] = await tm.frames(COIN, null, { times: [0], badge: "Trending 6H", design: "watch" });
  const [flame] = await tm.frames(COIN, null, { times: [0], badge: "Trending 6H", design: "flame" });
  assert.equal(offBy(byBadge, named), 0, "6H draws the chronograph");
  assert.ok(offBy(byBadge, flame) > 20000, "and the chronograph is not the flame");
});

for (const key of ["watch", "trophy", "crown"]) {
  test(`${key}: frame 0 is the full card, the pill naming its run`, { skip: !HAVE }, async () => {
    const calls = await drawnDuring(() => tm.frames(COIN, logoPng("#F2B33D"), { times: [0], badge: BADGE[key] }));
    assert.equal(runAt(calls, 163), BADGE[key].toUpperCase());
    assert.equal(runAt(calls, 290), "$CHOO");
    assert.equal(runAt(calls, LABELS_Y), "PRICEMARKET CAPLIQUIDITY");
    assert.ok(texts(calls).includes("Live on the Dexvra trending board"));
  });
}

for (const key of ["watch", "trophy", "flame", "crown"]) {
  test(`${key}: the loop is exact (t = 6 draws t = 0) and the seam test compares two moments`, { skip: !HAVE }, async () => {
    const [a, b, c] = await tm.frames(COIN, logoPng("#3355ff"), { times: [0, tm.SECONDS, 1.5], design: key, badge: BADGE[key] });
    assert.ok(offBy(a, b) < 60, `${offBy(a, b)} pixels differ across the seam`);
    assert.ok(offBy(a, c) > 2000, "vacuity: t = 1.5 is not t = 0");
  });

  test(`${key}: the token's logo is what its place shows`, { skip: !HAVE }, async () => {
    const [red] = await tm.frames(COIN, logoPng("#ff0000"), { times: [0], design: key });
    const [blue] = await tm.frames(COIN, logoPng("#0000ff"), { times: [0], design: key });
    const body = await tm._bodyFor(key);
    const { OX, OY } = tm._layout;
    const cx = Math.round(OX + body.bulb.x), cy = Math.round(OY + body.bulb.y);
    let redder = 0;
    for (let y = cy - 20; y < cy + 20; y++) for (let x = cx - 20; x < cx + 20; x++) {
      const i = (y * tm.W + x) * 4;
      if (red[i] > blue[i] + 40) redder++;
    }
    assert.ok(redder > 300, `the logo did not reach its place (${redder} px)`);
  });
}

// ── 6H: the chronograph's face is drawn ON the object, registered through G.project ──
test("watch: the projector puts the dial's centre where the march drew the logo", { skip: !HAVE }, async () => {
  const D = tm._designs.watch, body = await tm._bodyFor("watch");
  const [px, py] = tm._projector(D)(D.logo.cx, D.logo.cy, 0.13);
  assert.ok(Math.abs(px - body.bulb.x) < 3 && Math.abs(py - body.bulb.y) < 3,
    `projected (${px.toFixed(1)}, ${py.toFixed(1)}), the logo's centre is (${body.bulb.x.toFixed(1)}, ${body.bulb.y.toFixed(1)}) — the gem, the timer and the crystal would float off the dial`);
  // the rim, not only the centre: a point on the dial's edge lands on metal the march drew
  const [ex, ey] = tm._projector(D)(0, D.logo.cy - 1.1, 0.06);
  const { OX, OY } = tm._layout;
  const [frame] = await tm.frames(COIN, null, { times: [0], design: "watch" });
  const i = (Math.round(OY + ey) * tm.W + Math.round(OX + ex)) * 4;
  assert.ok(frame[i] + frame[i + 1] + frame[i + 2] > 120, "six o'clock on the dial is drawn, not the dark room");
});

test("watch: the timer, the gem and the crystal are drawn over the dial", { skip: !HAVE }, async () => {
  const D = tm._designs.watch, front = D.front;
  const times = [0, 2.5];
  const withIt = await tm.frames(COIN, null, { times, design: "watch" });
  let without;
  try {
    D.front = null;
    without = await tm.frames(COIN, null, { times, design: "watch" });
  } finally {
    D.front = front;
  }
  for (const k of [0, 1]) assert.ok(offBy(withIt[k], without[k]) > 1500, `the face drew nothing at t=${times[k]} (${offBy(withIt[k], without[k])} px)`);
  // the crystal: light on the glass over the upper-left of the dial, where
  // neither the timer nor the gem reaches at frame 0
  const body = await tm._bodyFor("watch"), { OX, OY } = tm._layout;
  const liftAt = (a, r) => {
    const [gx, gy] = tm._projector(D)(r * Math.sin(a), D.logo.cy + r * Math.cos(a), 0.12);
    let lift = 0;
    for (let y = -4; y <= 4; y++) for (let x = -4; x <= 4; x++) {
      const i = (Math.round(OY + gy + y) * tm.W + Math.round(OX + gx + x)) * 4;
      lift += (withIt[0][i] + withIt[0][i + 1] + withIt[0][i + 2]) - (without[0][i] + without[0][i + 1] + without[0][i + 2]);
    }
    return lift / 81;
  };
  const glass = liftAt(-1.4, 1.0), head = liftAt(tm._sweepAt(0), 1.07);
  assert.ok(glass > 30, `the crystal put no light on the glass (${glass.toFixed(1)})`);
  assert.ok(head > 120, `the timer's light is not on the minute track at frame 0 (${head.toFixed(1)})`);
  assert.ok(body.bulb.r > 50, "vacuity: the dial is big enough to sample");
});

test("watch: the timer runs one turn a loop, spins twice on the way in, and leaves twelve o'clock to the gem", () => {
  const s = tm._sweepAt, { IGN } = tm._timeline, turns = (a, b) => (b - a) / (2 * Math.PI);
  const seam = turns(s(0), s(tm.SECONDS));
  assert.ok(Math.abs(seam - Math.round(seam)) < 1e-9 && Math.round(seam) === 3, `t = 6 is ${seam} turns on — the seam would jump`);
  assert.ok(Math.abs(turns(s(0), s(3)) - 0.5) < 1e-9, "half a turn by t = 3: it moves");
  assert.ok(turns(s(IGN), s(IGN + 0.75)) > 2, "the quick double turn on the way in");
  const a0 = ((s(0) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  assert.ok(a0 > 0.6 && a0 < 2 * Math.PI - 0.6, "frame 0's timer light is clear of the gem at twelve (the thumbnail shows the gem)");
});

test("watch: the Dexvra gem is printed at twelve o'clock", { skip: !HAVE }, async () => {
  const kit = require("../src/helpers/canvasKit");
  const real = kit.drawGem;
  let n = 0;
  kit.drawGem = (...a) => { n++; return real(...a); };
  try {
    await tm.frames(COIN, null, { times: [0], design: "watch" });
    assert.ok(n >= 1, "the gem was never drawn on the dial");
    n = 0;
    await tm.frames(COIN, null, { times: [0], design: "trophy" });
    assert.equal(n, 0, "only the chronograph carries it");
  } finally {
    kit.drawGem = real;
  }
});

for (const [key, what] of [["trophy", "the confetti"]]) {
  test(`${key}: ${what} fires on the way in and is gone before the wrap`, { skip: !HAVE }, async () => {
    const D = tm._designs[key];
    const ignite = D.ignite;
    const times = [IGN + 0.15, 5.96];
    const withIt = await tm.frames(COIN, null, { times, design: key });
    let without;
    try {
      D.ignite = null;
      without = await tm.frames(COIN, null, { times, design: key });
    } finally {
      D.ignite = ignite;
    }
    assert.ok(offBy(withIt[0], without[0]) > 500, `${what} drew nothing (${offBy(withIt[0], without[0])} px)`);
    assert.equal(offBy(withIt[1], without[1], 0), 0, `${what} is still on screen at the last frame — the seam would jump`);
  });
}

test("every design is marched once and cached under its own name and version", { skip: !HAVE }, async () => {
  const files = tm.DESIGN_KEYS.map((k) => tm._cacheFile(k));
  assert.equal(new Set(files).size, files.length, "one file per design");
  assert.ok(tm._cacheFile("flame").endsWith("dexvra-trendflame-v1-560x2.bin"), "the flame keeps its cache");
  const a = await tm._bodyFor("crown");
  assert.strictEqual(a, await tm._bodyFor("crown"), "one body per process");
  const shapes = await Promise.all(tm.DESIGN_KEYS.map((k) => tm._bodyFor(k)));
  assert.equal(new Set(shapes.map((b) => b.metalPx.length)).size, shapes.length, "four different objects, not one shape four times");
  for (let i = 0; i < 50 && !fss.existsSync(tm._cacheFile("crown")); i++) await new Promise((r) => setTimeout(r, 100));
  assert.ok(fss.existsSync(tm._cacheFile("crown")));
});

test("the temp sweep reclaims only this module's old clips", async () => {
  const dir = fss.mkdtempSync(path.join(os.tmpdir(), "tm-sweep-"));
  const now = Date.now();
  const old = path.join(dir, "bt-out-tm-old.mp4"), fresh = path.join(dir, "bt-out-tm-new.mp4"), other = path.join(dir, "bt-out-pm-old.mp4");
  for (const f of [old, fresh, other]) fss.writeFileSync(f, "x");
  const past = new Date(now - 60 * 60_000);
  fss.utimesSync(old, past, past); fss.utimesSync(other, past, past);
  await tm._sweepTmp(dir, now);
  assert.strictEqual(fss.existsSync(old), false);
  assert.strictEqual(fss.existsSync(fresh), true);
  assert.strictEqual(fss.existsSync(other), true, "another module's file is not ours to delete");
  fss.rmSync(dir, { recursive: true, force: true });
});

// ── the wiring: every trending post goes through postMedia ──
function withMotion(value, fn) {
  return async () => {
    const prev = process.env.TRENDING_MOTION;
    process.env.TRENDING_MOTION = value;
    const real = tm.render;
    try {
      await fn();
    } finally {
      tm.render = real;
      if (prev === undefined) delete process.env.TRENDING_MOTION;
      else process.env.TRENDING_MOTION = prev;
    }
  };
}

test(
  "a TRENDING post gets the flame first, with the coin, the logo and the post's own badge",
  withMotion("1", async () => {
    const { postMedia } = require("../src/fulfillment");
    const bt = require("../src/bannerTemplate");
    const posting = bt.postingEnabled;
    const calls = [];
    try {
      bt.postingEnabled = () => true;
      tm.render = async (coin, logoBuf, opts) => {
        calls.push({ coin, logoBuf, opts });
        return { type: "animation", source: "/tmp/stub.mp4" };
      };
      const lg = Buffer.from("logo");
      const media = await postMedia("trending", COIN, lg, null, null, "Trending 24H");
      assert.deepStrictEqual(media, { type: "animation", source: "/tmp/stub.mp4" });
      assert.strictEqual(calls.length, 1);
      assert.strictEqual(calls[0].coin, COIN);
      assert.strictEqual(calls[0].logoBuf, lg);
      assert.strictEqual(calls[0].opts.badge, "Trending 24H");

      // a LISTING post never asks for the flame
      calls.length = 0;
      await postMedia("listing", COIN, null, null, null, "Gold Tier").catch(() => null);
      assert.strictEqual(calls.length, 0, "the flame is the trending post's");
    } finally {
      bt.postingEnabled = posting;
    }
  }),
);

test(
  "TRENDING_MOTION=0 and the admin's banner switch both keep the flame off",
  withMotion("0", async () => {
    const { postMedia } = require("../src/fulfillment");
    const bt = require("../src/bannerTemplate");
    const posting = bt.postingEnabled;
    let called = 0;
    try {
      tm.render = async () => { called++; return { type: "animation", source: "/tmp/stub.mp4" }; };
      bt.postingEnabled = () => true;
      await postMedia("trending", COIN, null, null, null, "Trending 24H").catch(() => null);
      assert.strictEqual(called, 0, "TRENDING_MOTION=0");
      process.env.TRENDING_MOTION = "1";
      bt.postingEnabled = () => false;
      await postMedia("trending", COIN, null, null, null, "Trending 24H").catch(() => null);
      assert.strictEqual(called, 0, "banners switched off");
    } finally {
      bt.postingEnabled = posting;
    }
  }),
);

test(
  "a flame that FAILS or HANGS falls through to the ladder, and a hung one is told to stop",
  withMotion("1", async () => {
    const { postMedia } = require("../src/fulfillment");
    const bt = require("../src/bannerTemplate");
    const posting = bt.postingEnabled;
    try {
      bt.postingEnabled = () => true;
      tm.render = async () => null;
      const failed = await postMedia("trending", COIN, null, null, null, "Trending 24H");
      assert.ok(failed && Buffer.isBuffer(failed.source), "the still artwork, as before");
      let seen = null;
      tm.render = (coin, logoBuf, opts) => { seen = opts.cancel; return new Promise(() => {}); };
      const t0 = Date.now();
      const hung = await postMedia("trending", COIN, null, null, null, "Trending 24H");
      assert.ok(Date.now() - t0 < 6000, "bounded by CLIP_BUDGET_MS");
      assert.ok(hung && Buffer.isBuffer(hung.source), "falls through to the still");
      assert.ok(seen && seen.cancelled === true, "the abandoned render is cancelled, not left burning CPU");
    } finally {
      bt.postingEnabled = posting;
    }
  }),
);
