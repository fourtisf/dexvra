// The premium animated listing clip (src/listingMotion.js) and its place at the
// top of postMedia's ladder for a listing.
//
// The suite runs with LISTING_MOTION=0 (scripts/run-tests.js) so every other
// fulfilment test keeps the ladder it was written for; this file turns it back
// on where it needs it.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
const { spawnSync } = require("node:child_process");
process.env.BOT_DATA_DIR = process.env.BOT_DATA_DIR || fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-lm-"));
process.env.CLIP_BUDGET_MS = "2000";

const test = require("node:test");
const assert = require("node:assert");
const lm = require("../src/listingMotion");
const { canvasLib } = require("../src/helpers/canvasKit");

const COIN = { symbol: "$AMD", name: "A Meme Dog", chain: "SOLANA", price: "$0.001618", mcap: "$1.6M", liq: "$131.2K" };
const cv = canvasLib();
const haveCanvas = !!cv;
let haveFfmpeg = false;
try {
  haveFfmpeg = fss.existsSync(require("@ffmpeg-installer/ffmpeg").path);
} catch {
  haveFfmpeg = false;
}

function logo() {
  const c = cv.createCanvas(200, 200);
  const x = c.getContext("2d");
  x.fillStyle = "#C8102E";
  x.fillRect(0, 0, 200, 200);
  return c.toBuffer("image/png");
}

/** Mean absolute difference per channel byte between two RGBA frames. */
function meanDiff(a, b) {
  let sum = 0;
  // every 7th byte is plenty and keeps this fast on 3.2 MB frames
  let n = 0;
  for (let i = 0; i < a.length; i += 7) {
    sum += Math.abs(a[i] - b[i]);
    n++;
  }
  return sum / n;
}

async function pick(coin, logoBuf, wanted) {
  const got = new Map();
  const ok = await lm._drawFrames(coin, logoBuf, {
    count: Math.max(...wanted) + 1,
    badge: "Xpress Listing",
    onFrame: (buf, f) => {
      if (wanted.includes(f)) got.set(f, Buffer.from(buf));
    },
  });
  assert.ok(ok, "canvas available");
  return got;
}

test("the production default is ON: blank and unset mean on, 0 turns it off", () => {
  const prev = process.env.LISTING_MOTION;
  try {
    delete process.env.LISTING_MOTION;
    assert.strictEqual(lm.enabled(), true, "unset must be ON");
    process.env.LISTING_MOTION = "";
    assert.strictEqual(lm.enabled(), true, "blank must be ON — never configured is not a refusal");
    process.env.LISTING_MOTION = "0";
    assert.strictEqual(lm.enabled(), false, "0 must switch it off");
    process.env.LISTING_MOTION = "off";
    assert.strictEqual(lm.enabled(), false);
  } finally {
    if (prev === undefined) delete process.env.LISTING_MOTION;
    else process.env.LISTING_MOTION = prev;
  }
});

test("frame 0 is the FULL card: every element is in place and the coin is face-on", () => {
  // Telegram builds the thumbnail and the preview from the first frame
  assert.ok(lm._keys.length >= 5, "the schedule lists the elements the intro builds");
  for (const k of lm._keys) assert.strictEqual(lm._reveal(0, k), 1, `${k} must be shown at t=0`);
  for (let i = 0; i < 4; i++) assert.strictEqual(lm._reveal(0, "stats", i), 1);
  const c = lm._coinState(0);
  assert.strictEqual(c.s, 1);
  assert.strictEqual(c.theta, 0);
  assert.strictEqual(c.alpha, 1);
});

test("everything the intro builds has SETTLED before the loop wraps", () => {
  const last = (lm.FRAMES - 1) / lm.FPS;
  for (const k of lm._keys) assert.strictEqual(lm._reveal(last, k), 1, `${k} still moving at the seam`);
  for (let i = 0; i < 4; i++) assert.strictEqual(lm._reveal(last, "stats", i), 1, `stat ${i} still decoding at the seam`);
  const c = lm._coinState(last);
  assert.ok(Math.abs(c.s - 1) < 1e-3, `coin scale ${c.s} at the seam`);
  assert.ok(Math.abs(c.theta) < 1e-6);
  // the landing's afterglow must be exactly spent, or the rays step at the seam
  assert.strictEqual(lm._impactBoost(lm._timeline.SECONDS), 0);
  assert.ok(lm._impactBoost(last) < 0.01);
  assert.strictEqual(lm._impactBoost(lm._timeline.IMPACT), 1);
  assert.strictEqual(lm._impactBoost(lm._timeline.IMPACT - 0.01), 0);
});

test("the intro really happens: mid-loop the copy is hidden and the coin is flying", () => {
  const { OUT_END, IMPACT } = lm._timeline;
  assert.strictEqual(lm._reveal(OUT_END + 0.05, "ticker"), 0);
  assert.strictEqual(lm._reveal(OUT_END + 0.05, "stats"), 0);
  const c = lm._coinState(OUT_END + 0.2);
  assert.ok(c.s < 0.8 && c.theta > 1, `coin should be small and spinning, got s=${c.s} θ=${c.theta}`);
  assert.ok(lm._coinState(IMPACT).s > 0.97, "the landing fires when the coin has arrived");
});

test("scramble: digits cycle, symbols hold, q=1 is the exact value", () => {
  assert.strictEqual(lm._scramble("$0.001618", 1, 1.23, 7), "$0.001618");
  const mid = lm._scramble("$1,234.5K", 0, 1.23, 7);
  assert.strictEqual(mid.length, "$1,234.5K".length);
  assert.deepStrictEqual([...mid].filter((c) => !/[0-9]/.test(c)), [..."$,.K"], "symbols never scramble");
  assert.strictEqual(lm._scramble("$1,234.5K", 0, 1.23, 7), mid, "deterministic");
  const half = lm._scramble("123456", 0.5, 2, 3);
  assert.strictEqual(half.slice(0, 3), "123", "the resolved prefix is the real one");
});

test("statsOf leaves a missing figure OUT — never a dash, a zero or TBA", () => {
  assert.deepStrictEqual(lm.statsOf(COIN).map(([k]) => k), ["NETWORK", "PRICE", "MARKET CAP", "LIQUIDITY"]);
  assert.deepStrictEqual(lm.statsOf({ chain: "BSC", price: "TBA", mcap: null, liq: null }).map(([k]) => k), ["NETWORK"]);
});

test("the loop closes: the last frame flows into frame 0 like any other step", { skip: !haveCanvas }, async () => {
  const f = await pick(COIN, logo(), [0, 1, 2, lm.FRAMES - 1]);
  const step = (meanDiff(f.get(0), f.get(1)) + meanDiff(f.get(1), f.get(2))) / 2;
  const seam = meanDiff(f.get(lm.FRAMES - 1), f.get(0));
  assert.ok(step > 0.05, `the hold should be moving (step ${step.toFixed(3)})`);
  // measured: a correct loop's seam IS a normal step (0.89 vs 0.92); the
  // half-period ray bug made it 1.29 — this bound sits between the two
  assert.ok(seam < step * 1.2 + 0.05, `seam jump ${seam.toFixed(3)} vs a normal step ${step.toFixed(3)}`);
});

test("the loop is EXACT: t = SECONDS draws what frame 0 draws, pixel for pixel", { skip: !haveCanvas }, async () => {
  // Every ambient motion must complete whole periods per loop. A faint element
  // off by part of a period (a floor row, the thin light ring, the dust) barely
  // moves an average, so this counts the pixels that DIFFER instead.
  const got = [];
  await lm._drawFrames(COIN, logo(), {
    times: [0, lm._timeline.SECONDS],
    badge: "Xpress Listing",
    onFrame: (b) => got.push(Buffer.from(b)),
  });
  let off = 0;
  for (let i = 0; i < got[0].length; i++) if (Math.abs(got[0][i] - got[1][i]) > 12) off++;
  assert.ok(off < 40, `${off} channel bytes differ by more than 12 between t=0 and t=${lm._timeline.SECONDS}s`);
  // vacuity guard: `times` must be drawn UNWRAPPED, or the assertion above
  // compares frame 0 with itself. At 1.5s the coin is mid-spin in the hold; one
  // loop later the clock is past the intro, so an honest harness draws it flat.
  const pair = [];
  await lm._drawFrames(COIN, logo(), {
    times: [1.5, lm._timeline.SECONDS + 1.5],
    badge: "Xpress Listing",
    onFrame: (b) => pair.push(Buffer.from(b)),
  });
  assert.ok(meanDiff(pair[0], pair[1]) > 1, "`times` was wrapped — the seam test above would be comparing a frame with itself");
});

test("frames() COPIES each frame — canvas.data() is a live view of the pixels", { skip: !haveCanvas }, async () => {
  const lg = logo();
  const fr = await lm.frames(COIN, lg, { count: 8, badge: "Xpress Listing" });
  assert.strictEqual(fr.length, 8);
  // reference copies taken INSIDE onFrame, while each frame is still current
  const ref = await pick(COIN, lg, [0, 1, 2, 3, 4, 5, 6, 7]);
  for (let i = 0; i < 8; i++) assert.ok(fr[i].equals(ref.get(i)), `frame ${i} no longer holds the pixels it was drawn with`);
});

test("no logo draws the struck face, and an unreadable logo never fails the clip", { skip: !haveCanvas }, async () => {
  const a = await lm.frames({ ...COIN, symbol: "$ANONVOYAGE" }, null, { count: 1 });
  const b = await lm.frames(COIN, Buffer.from("not an image"), { count: 1 });
  assert.ok(a && a.length === 1 && b && b.length === 1);
});

test("render → a silent 6s MP4 whose first frame is the card frames() draws", { skip: !(haveCanvas && haveFfmpeg) }, async () => {
  const dir = fss.mkdtempSync(path.join(os.tmpdir(), "lm-render-"));
  const out = path.join(dir, "clip.mp4");
  const lg = logo();
  const res = await lm.render(COIN, lg, { badge: "Xpress Listing", outPath: out });
  assert.deepStrictEqual(res, { type: "animation", source: out });
  assert.ok(fss.statSync(out).size > 50_000);
  const ff = require("@ffmpeg-installer/ffmpeg").path;
  const probe = spawnSync(ff, ["-i", out], { encoding: "utf8" }).stderr;
  assert.match(probe, /Duration: 00:00:06\.00/);
  assert.match(probe, /yuv420p/);
  assert.doesNotMatch(probe, /Audio:/, "no audio track — Telegram must treat it as an animation");
  const raw = spawnSync(ff, ["-v", "error", "-i", out, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"], { maxBuffer: 16 << 20 }).stdout;
  const [first] = await lm.frames(COIN, lg, { count: 1, badge: "Xpress Listing" });
  assert.strictEqual(raw.length, first.length);
  assert.ok(meanDiff(raw, first) < 6, `encoded frame 0 drifted ${meanDiff(raw, first).toFixed(2)} from the drawn one`);
  fss.rmSync(dir, { recursive: true, force: true });
});

test("a cancelled render returns null and leaves no half-written file", { skip: !(haveCanvas && haveFfmpeg) }, async () => {
  const dir = fss.mkdtempSync(path.join(os.tmpdir(), "lm-cancel-"));
  const out = path.join(dir, "clip.mp4");
  // cancelled MID-render, after ffmpeg has created the output — a flag set
  // before the first frame would never leave a file to clean up at all
  let checks = 0;
  const cancel = {
    get cancelled() {
      return ++checks > 25;
    },
  };
  const res = await lm.render(COIN, null, { outPath: out, cancel });
  assert.ok(checks > 25, "the render ran until the cancel");
  assert.strictEqual(res, null);
  await new Promise((r) => setTimeout(r, 100));
  assert.strictEqual(fss.existsSync(out), false);
  fss.rmSync(dir, { recursive: true, force: true });
});

test("the temp sweep reclaims only its own files, and only old ones", async () => {
  const dir = fss.mkdtempSync(path.join(os.tmpdir(), "lm-sweep-"));
  const old = path.join(dir, "bt-out-lm-1.mp4");
  const fresh = path.join(dir, "bt-out-lm-2.mp4");
  const other = path.join(dir, "bt-out-123.mp4");
  for (const f of [old, fresh, other]) fss.writeFileSync(f, "x");
  const now = Date.now();
  fss.utimesSync(old, new Date(now - 3600_000), new Date(now - 3600_000));
  fss.utimesSync(other, new Date(now - 3600_000), new Date(now - 3600_000));
  await lm._sweepTmp(dir, now);
  assert.strictEqual(fss.existsSync(old), false);
  assert.strictEqual(fss.existsSync(fresh), true);
  assert.strictEqual(fss.existsSync(other), true, "another module's file is not ours to delete");
  fss.rmSync(dir, { recursive: true, force: true });
});

// ── postMedia wiring ─────────────────────────────────────────────────────────

function withMotion(value, fn) {
  return async () => {
    const prev = process.env.LISTING_MOTION;
    process.env.LISTING_MOTION = value;
    const real = lm.render;
    try {
      await fn();
    } finally {
      lm.render = real;
      if (prev === undefined) delete process.env.LISTING_MOTION;
      else process.env.LISTING_MOTION = prev;
    }
  };
}

test(
  "a LISTING post gets the premium clip first, with the coin, logo and badge",
  withMotion("1", async () => {
    const { postMedia } = require("../src/fulfillment");
    const calls = [];
    lm.render = async (coin, logoBuf, opts) => {
      calls.push({ coin, logoBuf, opts });
      return { type: "animation", source: "/tmp/stub.mp4" };
    };
    const coin = { symbol: "TEST", name: "Test", chain: "SOLANA", price: "$0.01", mcap: "$1M", liq: "$50K" };
    const lg = Buffer.from("logo");
    const media = await postMedia("listing", coin, lg, null, null, "Gold Tier");
    assert.deepStrictEqual(media, { type: "animation", source: "/tmp/stub.mp4" });
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].coin, coin);
    assert.strictEqual(calls[0].logoBuf, lg);
    assert.strictEqual(calls[0].opts.badge, "Gold Tier");
  }),
);

test(
  "a TRENDING post never asks for it — the clip is a listing announcement",
  withMotion("1", async () => {
    const { postMedia } = require("../src/fulfillment");
    let called = 0;
    lm.render = async () => {
      called++;
      return { type: "animation", source: "/tmp/stub.mp4" };
    };
    await postMedia("trending", { symbol: "T", name: "T", chain: "SOLANA", price: "$1", mcap: "$1M" }, null, null, null, "Trending 4H");
    assert.strictEqual(called, 0);
  }),
);

test(
  "LISTING_MOTION=0 restores the old ladder exactly",
  withMotion("0", async () => {
    const { postMedia } = require("../src/fulfillment");
    let called = 0;
    lm.render = async () => {
      called++;
      return { type: "animation", source: "/tmp/stub.mp4" };
    };
    const media = await postMedia("listing", { symbol: "T", name: "T", chain: "SOLANA", price: "$1", mcap: "$1M" }, null, null, null, null);
    assert.strictEqual(called, 0);
    assert.ok(media && Buffer.isBuffer(media.source), "the still artwork, as before");
  }),
);

test(
  "a render that FAILS falls through to the artwork the ladder always produced",
  withMotion("1", async () => {
    const { postMedia } = require("../src/fulfillment");
    lm.render = async () => null;
    const media = await postMedia("listing", { symbol: "T", name: "T", chain: "SOLANA", price: "$1", mcap: "$1M" }, null, null, null, null);
    assert.ok(media && Buffer.isBuffer(media.source));
  }),
);

test(
  "a render that HANGS is abandoned at the budget AND told to stop",
  withMotion("1", async () => {
    const { postMedia } = require("../src/fulfillment");
    let seen = null;
    lm.render = (coin, logoBuf, opts) => {
      seen = opts.cancel;
      return new Promise(() => {}); // never settles
    };
    const t0 = Date.now();
    const media = await postMedia("listing", { symbol: "T", name: "T", chain: "SOLANA", price: "$1", mcap: "$1M" }, null, null, null, null);
    assert.ok(Date.now() - t0 < 6000, "bounded by CLIP_BUDGET_MS");
    assert.ok(media && Buffer.isBuffer(media.source), "falls through to the still");
    assert.ok(seen && seen.cancelled === true, "the abandoned render is cancelled, not left burning CPU");
  }),
);

test("bannerCoinOf carries the liquidity the clip prints, and leaves a missing one out", () => {
  const { _bannerCoinOf } = require("../src/fulfillment");
  if (!_bannerCoinOf) return assert.fail("fulfillment must export _bannerCoinOf");
  const row = { sym: "$X", name: "X", chain: "solana" };
  assert.match(_bannerCoinOf(row, { priceUsd: 1, mcap: 1e6, liq: 131200 }).liq, /^\$131/);
  assert.strictEqual(_bannerCoinOf(row, { priceUsd: 1, mcap: 1e6, liq: 0 }).liq, null);
  assert.strictEqual(_bannerCoinOf(row, null).liq, null);
});

/** The lowest and highest lit rows of a ticker, in CANVAS coordinates. */
function tickerRows(symbol) {
  const tk = lm._tickerSprites(cv, symbol);
  const { data } = tk.mask.getContext("2d").getImageData(0, 0, tk.w, tk.h);
  let top = -1;
  let bottom = -1;
  for (let y = 0; y < tk.h; y++) {
    for (let x = 0; x < tk.w; x++) {
      if (data[(y * tk.w + x) * 4 + 3] > 64) {
        if (top < 0) top = y;
        bottom = y;
        break;
      }
    }
  }
  return { tk, top: tk.y + top, bottom: tk.y + bottom };
}

test("a ticker whose glyphs sit low in the em box is lifted clear of the name line; a Latin one is not moved", { skip: !haveCanvas }, () => {
  // `$牛来` reached the channel with its Han glyphs touching the name beneath
  // it: Han and Hangul fill the em box lower than Latin caps, and the ticker is
  // placed on a middle baseline. Measured on the PIXELS, not the metrics.
  const latin = tickerRows("$AMD");
  assert.strictEqual(latin.tk.lift, 0, "a Latin ticker with no descender must sit exactly where it always did");
  for (const sym of ["$牛来", "$한글토큰", "$QUEJ"]) {
    const r = tickerRows(sym);
    assert.ok(r.tk.lift > 0, `${sym} was not lifted`);
    assert.ok(r.bottom <= latin.bottom + 1, `${sym} still hangs ${r.bottom - latin.bottom}px below the "$" into the name line`);
    // the NEW LISTING pill ends at y=214; the lift must never reach it
    assert.ok(r.top >= 222, `${sym} was lifted into the NEW LISTING pill (top ${r.top})`);
  }
});

// "vidionya aga blur tidak hd": X re-encodes every video and autoplays a
// 480–640px-wide variant in the timeline, so the clip is seen at 0.375–0.5 of
// its size. The labels were drawn at 10–10.5px — under 4px on a phone, the
// first thing compression smears. Measured on what is DRAWN (fillText /
// strokeText), not on fonts merely set for measuring.
async function drawnSizes(coin, badge) {
  const proto = Object.getPrototypeOf(cv.createCanvas(4, 4).getContext("2d"));
  const seen = [];
  const orig = { fill: proto.fillText, stroke: proto.strokeText };
  const px = (f) => parseFloat((/(\d+(?:\.\d+)?)px/.exec(String(f)) || [])[1]);
  proto.fillText = function (t, ...r) { seen.push({ t: String(t), px: px(this.font) }); return orig.fill.call(this, t, ...r); };
  proto.strokeText = function (t, ...r) { seen.push({ t: String(t), px: px(this.font) }); return orig.stroke.call(this, t, ...r); };
  try {
    await lm.frames(coin, null, { count: 1, badge });
  } finally {
    proto.fillText = orig.fill;
    proto.strokeText = orig.stroke;
  }
  return seen;
}

const WIDE = { symbol: "$ABCDEFGHIJKLMNOP", name: "A Very Long Project Name That Goes On And On Forever Ok", chain: "ROBINHOOD", price: "$0.0000000000042", mcap: "$999B", liq: "$999M" };
const PUMP = { symbol: "$APECHECK", name: "Ape Check", chain: "ROBINHOOD", price: "$0.0000004751", mcap: "$4.3K", liq: "$360" };

test("no text on the clip is drawn under the label floor — X's small variant smears anything smaller", { skip: !haveCanvas }, async () => {
  for (const [coin, badge] of [[COIN, "Xpress Listing"], [WIDE, "Platinum Tier"], [PUMP, "Gold Tier"]]) {
    const seen = await drawnSizes(coin, badge);
    assert.ok(seen.length > 20, "the recorder saw the card being drawn");
    const small = seen.filter((s) => !(s.px >= lm._labelMin));
    assert.deepStrictEqual(small, [], `${coin.symbol}: drawn under ${lm._labelMin}px: ${JSON.stringify(small.slice(0, 6))}`);
    // vacuity: the labels really are among what was measured — tracked labels
    // are drawn one glyph at a time, so the floor itself must appear
    assert.ok(seen.some((s) => s.px === lm._labelMin), "no label was drawn at the floor — the recorder is not seeing the labels");
  }
});

test("the stat panel stays clear of the gem bubble beside it, and the labels never squeeze the values smaller than they were", { skip: !haveCanvas }, () => {
  const b = lm._bubbles[1];
  // the last one is what fmtPrice prints for 4.2e-15: the widest price it can
  // spell before it switches to an exponent
  for (const c of [COIN, WIDE, PUMP, { ...PUMP, chain: "ETHEREUM", price: "$12,345.60", mcap: "$2.4B", liq: "$123M" }, { ...WIDE, price: "$0.0000000000000042" }]) {
    const st = lm._statsLayout(cv, c);
    const right = st.x + 2 + st.w + 2; // + the 1.2px stroke, rounded up
    assert.ok(right < b.x - b.r, `${c.chain} ${c.price}: panel right edge ${Math.round(right)} reaches the bubble at ${b.x - b.r}`);
  }
  // a pump.fun-shaped price is the commonest wide case; before the labels grew
  // its values were drawn at 23px, and bigger labels must not cost them that
  const px = (st) => parseFloat(/(\d+)px/.exec(st.font)[1]);
  assert.ok(px(lm._statsLayout(cv, PUMP)) >= 23, `pump-case values shrank to ${px(lm._statsLayout(cv, PUMP))}px`);
  assert.ok(px(lm._statsLayout(cv, COIN)) >= 28, "an ordinary token's values are drawn large");
  // wider than anything fmtPrice spells: the panel may run wide here, but no
  // value is ever drawn under the label floor to avoid it
  const absurd = { chain: "BERACHAIN", price: "$0.00000000000000000000000000042", mcap: "$999,999,999.9T", liq: "$999,999,999.9M" };
  assert.strictEqual(px(lm._statsLayout(cv, absurd)), lm._labelMin, "the value floor is the label floor");
});
