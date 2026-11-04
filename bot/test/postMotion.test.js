"use strict";
// The listing clip's two siblings: the TRENDING post and the PUMP ALERT
// ("buatkan vidio untuk pump alert serta trending jugaa"). One renderer, three
// sets of words — these tests pin what each variant draws, that every one of
// them keeps the loop and the label floor the listing was held to, and that the
// pump path asks for its clip before the admin clip and the text fallback.
process.env.BOT_DATA_DIR = process.env.BOT_DATA_DIR || require("node:fs").mkdtempSync(require("node:path").join(require("node:os").tmpdir(), "dexvra-pm-"));
// the budget is read at require time; the hang test must not wait a minute
process.env.CLIP_BUDGET_MS = "2000";
const test = require("node:test");
const assert = require("node:assert");
const lm = require("../src/listingMotion");
const { canvasLib } = require("../src/helpers/canvasKit");

const cv = canvasLib();
const haveCanvas = !!cv;

const TREND = { symbol: "$VETO", name: "Mr Veto", chain: "SOLANA", price: "$0.000227", mcap: "$218.8K", liq: "$45K" };
const PUMP = {
  symbol: "$APECHECK",
  name: "Ape Check",
  chain: "ROBINHOOD",
  change: "+250%",
  priceFrom: "$0.0000004751",
  priceTo: "$0.000001663",
  mcap: "$15.1K",
};

/** Every string drawn at time `t`, with tracked (one-glyph-at-a-time) runs on
 *  one baseline re-joined, so a tracked label reads as one string. */
async function drawnAt(coin, opts, times = [0]) {
  const proto = Object.getPrototypeOf(cv.createCanvas(4, 4).getContext("2d"));
  const orig = { fill: proto.fillText, stroke: proto.strokeText };
  const perFrame = [];
  let cur = [];
  const px = (f) => parseFloat((/(\d+(?:\.\d+)?)px/.exec(String(f)) || [])[1]);
  const rec = function (t, x, y) {
    cur.push({ t: String(t), x, y: Math.round(y), px: px(this.font) });
  };
  proto.fillText = function (t, ...r) { rec.call(this, t, ...r); return orig.fill.call(this, t, ...r); };
  proto.strokeText = function (t, ...r) { rec.call(this, t, ...r); return orig.stroke.call(this, t, ...r); };
  try {
    await lm._drawFrames(coin, null, {
      ...opts,
      times,
      onFrame: () => {
        perFrame.push(cur);
        cur = [];
      },
    });
  } finally {
    proto.fillText = orig.fill;
    proto.strokeText = orig.stroke;
  }
  return perFrame.map((list) => {
    // join single glyphs that share a baseline and a size into runs
    const runs = [];
    for (const s of list) {
      const last = runs[runs.length - 1];
      // a tracked label's next glyph is a glyph-width away; the panel's next
      // label starts a whole column over, so it is a new run
      if (s.t.length === 1 && last && last.single && last.y === s.y && last.px === s.px && s.x - last.x < 30) {
        last.t += s.t;
        last.x = s.x;
      } else runs.push({ ...s, single: s.t.length === 1 });
    }
    return runs.map((r) => r.t);
  });
}

test("statsOf: a pump shows the move (LISTED AT → NOW) and the cap; the network rides the badge", () => {
  assert.deepStrictEqual(lm.statsOf(PUMP, "pump"), [
    ["LISTED AT", "$0.0000004751"],
    ["NOW", "$0.000001663"],
    ["MARKET CAP", "$15.1K"],
  ]);
  // NOW falls back to the card's price; an unknown figure is LEFT OUT, never TBA
  assert.deepStrictEqual(lm.statsOf({ priceFrom: "TBA", price: "$0.01", mcap: null }, "pump"), [["NOW", "$0.01"]]);
  // a trending post carries exactly the listing's panel
  assert.deepStrictEqual(lm.statsOf(TREND, "trending"), lm.statsOf(TREND));
});

test("each post has its own switch; blank is ON, an unknown kind is never on", () => {
  const keys = ["LISTING_MOTION", "TRENDING_MOTION", "PUMP_MOTION"];
  const prev = keys.map((k) => process.env[k]);
  try {
    for (const k of keys) process.env[k] = "";
    assert.strictEqual(lm.enabled("trending"), true, "blank must be ON");
    assert.strictEqual(lm.enabled("pump"), true);
    process.env.PUMP_MOTION = "0";
    assert.strictEqual(lm.enabled("pump"), false);
    assert.strictEqual(lm.enabled("trending"), true, "one switch does not move another");
    assert.strictEqual(lm.enabled("listing"), true);
    assert.strictEqual(lm.enabled("banner"), false, "a kind with no clip is never on");
  } finally {
    keys.forEach((k, i) => {
      if (prev[i] === undefined) delete process.env[k];
      else process.env[k] = prev[i];
    });
  }
});

test("the trending clip says NOW TRENDING and wears its run's badge — never NEW LISTING", { skip: !haveCanvas }, async () => {
  const [drawn] = await drawnAt(TREND, { badge: "Trending 24H", variant: "trending" });
  assert.ok(drawn.includes("NOW TRENDING"), `drawn: ${JSON.stringify(drawn)}`);
  assert.ok(drawn.includes("TRENDING 24H"));
  assert.ok(!drawn.includes("NEW LISTING"), "a trending post must not announce a new listing");
  assert.ok(drawn.includes("Mr Veto"), "the name stays on a trending post");
});

test("the pump clip says PUMP ALERT and puts the GAIN where the name goes", { skip: !haveCanvas }, async () => {
  const [drawn] = await drawnAt(PUMP, { badge: "Robinhood", variant: "pump" });
  for (const want of ["PUMP ALERT", "+250%", "SINCE LISTING", "LISTED AT", "NOW", "MARKET CAP", "ROBINHOOD"]) {
    assert.ok(drawn.includes(want), `missing ${want}: ${JSON.stringify(drawn)}`);
  }
  assert.ok(!drawn.includes("Ape Check"), "the gain takes the name's line");
  assert.ok(!drawn.includes("NETWORK"), "the network rides the badge, not the panel");
  assert.ok(!drawn.includes("NEW LISTING"));
});

test("only the PUMP draws a gain — a trending or listing coin carrying a change still shows its name", { skip: !haveCanvas }, async () => {
  for (const [variant, badge] of [["trending", "Trending 24H"], ["listing", "Gold Tier"]]) {
    const [drawn] = await drawnAt({ ...TREND, change: "+40%" }, { badge, variant });
    assert.ok(drawn.includes("Mr Veto"), `${variant}: the name must stay`);
    assert.ok(!drawn.includes("SINCE LISTING") && !drawn.includes("+40%"), `${variant} drew a pump's gain line`);
  }
});

test("a change that is not a readable percentage falls back to the NAME — never a made-up figure", { skip: !haveCanvas }, async () => {
  for (const change of [null, "", "+?", "12x", "+1.5%"]) {
    const [drawn] = await drawnAt({ ...PUMP, change }, { badge: "Robinhood", variant: "pump" });
    assert.ok(drawn.includes("Ape Check"), `${change}: the name should take the line`);
    assert.ok(!drawn.includes("SINCE LISTING"), `${change}: no gain line without a gain`);
  }
});

test("the gain counts UP on the way in, holds the exact figure, and never counts down on the exit", { skip: !haveCanvas }, async () => {
  const { HOLD_END, OUT_END } = lm._timeline;
  const gainOf = (drawn) => {
    const g = drawn.find((s) => /^\+\d+%$/.test(s));
    return g ? Number(g.slice(1, -1)) : null;
  };
  // frame 0 (Telegram's thumbnail), mid-hold, mid-exit, then early in the intro
  const times = [0, 2, (HOLD_END + OUT_END) / 2, OUT_END + 1.25];
  const frames = await drawnAt(PUMP, { badge: "Robinhood", variant: "pump" }, times);
  assert.strictEqual(gainOf(frames[0]), 250, "frame 0 carries the exact gain");
  assert.strictEqual(gainOf(frames[1]), 250);
  assert.strictEqual(gainOf(frames[2]), 250, "the exit fades the exact figure — a number running backwards reads as the pump reversing");
  const early = gainOf(frames[3]);
  assert.ok(early !== null && early > 0 && early < 250, `mid-intro the gain should be counting up, got ${early}`);
});

test("every variant keeps the loop EXACT: t = SECONDS draws what frame 0 draws", { skip: !haveCanvas }, async () => {
  for (const [coin, badge, variant] of [[TREND, "Trending 24H", "trending"], [PUMP, "Robinhood", "pump"]]) {
    const got = [];
    await lm._drawFrames(coin, null, { times: [0, lm._timeline.SECONDS], badge, variant, onFrame: (b) => got.push(Buffer.from(b)) });
    let off = 0;
    for (let i = 0; i < got[0].length; i++) if (Math.abs(got[0][i] - got[1][i]) > 12) off++;
    assert.ok(off < 40, `${variant}: ${off} channel bytes differ between t=0 and t=${lm._timeline.SECONDS}s`);
  }
});

test("no variant draws text under the label floor, and the pump panel stays clear of the bubble", { skip: !haveCanvas }, async () => {
  const proto = Object.getPrototypeOf(cv.createCanvas(4, 4).getContext("2d"));
  for (const [coin, badge, variant] of [[TREND, "Trending 24H", "trending"], [PUMP, "Robinhood", "pump"]]) {
    const seen = [];
    const orig = proto.fillText;
    proto.fillText = function (t, ...r) {
      seen.push(parseFloat((/(\d+(?:\.\d+)?)px/.exec(String(this.font)) || [])[1]));
      return orig.call(this, t, ...r);
    };
    try {
      await lm.frames(coin, null, { count: 1, badge, variant });
    } finally {
      proto.fillText = orig;
    }
    assert.ok(seen.length > 20);
    assert.deepStrictEqual(seen.filter((px) => !(px >= lm._labelMin)), [], `${variant}: text under ${lm._labelMin}px`);
  }
  const b = lm._bubbles[1];
  const st = lm._statsLayout(cv, PUMP, "pump");
  assert.ok(st.x + 2 + st.w + 2 < b.x - b.r, `pump panel right edge ${Math.round(st.x + st.w + 4)} reaches the bubble`);
  // the gain line fits the copy column at the widest gain the regex admits
  const g = lm._gainLayout(cv, "+9999999%");
  assert.ok(g.w < 620, `gain line ${Math.round(g.w)}px runs past the copy column`);
});

test("render() really draws the variant it was asked for — the MP4's first frame is the PUMP card", { skip: !haveCanvas }, async () => {
  let ff = null;
  try {
    ff = require("@ffmpeg-installer/ffmpeg").path;
  } catch {
    ff = null;
  }
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  if (!ff || !fs.existsSync(ff)) return;
  const { spawnSync } = require("node:child_process");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pm-render-"));
  const out = path.join(dir, "pump.mp4");
  try {
    const res = await lm.render(PUMP, null, { badge: "Robinhood", variant: "pump", outPath: out });
    assert.deepStrictEqual(res, { type: "animation", source: out });
    const raw = spawnSync(ff, ["-v", "error", "-i", out, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"], { maxBuffer: 16 << 20 }).stdout;
    const [pump] = await lm.frames(PUMP, null, { count: 1, badge: "Robinhood", variant: "pump" });
    const [listing] = await lm.frames(PUMP, null, { count: 1, badge: "Robinhood" });
    const diff = (a, b) => {
      let sum = 0, n = 0;
      for (let i = 0; i < a.length; i += 7) { sum += Math.abs(a[i] - b[i]); n++; }
      return sum / n;
    };
    assert.ok(diff(raw, pump) < 6, `encoded frame drifted ${diff(raw, pump).toFixed(2)} from the drawn pump card`);
    // vacuity: the two cards really differ, or the assertion above proves nothing
    assert.ok(diff(pump, listing) > diff(raw, pump) + 0.5, "the pump and listing cards are indistinguishable here");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── the pump path ────────────────────────────────────────────────────────────

const pumpChecker = require("../src/services/pumpChecker");
const bannerTemplate = require("../src/bannerTemplate");

function withPump(value, fn) {
  return async () => {
    const prev = process.env.PUMP_MOTION;
    process.env.PUMP_MOTION = value;
    const real = { render: lm.render, override: bannerTemplate.mediaOverride, posting: bannerTemplate.postingEnabled };
    try {
      await fn();
    } finally {
      lm.render = real.render;
      bannerTemplate.mediaOverride = real.override;
      bannerTemplate.postingEnabled = real.posting;
      if (prev === undefined) delete process.env.PUMP_MOTION;
      else process.env.PUMP_MOTION = prev;
    }
  };
}

const ROW = { sym: "$APECHECK", name: "Ape Check", chain: "robinhood", address: "0xabc", logoUrl: "" };
const BASE = { price: 0.0000004751, mcap: 4300 };
const NOW = { priceUsd: 0.000001663, mcap: 15100 };

test(
  "a pump alert asks for the motion clip FIRST — with the gain, the two prices and the chain as its badge",
  withPump("1", async () => {
    const calls = [];
    lm.render = async (coin, logoBuf, opts) => {
      calls.push({ coin, opts });
      return { type: "animation", source: "/tmp/pump.mp4" };
    };
    let asked = 0;
    bannerTemplate.mediaOverride = () => {
      asked++;
      return null;
    };
    bannerTemplate.postingEnabled = () => true;
    const media = await pumpChecker._pumpMedia(ROW, BASE, NOW, 250);
    assert.deepStrictEqual(media, { type: "animation", source: "/tmp/pump.mp4" });
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].opts.variant, "pump");
    assert.match(calls[0].opts.badge, /robinhood/i);
    assert.strictEqual(calls[0].coin.change, "+250%");
    assert.ok(calls[0].coin.priceFrom && calls[0].coin.priceTo, "both prices travel");
    assert.strictEqual(calls[0].coin.mcap, "$15.1K");
    assert.strictEqual(asked, 0, "the admin clip is not consulted once the motion clip answered");
  }),
);

test(
  "a pump with no admin clip used to be a TEXT reply; it is a clip now — and still text when the clip fails",
  withPump("1", async () => {
    bannerTemplate.mediaOverride = () => null;
    bannerTemplate.postingEnabled = () => true;
    lm.render = async () => null;
    assert.strictEqual(await pumpChecker._pumpMedia(ROW, BASE, NOW, 100), null, "a failed render falls to the old ladder");
  }),
);

test(
  "PUMP_MOTION=0 and the admin banner switch both restore the old ladder exactly",
  withPump("0", async () => {
    let called = 0;
    lm.render = async () => {
      called++;
      return { type: "animation", source: "/tmp/pump.mp4" };
    };
    bannerTemplate.mediaOverride = () => null;
    bannerTemplate.postingEnabled = () => true;
    assert.strictEqual(await pumpChecker._pumpMedia(ROW, BASE, NOW, 100), null);
    process.env.PUMP_MOTION = "1";
    bannerTemplate.postingEnabled = () => false;
    assert.strictEqual(await pumpChecker._pumpMedia(ROW, BASE, NOW, 100), null, "banners switched off in the admin bot means no drawn artwork");
    assert.strictEqual(called, 0);
  }),
);

test(
  "a pump render that HANGS is abandoned at the budget AND told to stop",
  withPump("1", async () => {
    let seen = null;
    lm.render = (coin, logoBuf, opts) => {
      seen = opts.cancel;
      return new Promise(() => {});
    };
    bannerTemplate.mediaOverride = () => null;
    bannerTemplate.postingEnabled = () => true;
    const t0 = Date.now();
    const media = await pumpChecker._pumpMedia(ROW, BASE, NOW, 100);
    assert.ok(Date.now() - t0 < 6000, "bounded by CLIP_BUDGET_MS");
    assert.strictEqual(media, null);
    assert.ok(seen && seen.cancelled === true);
  }),
);
