"use strict";
// The PREMIUM animated listing banner — a looping MP4 drawn frame by frame.
//
// "bisakah anda buatkan gif premium gif listing lebih bagus premium dari gif
// sebelumnya" (2026-11-04), then, over the first cut: "gif video looks bad buat
// lebih premium ada animasi visualnya", then "ini jelek banget, saya ingin
// sesuai brand kita biru". The first cut was a still card with a little drift;
// the second a gold motion piece; this one is that motion in the BRAND — the
// gem's mint → cyan on deep ocean blue, with the bundled listing artwork's own
// furniture (the mint → cyan coin ring, the dashed ring, the gem bubbles).
//
// ⚠️ THIS IS THE LAYOUT THE OPERATOR CHOSE OVER A REDESIGN. Asked for something
// "berbeda lebih bagus dan premium", a centred cinematic poster was built
// (git a89ebdf) and rejected harder: "lol malah lebih jelek, mending
// sebelumnya". Different was not better — change THIS one, don't replace it.
// Each loop:
//
//   0.0–3.2s  HOLD    the full card, alive: aurora ribbons, soft light rays,
//                     orbiting lights, floating gem bubbles, rising motes, the
//                     coin floating on its pedestal, one full 3D coin spin
//                     (its reverse carries the Dexvra mark), ticker shimmers
//   3.2–3.8s  OUTRO   the coin spins away, the copy fades, a light sweep crosses
//   3.8–6.0s  INTRO   the coin flies in spinning and LANDS — flash, shockwave,
//                     a burst of sparks — then the ticker wipes in, the name
//                     rises, the stat panel opens and its numbers decode
//
// FRAME 0 IS THE FULL CARD, deliberately: Telegram makes the thumbnail and the
// notification preview from the first frame, and a loop that opened on an
// empty stage would preview as a blank. So the loop starts in the HOLD and the
// build plays mid-loop.
//
// THE LOOP IS SEAMLESS BY CONSTRUCTION. Every ambient motion is a function of
// p = t / SECONDS with a whole number of periods per loop, and every element
// the intro builds has settled before the loop wraps.
//
// FAILURE IS FREE. render() returns null on any failure (no canvas, no ffmpeg,
// a draw that throws) and the caller falls back to the ladder it already has.
// Never throws.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
const { spawn } = require("node:child_process");
const log = require("./helpers/logger");
const kit = require("./helpers/canvasKit");
const { CHANNELS, SITE_URL, X_LISTING_HANDLE } = require("./config/constants");
const { sourceEnabled } = require("./raid/sourceFlag");

const { F, SITE, hexA, roundRect, fitText, drawBrandMark, warnBoxes } = kit;

// 2:1 at 1280 wide — the size every other channel clip is normalised to.
const W = 1280;
const H = 640;
const FPS = 25;
const SECONDS = 6;
const FRAMES = FPS * SECONDS;
const TAU = Math.PI * 2;

// THE DEXVRA BRAND, not gold: "ini jelek banget, saya ingin sesuai brand kita
// biru". The gem's own mint → cyan (canvasKit drawBrandMark, the bundled
// banner artwork) on deep ocean blue. Every accent below reads from here.
const C = {
  light: "#D8FAFF", // ice — highlights, foil tops
  mid: "#22D3EE", // the brand cyan
  dark: "#0A6E9C", // deep cyan — shadows on metal
  glow: "#22D3EE",
  blue: "#2F86FF", // electric blue — depth
  mint: "#3DF59F", // the gem's mint
};
const COIN = { cx: 958, cy: 286, r: 138 };
const BEZEL = 13; // the gold rim beyond the face, in px at scale 1
const PEDESTAL = { cx: 958, cy: 500, rx: 182, ry: 30 };

// ── the timeline (seconds) ───────────────────────────────────────────────────
const HOLD_END = 3.2;
const OUT_END = 3.8;
const IN0 = OUT_END;
// [delay, duration] after IN0 — every entry ends by 2.2s, so it is settled
// (and identical to frame 0) when the loop wraps.
const SCHED = {
  coin: [0, 0.9],
  pill: [0.66, 0.4],
  ticker: [0.76, 0.6],
  name: [1.12, 0.45],
  rule: [1.22, 0.45],
  stats: [1.3, 0.45], // + STAT_STAGGER per block
  bubbles: [0.72, 0.5],
};
const STAT_STAGGER = 0.12;
// the coin ARRIVES (≥98% of its size) about three quarters into its flight;
// the landing fires then, not when the last 2% of the easing runs out
const IMPACT = IN0 + SCHED.coin[0] + SCHED.coin[1] * 0.72;
const SPIN = [1.0, 1.9]; // the one full coin spin inside the hold

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const easeOut = (x) => 1 - (1 - x) ** 3;
const easeIn = (x) => x ** 3;
const easeInOut = (x) => (x < 0.5 ? 4 * x ** 3 : 1 - (-2 * x + 2) ** 3 / 2);
const easeOutBack = (x) => {
  const s = 1.7;
  return 1 + (s + 1) * (x - 1) ** 3 + s * (x - 1) ** 2;
};

/** 0→1→0 bump over [a, b], smooth at both ends; 0 outside it. */
function window01(p, a, b) {
  if (p < a || p > b) return 0;
  const t = (p - a) / (b - a);
  return Math.sin(t * Math.PI) ** 2;
}

/** How far an element is IN (0 hidden → 1 in place), linear: 1 through the
 *  hold, falling through the outro, then its own schedule in the intro. The
 *  caller eases it, so one easing serves both the exit and the entrance. */
function reveal(t, key, i = 0) {
  if (t < HOLD_END) return 1;
  if (t < OUT_END) return 1 - (t - HOLD_END) / (OUT_END - HOLD_END);
  const [d, dur] = SCHED[key];
  return clamp01((t - IN0 - d - i * STAT_STAGGER) / dur);
}

/** Where the coin is: scale, Y-axis angle, opacity and its float. */
function coinState(t) {
  const bob = 6 * Math.sin((TAU * t) / SECONDS);
  let s = 1;
  let theta = 0;
  let alpha = 1;
  if (t < HOLD_END) {
    theta = TAU * easeInOut(clamp01((t - SPIN[0]) / (SPIN[1] - SPIN[0])));
  } else if (t < OUT_END) {
    const u = (t - HOLD_END) / (OUT_END - HOLD_END);
    s = 1 - easeIn(u);
    theta = -3 * Math.PI * easeIn(u);
    alpha = 1 - clamp01((u - 0.55) / 0.45);
  } else {
    const u = clamp01((t - IN0 - SCHED.coin[0]) / SCHED.coin[1]);
    s = easeOut(u);
    theta = 4 * Math.PI * (1 - easeOut(u));
    alpha = clamp01(u / 0.22);
    const v = t - IMPACT;
    if (v > 0) s *= 1 + 0.08 * Math.exp(-v * 7) * Math.sin(v * 30); // the landing settles
  }
  return { s, theta, alpha, bob };
}

/** How hard the landing still rings: 1 at impact, decaying to EXACTLY 0 at the
 *  end of the loop — a bare exponential would still be a few percent up when
 *  the loop wraps, and the rays would visibly step at the seam. */
function impactBoost(t, rate = 3) {
  const v = t - IMPACT;
  if (v < 0) return 0;
  const end = Math.exp(-(SECONDS - IMPACT) * rate);
  return Math.max(0, (Math.exp(-v * rate) - end) / (1 - end));
}

// ── seeded fields (identical every render, and in tests) ────────────────────

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash3(a, b, c) {
  let h = (Math.imul(a | 0, 374761393) + Math.imul(b | 0, 668265263) + Math.imul(c | 0, 1274126177)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1103515245) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

const FIELD = (() => {
  const r = rng(20261104);
  const sparkles = Array.from({ length: 26 }, () => ({
    x: 40 + r() * (W - 80),
    y: 40 + r() * (H - 80),
    size: 5 + r() * 9,
    phase: r(),
    cycles: 1 + Math.floor(r() * 2),
    gold: r() < 0.75,
  }));
  const bokeh = Array.from({ length: 16 }, () => ({
    x: r() * W,
    y: r() * H,
    size: 26 + r() * 70,
    phase: r(),
    drift: 14 + r() * 26,
    a: 0.05 + r() * 0.07,
    cyan: r() < 0.35,
  }));
  const motes = Array.from({ length: 34 }, () => ({
    ox: (r() * 2 - 1) * 0.85,
    phase: r(),
    cycles: 1 + Math.floor(r() * 2),
    rise: 170 + r() * 150,
    size: 1.2 + r() * 2.2,
    sway: 4 + r() * 10,
  }));
  const sparks = Array.from({ length: 72 }, () => ({
    a: r() * TAU,
    speed: 380 + r() * 760,
    life: 0.55 + r() * 0.6,
    w: 1.2 + r() * 1.9,
    white: r() < 0.3,
  }));
  return { sparkles, bokeh, motes, sparks };
})();

const RIBBONS = [
  { y: 486, amp: 44, f1: 0.0049, f2: 0.0107, k1: 1, k2: -1, color: C.mid, a: 0.9 },
  { y: 540, amp: 34, f1: 0.0058, f2: 0.0091, k1: -1, k2: 2, color: C.blue, a: 0.8 },
  { y: 128, amp: 28, f1: 0.0042, f2: 0.0099, k1: 1, k2: 1, color: C.mint, a: 0.4 },
];

const ORBITS = [
  { rx: 236, ry: 56, tilt: -0.3, color: "gold", dots: 3, speed: 1 },
  { rx: 212, ry: 70, tilt: 0.4, color: "cyan", dots: 2, speed: -1 },
];

// ── small drawing helpers ────────────────────────────────────────────────────

function foil(ctx, y0, y1) {
  const g = ctx.createLinearGradient(0, y0, 0, y1);
  g.addColorStop(0, "#FFFFFF");
  g.addColorStop(0.45, C.light);
  g.addColorStop(0.78, C.mid);
  g.addColorStop(1, "#1E8FD8");
  return g;
}

function softGlow(ctx, cx, cy, r, color, a) {
  if (a <= 0 || r <= 0) return;
  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
  g.addColorStop(0, hexA(color, Math.min(1, a)));
  g.addColorStop(1, hexA(color, 0));
  ctx.fillStyle = g;
  ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
}

function tracked(ctx, text, x, y, spacing) {
  let cx = x;
  for (const ch of String(text)) {
    ctx.fillText(ch, cx, y);
    cx += ctx.measureText(ch).width + spacing;
  }
  return cx - x - spacing;
}
function trackedWidth(ctx, text, spacing) {
  let w = 0;
  for (const ch of String(text)) w += ctx.measureText(ch).width + spacing;
  return Math.max(0, w - spacing);
}

const pxOf = (font, dflt) => {
  const m = /(\d+(?:\.\d+)?)px/.exec(String(font));
  return m ? parseFloat(m[1]) : dflt;
};

const tickerOf = (symbol) => `$${String(symbol || "").replace(/^\$+/, "").toUpperCase()}`;
const hostOf = (url) => String(url || "").replace(/^https?:\/\//, "").replace(/\/.*$/, "");

/** The stat blocks the panel carries — a missing figure is LEFT OUT, never
 *  printed as a dash or a zero (the post's caption already says TBA). */
function statsOf(coin) {
  const out = [];
  if (coin.chain) out.push(["NETWORK", String(coin.chain).toUpperCase()]);
  if (coin.price && coin.price !== "TBA") out.push(["PRICE", String(coin.price)]);
  if (coin.mcap) out.push(["MARKET CAP", String(coin.mcap)]);
  if (coin.liq) out.push(["LIQUIDITY", String(coin.liq)]);
  return out;
}

/** A value mid-decode: the first `q` of it resolved, the remaining DIGITS
 *  cycling. Symbols ($ . , M K) never scramble, so the shape reads from the
 *  first frame. q = 1 is the exact text. */
function scramble(text, q, t, seed) {
  const chars = [...String(text)];
  const n = Math.floor(q * chars.length + 1e-9);
  if (n >= chars.length) return String(text);
  const step = Math.floor(t * 16);
  return chars.map((ch, i) => (i < n || !/[0-9]/.test(ch) ? ch : String(hash3(seed, i, step) % 10))).join("");
}

/** A soft round sprite in `color`, drawn scaled — far cheaper than a radial
 *  gradient per particle per frame. */
function glowSprite(cv, color, hard = 0.25) {
  const c = cv.createCanvas(64, 64);
  const x = c.getContext("2d");
  const g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, hexA("#FFFFFF", 1));
  g.addColorStop(hard, hexA(color, 0.9));
  g.addColorStop(1, hexA(color, 0));
  x.fillStyle = g;
  x.fillRect(0, 0, 64, 64);
  return c;
}

function blit(ctx, sprite, x, y, size, alpha) {
  if (alpha <= 0.002 || size <= 0) return;
  ctx.globalAlpha = Math.min(1, alpha);
  ctx.drawImage(sprite, x - size / 2, y - size / 2, size, size);
}

// ── static layers (drawn once per render) ────────────────────────────────────

function drawBase(ctx) {
  const g = ctx.createRadialGradient(W * 0.72, H * 0.42, 30, W * 0.55, H * 0.5, W * 0.85);
  g.addColorStop(0, "#0C3047");
  g.addColorStop(0.5, "#06192A");
  g.addColorStop(1, "#01060B");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "rgba(255,255,255,0.028)";
  for (let y = 14; y < H; y += 26) for (let x = 14; x < W; x += 26) ctx.fillRect(x, y, 1.2, 1.2);
}

function drawVignette(ctx) {
  const v = ctx.createRadialGradient(W / 2, H / 2, H * 0.36, W / 2, H / 2, W * 0.74);
  v.addColorStop(0, "rgba(0,0,0,0)");
  v.addColorStop(1, "rgba(0,0,0,0.66)");
  ctx.fillStyle = v;
  ctx.fillRect(0, 0, W, H);
  // a soft left shade so the copy column always reads over the ribbons
  const l = ctx.createLinearGradient(0, 0, 700, 0);
  l.addColorStop(0, "rgba(2,4,9,0.55)");
  l.addColorStop(1, "rgba(2,4,9,0)");
  ctx.fillStyle = l;
  ctx.fillRect(0, 0, 700, H);
}

const FRAME_INSET = 16;
const FRAME_RADIUS = 22;

function drawFrameLines(ctx) {
  roundRect(ctx, FRAME_INSET, FRAME_INSET, W - FRAME_INSET * 2, H - FRAME_INSET * 2, FRAME_RADIUS);
  ctx.lineWidth = 1.4;
  ctx.strokeStyle = hexA(C.mid, 0.26);
  ctx.stroke();
  roundRect(ctx, FRAME_INSET + 6, FRAME_INSET + 6, W - (FRAME_INSET + 6) * 2, H - (FRAME_INSET + 6) * 2, 18);
  ctx.lineWidth = 1;
  ctx.strokeStyle = hexA(C.mid, 0.1);
  ctx.stroke();
  const L = 30;
  const o = FRAME_INSET + 2;
  ctx.strokeStyle = hexA(C.light, 0.8);
  ctx.lineWidth = 2;
  ctx.lineCap = "round";
  for (const [x, y, sx, sy] of [[o, o, 1, 1], [W - o, o, -1, 1], [o, H - o, 1, -1], [W - o, H - o, -1, -1]]) {
    ctx.beginPath();
    ctx.moveTo(x, y + sy * L);
    ctx.lineTo(x, y);
    ctx.lineTo(x + sx * L, y);
    ctx.stroke();
  }
  ctx.lineCap = "butt";
}

/** Brand at top-left, the package badge at top-right. Returns the badge box. */
function drawBrand(ctx, badge) {
  drawBrandMark(ctx, 54, 46, 52);
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = SITE.text;
  ctx.font = `800 28px ${F.x}`;
  ctx.fillText("Dexvra", 118, 72);
  ctx.fillStyle = hexA(C.light, 0.8);
  ctx.font = `700 10.5px ${F.m7}`;
  tracked(ctx, "TOKEN VISIBILITY", 119, 91, 2.6);
  if (!badge) return null;
  const text = String(badge).toUpperCase().slice(0, 28);
  ctx.font = `700 12px ${F.m7}`;
  const tw = trackedWidth(ctx, text, 2.2);
  const h = 32;
  const w = tw + 38;
  const x = W - 58 - w;
  const y = 50;
  roundRect(ctx, x, y, w, h, h / 2);
  const bg = ctx.createLinearGradient(x, y, x, y + h);
  bg.addColorStop(0, hexA(C.mid, 0.2));
  bg.addColorStop(1, hexA(C.dark, 0.08));
  ctx.fillStyle = bg;
  ctx.fill();
  ctx.lineWidth = 1.3;
  ctx.strokeStyle = hexA(C.mid, 0.65);
  ctx.stroke();
  ctx.fillStyle = foil(ctx, y + 8, y + 24);
  ctx.textBaseline = "middle";
  tracked(ctx, text, x + 19, y + h / 2 + 1, 2.2);
  ctx.textBaseline = "alphabetic";
  return { x, y, w, h };
}

function icon(ctx, kind, x, y, s) {
  ctx.save();
  ctx.strokeStyle = hexA(C.light, 0.75);
  ctx.lineWidth = 1.6;
  ctx.lineJoin = "round";
  if (kind === "web") {
    ctx.beginPath();
    ctx.arc(x, y, s, 0, TAU);
    ctx.stroke();
    ctx.beginPath();
    ctx.ellipse(x, y, s * 0.45, s, 0, 0, TAU);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x - s, y);
    ctx.lineTo(x + s, y);
    ctx.stroke();
  } else if (kind === "tg") {
    ctx.beginPath();
    ctx.moveTo(x - s, y - s * 0.1);
    ctx.lineTo(x + s, y - s * 0.85);
    ctx.lineTo(x + s * 0.55, y + s * 0.9);
    ctx.lineTo(x - s * 0.15, y + s * 0.3);
    ctx.closePath();
    ctx.stroke();
  } else {
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x - s * 0.8, y - s * 0.85);
    ctx.lineTo(x + s * 0.8, y + s * 0.85);
    ctx.moveTo(x + s * 0.8, y - s * 0.85);
    ctx.lineTo(x - s * 0.8, y + s * 0.85);
    ctx.stroke();
  }
  ctx.restore();
}

function drawFooter(ctx) {
  const items = [
    ["web", hostOf(SITE_URL) || "dexvra.io"],
    ["tg", String(CHANNELS.listing || "").startsWith("@") ? CHANNELS.listing : `@${CHANNELS.listing || "dexvralisting"}`],
    ["x", `@${X_LISTING_HANDLE}`],
  ];
  let x = 70;
  const y = 588;
  ctx.font = `600 15px ${F.d6}`;
  ctx.textBaseline = "middle";
  for (const [k, text] of items) {
    icon(ctx, k, x + 9, y, 8);
    ctx.fillStyle = "#AEB8CA";
    ctx.fillText(text, x + 26, y + 1);
    x += 26 + ctx.measureText(text).width + 34;
  }
  ctx.font = `700 10.5px ${F.m7}`;
  ctx.fillStyle = hexA(C.light, 0.55);
  const t = "LISTED ON DEXVRA";
  tracked(ctx, t, W - 66 - trackedWidth(ctx, t, 2.6), y + 1, 2.6);
}

// ── copy sprites (each element is its own canvas, so the intro can move it) ──

const COPY_X = 66;
const COPY_W = 600;

function pillSprite(cv) {
  const label = "NEW LISTING";
  const m = cv.createCanvas(10, 10).getContext("2d");
  m.font = `700 14px ${F.m7}`;
  const lw = trackedWidth(m, label, 3);
  const w = Math.ceil(lw + 56);
  const c = cv.createCanvas(w + 4, 38);
  const x = c.getContext("2d");
  roundRect(x, 2, 2, w, 34, 17);
  x.fillStyle = "rgba(61,245,159,0.10)";
  x.fill();
  x.lineWidth = 1.3;
  x.strokeStyle = "rgba(61,245,159,0.5)";
  x.stroke();
  x.font = `700 14px ${F.m7}`;
  x.fillStyle = "#E9FFF4";
  x.textBaseline = "middle";
  tracked(x, label, 40, 20, 3);
  return { canvas: c, x: COPY_X - 2, y: 176, dot: { x: COPY_X + 20, y: 196 } };
}

/** The ticker in gold foil: a glow pass and a crisp pass, so the shimmer can be
 *  masked to the glyphs alone. */
function tickerSprites(cv, symbol) {
  const m = cv.createCanvas(10, 10).getContext("2d");
  const text = fitText(m, tickerOf(symbol), COPY_W, { weight: 800, size: 116, min: 54, family: F.x });
  const font = m.font;
  const size = pxOf(font, 116);
  const tw = m.measureText(text).width;
  // A script whose glyphs sit LOW in the em box (Han, Hangul; a Q or a J) hangs
  // past the "$" and into the name line, which is 21px below at this size. The
  // "$" is the floor every ticker shares, so a glyph that drops below it lifts
  // the whole ticker by the excess. A ticker whose lowest glyph is the "$"
  // (every Latin ticker with no descender) is placed exactly where it always
  // was. The 0.14em bound is belt-and-braces and no test can reach it: the
  // largest lift any bundled face produces is Han/Hangul at ~0.1em, and the
  // bound only matters for a face nobody has measured yet.
  m.textBaseline = "middle";
  const floor = m.measureText("$").actualBoundingBoxDescent;
  const lift = Math.min(Math.max(0, m.measureText(text).actualBoundingBoxDescent - floor), size * 0.14);
  const pad = 44;
  const cw = Math.ceil(tw + pad * 2);
  const ch = Math.ceil(size * 1.5 + pad);
  const mid = ch / 2;
  const mk = () => {
    const c = cv.createCanvas(cw, ch);
    const x = c.getContext("2d");
    x.font = font;
    x.textBaseline = "middle";
    return [c, x];
  };
  const [glow, gx] = mk();
  gx.shadowColor = hexA(C.glow, 0.5);
  gx.shadowBlur = 30;
  gx.fillStyle = foil(gx, mid - size * 0.5, mid + size * 0.62);
  gx.fillText(text, pad, mid);
  const [crisp, cx] = mk();
  cx.shadowColor = "rgba(0,0,0,0.6)";
  cx.shadowBlur = 8;
  cx.shadowOffsetY = 3;
  cx.fillStyle = foil(cx, mid - size * 0.5, mid + size * 0.62);
  cx.fillText(text, pad, mid);
  cx.shadowColor = "rgba(0,0,0,0)";
  cx.lineWidth = 1;
  cx.strokeStyle = "rgba(230,252,255,0.3)";
  cx.strokeText(text, pad, mid);
  const [mask, mx] = mk();
  mx.fillStyle = "#FFFFFF";
  mx.fillText(text, pad, mid);
  return { glow, crisp, mask, x: COPY_X - 4 - pad, y: 296 - mid - lift, w: cw, h: ch, textX: pad, textW: tw, size, lift };
}

function nameSprite(cv, name) {
  if (!name) return null;
  const c = cv.createCanvas(COPY_W + 20, 54);
  const x = c.getContext("2d");
  const nm = fitText(x, String(name), COPY_W, { weight: 500, size: 34, min: 18, family: F.m });
  x.fillStyle = "#D6DEEA";
  x.textBaseline = "middle";
  x.fillText(nm, 4, 27);
  return { canvas: c, x: COPY_X - 4, y: 372 - 27 };
}

/** The stat panel's glass and labels (static) plus where each value goes. */
function statsLayout(cv, coin) {
  const stats = statsOf(coin);
  if (!stats.length) return null;
  const m = cv.createCanvas(10, 10).getContext("2d");
  const padX = 22;
  const gap = 26;
  const vals = stats.map(([, v]) => v);
  // a value can decode wider than it ends (8s are wide): size the column on
  // the widest digit so the panel never clips a scrambled frame
  const widest = (v, sz) => {
    m.font = `700 ${sz}px ${F.d7}`;
    return m.measureText(v.replace(/[0-9]/g, "8")).width;
  };
  let vSize = 23;
  let widths;
  let total;
  const measure = () => {
    widths = stats.map(([k], i) => {
      m.font = `700 10px ${F.m7}`;
      return Math.max(trackedWidth(m, k, 2), widest(vals[i], vSize));
    });
    total = padX * 2 + widths.reduce((a, b) => a + b, 0) + gap * (stats.length - 1);
  };
  measure();
  while (total > 640 && vSize > 15) {
    vSize -= 1;
    measure();
  }
  const ph = 82;
  const c = cv.createCanvas(Math.ceil(total) + 4, ph + 4);
  const x = c.getContext("2d");
  roundRect(x, 2, 2, total, ph, 16);
  const bg = x.createLinearGradient(0, 2, 0, ph);
  bg.addColorStop(0, "rgba(16,22,36,0.82)");
  bg.addColorStop(1, "rgba(6,9,16,0.82)");
  x.fillStyle = bg;
  x.fill();
  x.lineWidth = 1.2;
  x.strokeStyle = hexA(C.mid, 0.32);
  x.stroke();
  // top hairline highlight — the glass edge
  const hl = x.createLinearGradient(2, 0, total, 0);
  hl.addColorStop(0, hexA(C.light, 0));
  hl.addColorStop(0.5, hexA(C.light, 0.4));
  hl.addColorStop(1, hexA(C.light, 0));
  x.fillStyle = hl;
  x.fillRect(18, 3, total - 32, 1);
  const cells = [];
  let cx = 2 + padX;
  for (let i = 0; i < stats.length; i++) {
    const [k, v] = stats[i];
    x.textBaseline = "alphabetic";
    x.font = `700 10px ${F.m7}`;
    x.fillStyle = hexA(C.light, 0.75);
    tracked(x, k, cx, 2 + 30, 2);
    cells.push({ x: COPY_X - 2 + cx, value: v });
    cx += widths[i];
    if (i < stats.length - 1) {
      x.fillStyle = hexA(C.mid, 0.24);
      x.fillRect(cx + gap / 2, 2 + 18, 1, ph - 36);
    }
    cx += gap;
  }
  return { canvas: c, x: COPY_X - 2, y: 436, w: total, h: ph, cells, font: `700 ${vSize}px ${F.d7}`, valueY: 436 + 2 + 62 };
}

// ── the coin ─────────────────────────────────────────────────────────────────

function coinInitials(symbol) {
  const s = String(symbol || "").replace(/^\$+/, "").toUpperCase();
  return [...s].slice(0, 2).join("") || "?";
}

function bezelRing(x, c, r) {
  const g = x.createLinearGradient(c - r, c - r, c + r, c + r);
  g.addColorStop(0, "#E9FFF6");
  g.addColorStop(0.22, C.mint);
  g.addColorStop(0.55, C.mid);
  g.addColorStop(0.82, "#1E8FD8");
  g.addColorStop(1, "#BFF6FF");
  x.beginPath();
  x.arc(c, c, r + BEZEL / 2, 0, TAU);
  x.lineWidth = BEZEL;
  x.strokeStyle = g;
  x.stroke();
  x.beginPath();
  x.arc(c, c, r + BEZEL - 0.5, 0, TAU);
  x.lineWidth = 1;
  x.strokeStyle = "rgba(0,0,0,0.55)";
  x.stroke();
  x.beginPath();
  x.arc(c, c, r + 0.5, 0, TAU);
  x.lineWidth = 1.2;
  x.strokeStyle = "rgba(220,250,255,0.5)";
  x.stroke();
}

function edgeShade(x, c, r) {
  const edge = x.createRadialGradient(c, c, r * 0.7, c, c, r);
  edge.addColorStop(0, "rgba(0,0,0,0)");
  edge.addColorStop(1, "rgba(0,0,0,0.42)");
  x.fillStyle = edge;
  x.fillRect(0, 0, c * 2, c * 2);
  const gloss = x.createLinearGradient(0, c - r, 0, c);
  gloss.addColorStop(0, "rgba(255,255,255,0.17)");
  gloss.addColorStop(1, "rgba(255,255,255,0)");
  x.fillStyle = gloss;
  x.beginPath();
  x.ellipse(c, c - r * 0.42, r * 0.82, r * 0.5, 0, 0, TAU);
  x.fill();
}

/** The front face: the token's own logo, or a struck metal face when it has
 *  none — a real logo is never covered. */
function faceTexture(cv, img, symbol) {
  const r = COIN.r;
  const c = r + BEZEL + 2;
  const can = cv.createCanvas(c * 2, c * 2);
  const x = can.getContext("2d");
  x.save();
  x.beginPath();
  x.arc(c, c, r, 0, TAU);
  x.clip();
  if (img) {
    const scale = Math.max((r * 2) / img.width, (r * 2) / img.height);
    const w = img.width * scale;
    const h = img.height * scale;
    x.fillStyle = "#0B0F17";
    x.fillRect(0, 0, c * 2, c * 2);
    x.drawImage(img, c - w / 2, c - h / 2, w, h);
  } else {
    const g = x.createRadialGradient(c - r * 0.3, c - r * 0.35, r * 0.1, c, c, r);
    g.addColorStop(0, "#2A3142");
    g.addColorStop(1, "#0B0E15");
    x.fillStyle = g;
    x.fillRect(0, 0, c * 2, c * 2);
    x.beginPath();
    x.arc(c, c, r * 0.8, 0, TAU);
    x.lineWidth = 2;
    x.strokeStyle = hexA(C.mid, 0.35);
    x.stroke();
    const ini = coinInitials(symbol);
    x.font = `800 ${ini.length > 1 ? 100 : 124}px ${F.x}`;
    x.textAlign = "center";
    x.textBaseline = "middle";
    x.fillStyle = foil(x, c - 58, c + 58);
    x.fillText(ini, c, c + 6);
    x.textAlign = "left";
  }
  edgeShade(x, c, r);
  x.restore();
  bezelRing(x, c, r);
  return can;
}

/** The reverse: struck gold carrying the Dexvra mark — what a spin reveals. */
function backTexture(cv) {
  const r = COIN.r;
  const c = r + BEZEL + 2;
  const can = cv.createCanvas(c * 2, c * 2);
  const x = can.getContext("2d");
  x.save();
  x.beginPath();
  x.arc(c, c, r, 0, TAU);
  x.clip();
  const g = x.createRadialGradient(c - r * 0.35, c - r * 0.4, r * 0.05, c, c, r * 1.05);
  g.addColorStop(0, "#1C5578");
  g.addColorStop(0.5, "#0A2539");
  g.addColorStop(1, "#030D16");
  x.fillStyle = g;
  x.fillRect(0, 0, c * 2, c * 2);
  for (const k of [0.92, 0.84]) {
    x.beginPath();
    x.arc(c, c, r * k, 0, TAU);
    x.lineWidth = 1.5;
    x.strokeStyle = hexA(C.mid, 0.35);
    x.stroke();
  }
  drawBrandMark(x, c - 62, c - 78, 124);
  x.font = `800 22px ${F.x}`;
  x.textAlign = "center";
  x.textBaseline = "middle";
  x.fillStyle = hexA(C.light, 0.85);
  x.fillText("DEXVRA", c, c + 76);
  x.textAlign = "left";
  edgeShade(x, c, r);
  x.restore();
  bezelRing(x, c, r);
  return can;
}

function drawCoinGlow(ctx, st, t, p) {
  const { cx, cy, r } = COIN;
  const y = cy + st.bob;
  const k = st.alpha * Math.min(1, st.s);
  const boost = impactBoost(t, 2.5);
  softGlow(ctx, cx, y, r * 2.4, C.glow, (0.15 + 0.05 * Math.sin(TAU * p * 2)) * k + 0.25 * boost);
  softGlow(ctx, cx, y, r * 1.7, C.blue, 0.1 * k);
}

function drawPedestal(ctx, st, t, p) {
  const { cx, cy, rx, ry } = PEDESTAL;
  const boost = impactBoost(t, 2.2);
  const k = 0.6 + 0.4 * Math.min(1, st.s) * st.alpha;
  ctx.save();
  // the pool of light under the coin
  ctx.translate(cx, cy);
  ctx.scale(1, 0.22);
  softGlow(ctx, 0, 0, rx * 1.55, C.glow, 0.32 * k + 0.4 * boost);
  softGlow(ctx, 0, 0, rx * 0.9, "#FFFFFF", 0.1 * k + 0.25 * boost);
  ctx.restore();
  ctx.save();
  // two rings — the stage
  ctx.beginPath();
  ctx.ellipse(cx, cy, rx, ry, 0, 0, TAU);
  ctx.lineWidth = 2;
  ctx.strokeStyle = hexA(C.mid, 0.5 * k);
  ctx.stroke();
  ctx.beginPath();
  ctx.ellipse(cx, cy, rx * 0.7, ry * 0.7, 0, 0, TAU);
  ctx.lineWidth = 1.2;
  ctx.strokeStyle = hexA(C.light, 0.28 * k);
  ctx.stroke();
  // a light running round the outer ring, twice per loop
  const per = TAU * Math.sqrt((rx * rx + ry * ry) / 2);
  ctx.setLineDash([per * 0.18, per * 0.32]);
  ctx.lineDashOffset = -p * per * 2;
  ctx.beginPath();
  ctx.ellipse(cx, cy, rx, ry, 0, 0, TAU);
  ctx.lineWidth = 2.4;
  ctx.strokeStyle = hexA(C.light, 0.85 * k);
  ctx.shadowColor = C.glow;
  ctx.shadowBlur = 12;
  ctx.stroke();
  ctx.restore();
}

function drawMotes(ctx, st, p, sprite) {
  const { cx, cy, rx } = PEDESTAL;
  const k = 0.5 + 0.5 * st.alpha;
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  for (const m of FIELD.motes) {
    const f = (p * m.cycles + m.phase) % 1;
    const x = cx + m.ox * rx * 0.8 + Math.sin(TAU * (f + m.phase)) * m.sway;
    const y = cy - f * m.rise;
    const a = Math.sin(f * Math.PI) ** 1.5 * 0.85 * k;
    blit(ctx, sprite, x, y, m.size * 7, a);
  }
  ctx.restore();
}

function orbitPoint(o, a, s) {
  const x = o.rx * s * Math.cos(a);
  const y = o.ry * s * Math.sin(a);
  return [x * Math.cos(o.tilt) - y * Math.sin(o.tilt), x * Math.sin(o.tilt) + y * Math.cos(o.tilt)];
}

/** Two tilted orbits with comet trails; `half` is "back" (behind the coin) or
 *  "front" — drawn on either side of the coin so it sits INSIDE them. */
function drawOrbits(ctx, st, p, half, sprites) {
  const { cx, cy } = COIN;
  const y0 = cy + st.bob;
  const s = Math.max(0.0001, st.s);
  const k = st.alpha * Math.min(1, st.s);
  if (k <= 0.01) return;
  ctx.save();
  for (const o of ORBITS) {
    const col = o.color === "gold" ? C.mint : C.mid;
    ctx.beginPath();
    if (half === "back") ctx.ellipse(cx, y0, o.rx * s, o.ry * s, o.tilt, Math.PI, TAU);
    else ctx.ellipse(cx, y0, o.rx * s, o.ry * s, o.tilt, 0, Math.PI);
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = hexA(col, (half === "back" ? 0.16 : 0.3) * k);
    ctx.stroke();
  }
  ctx.globalCompositeOperation = "lighter";
  for (const o of ORBITS) {
    const sprite = o.color === "gold" ? sprites.gold : sprites.cyan;
    for (let d = 0; d < o.dots; d++) {
      const a0 = TAU * (p * o.speed + d / o.dots);
      for (let j = 14; j >= 0; j--) {
        const a = a0 - Math.sign(o.speed) * j * 0.045;
        // "behind" is decided on the angle WRAPPED to [0, TAU): a head sitting
        // ON the crossing has sin(a) = +1e-16 at t = 0 and -1e-16 one loop
        // later, so it flipped depth (0.45 ↔ 1) and side of the front-half
        // stroke — a visible blink at the seam every 6s
        const an = ((a % TAU) + TAU) % TAU;
        const behind = an > Math.PI;
        if ((half === "back") !== behind) continue;
        const [dx, dy] = orbitPoint(o, a, s);
        const fade = (1 - j / 15) ** 1.6;
        const depth = behind ? 0.45 : 1;
        blit(ctx, sprite, cx + dx, y0 + dy, (j === 0 ? 30 : 16 * (1 - j / 18)) * s, fade * depth * k);
      }
    }
  }
  ctx.restore();
}

/** The brand gem, alone (drawBrandMark carries its badge too). (x, y) is the
 *  centre; `size` its width. */
function gem(ctx, x, y, size, alpha = 1) {
  const u = size / 30;
  const P = (px, py) => [x + (px - 15) * u, y + (py - 13) * u];
  const g = ctx.createLinearGradient(...P(0, 0), ...P(30, 26));
  g.addColorStop(0, "#4BFCA6");
  g.addColorStop(0.55, "#22D3EE");
  g.addColorStop(1, "#12B9E0");
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.beginPath();
  ctx.moveTo(...P(6, 0));
  ctx.lineTo(...P(24, 0));
  ctx.lineTo(...P(30, 8));
  ctx.lineTo(...P(15, 26));
  ctx.lineTo(...P(0, 8));
  ctx.closePath();
  ctx.fillStyle = g;
  ctx.fill();
  ctx.strokeStyle = "rgba(8,40,52,0.55)";
  ctx.lineWidth = Math.max(0.8, 0.9 * u);
  ctx.beginPath();
  ctx.moveTo(...P(0, 8));
  ctx.lineTo(...P(30, 8));
  ctx.moveTo(...P(10, 8));
  ctx.lineTo(...P(15, 26));
  ctx.lineTo(...P(20, 8));
  ctx.moveTo(...P(10, 8));
  ctx.lineTo(...P(15, 0));
  ctx.lineTo(...P(20, 8));
  ctx.stroke();
  ctx.fillStyle = "rgba(255,255,255,0.55)";
  ctx.beginPath();
  ctx.moveTo(...P(6, 0));
  ctx.lineTo(...P(15, 0));
  ctx.lineTo(...P(10, 8));
  ctx.lineTo(...P(0, 8));
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

// four gem bubbles around the coin, as on the bundled listing artwork
const BUBBLES = [
  { x: 712, y: 182, r: 34, phase: 0.0 },
  { x: 700, y: 418, r: 30, phase: 0.35 },
  { x: 1212, y: 168, r: 30, phase: 0.6 },
  { x: 1218, y: 408, r: 26, phase: 0.85 },
];

/** Floating gem bubbles. Present the whole loop except the outro/intro, when
 *  they leave with the coin and pop back in after it lands. */
function drawBubbles(ctx, t, p) {
  const k = easeOut(reveal(t, "bubbles"));
  if (k <= 0) return;
  for (const b of BUBBLES) {
    const y = b.y + 7 * Math.sin(TAU * (p + b.phase));
    const r = b.r * (0.4 + 0.6 * easeOutBack(Math.min(1, k)));
    ctx.save();
    ctx.globalAlpha = k;
    softGlow(ctx, b.x, y, r * 2.2, C.mid, 0.12);
    ctx.beginPath();
    ctx.arc(b.x, y, r, 0, TAU);
    const fill = ctx.createRadialGradient(b.x - r * 0.3, y - r * 0.4, 1, b.x, y, r);
    fill.addColorStop(0, "#0E3A50");
    fill.addColorStop(1, "#04121C");
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.lineWidth = 1.4;
    ctx.strokeStyle = hexA(C.mint, 0.45);
    ctx.stroke();
    ctx.restore();
    gem(ctx, b.x, y + 1, r * 0.95, k);
  }
}

/** The artwork's dashed ring round the coin, turning, with two lights riding it. */
function drawDashRing(ctx, st, p, sprite) {
  const { cx, cy, r } = COIN;
  const k = st.alpha * Math.min(1, st.s);
  if (k <= 0.01) return;
  const y = cy + st.bob;
  const R = (r + 44) * st.s;
  ctx.save();
  ctx.translate(cx, y);
  // the dashes SLIDE a whole number of dash periods per loop (18 × 16px), never
  // a fraction of a turn: a quarter turn is 17.87 periods on this radius, and
  // that 0.13 of a dash was a visible jump at the seam every 6s
  ctx.setLineDash([7, 9]);
  ctx.lineDashOffset = -p * 16 * 18;
  ctx.beginPath();
  ctx.arc(0, 0, R, 0, TAU);
  ctx.lineWidth = 1.4;
  ctx.strokeStyle = hexA(C.mint, 0.42 * k);
  ctx.stroke();
  ctx.restore();
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  for (const off of [0.15, 0.62]) {
    const a = TAU * (off - p);
    blit(ctx, sprite, cx + Math.cos(a) * R, y + Math.sin(a) * R, 26 * st.s, 0.95 * k);
  }
  ctx.restore();
}

function drawRipples(ctx, st, p) {
  const { cx, cy, r } = COIN;
  const k = st.alpha * Math.min(1, st.s);
  if (k <= 0.01) return;
  for (let i = 0; i < 3; i++) {
    const f = (p * 2 + i / 3) % 1;
    ctx.beginPath();
    ctx.arc(cx, cy + st.bob, r + 26 + f * 190, 0, TAU);
    ctx.lineWidth = 1.4;
    ctx.strokeStyle = hexA(C.light, (1 - f) ** 2 * 0.26 * k);
    ctx.stroke();
  }
}

/** The coin in 3D: turned `theta` about its vertical axis — the face narrows,
 *  the rim shows on the trailing side, and past 90° the reverse comes round. */
function drawCoin3D(ctx, st, front, back) {
  const { cx, cy, r } = COIN;
  if (st.s <= 0.01 || st.alpha <= 0.01) return;
  const y = cy + st.bob;
  const c = Math.cos(st.theta);
  const sn = Math.sin(st.theta);
  const sx = Math.max(0.035, Math.abs(c));
  const R = (r + BEZEL) * st.s;
  const thick = 18 * st.s;
  const dx = sn * thick;
  ctx.save();
  ctx.globalAlpha = st.alpha;
  // the rim — the coin's edge, stacked from the far face to the near one
  const steps = Math.max(1, Math.ceil(Math.abs(dx)));
  const rim = ctx.createLinearGradient(0, y - R, 0, y + R);
  rim.addColorStop(0, "#A8F3FF");
  rim.addColorStop(0.35, C.mid);
  rim.addColorStop(0.7, "#0A5F86");
  rim.addColorStop(1, "#04263A");
  for (let i = 0; i <= steps; i++) {
    const k = i / steps;
    ctx.beginPath();
    ctx.ellipse(cx - dx / 2 + dx * k, y, R * sx, R, 0, 0, TAU);
    ctx.fillStyle = rim;
    ctx.fill();
  }
  // reeding on the rim: fine darker lines across the visible band
  if (Math.abs(dx) > 2) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(Math.min(cx - dx / 2, cx + dx / 2) - R * sx, y - R, Math.abs(dx) + R * sx * 2, R * 2);
    ctx.clip();
    ctx.strokeStyle = "rgba(2,22,36,0.4)";
    ctx.lineWidth = 1;
    for (let a = -Math.PI / 2; a <= Math.PI / 2; a += Math.PI / 40) {
      const yy = y + Math.sin(a) * R;
      const half = Math.cos(a) * R * sx;
      const side = dx > 0 ? -1 : 1;
      ctx.beginPath();
      ctx.moveTo(cx + dx / 2 + side * half, yy);
      ctx.lineTo(cx - dx / 2 + side * half, yy);
      ctx.stroke();
    }
    ctx.restore();
  }
  // the near face
  const tex = c >= 0 ? front : back;
  const fx = cx + dx / 2;
  ctx.save();
  ctx.translate(fx, y);
  ctx.scale(sx * st.s, st.s);
  ctx.drawImage(tex, -tex.width / 2, -tex.height / 2);
  ctx.restore();
  // specular sheen: a band that crosses the face as it turns
  const sheen = 0.1 + 0.42 * Math.abs(sn);
  ctx.save();
  ctx.beginPath();
  ctx.ellipse(fx, y, R * sx, R, 0, 0, TAU);
  ctx.clip();
  const bx = fx - sn * R * sx * 1.3;
  const lg = ctx.createLinearGradient(bx - R * 0.5, y - R, bx + R * 0.5, y + R);
  lg.addColorStop(0, "rgba(255,255,255,0)");
  lg.addColorStop(0.5, `rgba(235,252,255,${sheen})`);
  lg.addColorStop(1, "rgba(255,255,255,0)");
  ctx.globalCompositeOperation = "lighter";
  ctx.fillStyle = lg;
  ctx.fillRect(fx - R, y - R, R * 2, R * 2);
  ctx.restore();
  ctx.restore();
}

/** The landing: a flash, two shockwaves and a burst of sparks. */
function drawImpact(ctx, t) {
  const v = t - IMPACT;
  if (v < 0 || v > 1.3) return;
  const { cx, cy, r } = COIN;
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  softGlow(ctx, cx, cy, 460, C.glow, 0.7 * Math.exp(-v * 6));
  softGlow(ctx, cx, cy, r * 1.25, "#FFFFFF", 0.55 * Math.exp(-v * 9));
  for (const [delay, w, a] of [[0, 7, 0.8], [0.12, 3, 0.55]]) {
    const u = (v - delay) / 0.85;
    if (u <= 0 || u >= 1) continue;
    ctx.beginPath();
    ctx.arc(cx, cy, r + 24 + 560 * easeOut(u), 0, TAU);
    ctx.lineWidth = w * (1 - u) + 0.8;
    ctx.strokeStyle = hexA(C.light, (1 - u) ** 2 * a);
    ctx.shadowColor = C.glow;
    ctx.shadowBlur = 18;
    ctx.stroke();
  }
  ctx.shadowBlur = 0;
  ctx.lineCap = "round";
  for (const s of FIELD.sparks) {
    if (v > s.life) continue;
    const u = v / s.life;
    const dist = r + BEZEL + 6 + (s.speed * (1 - Math.exp(-v * 3.4))) / 3.4; // born at the rim, never over the face
    const x = cx + Math.cos(s.a) * dist;
    const y = cy + Math.sin(s.a) * dist + 90 * v * v;
    const len = 6 + s.speed * 0.028 * Math.exp(-v * 3);
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x - Math.cos(s.a) * len, y - Math.sin(s.a) * len);
    ctx.lineWidth = s.w;
    ctx.strokeStyle = s.white ? `rgba(255,255,255,${(1 - u) ** 1.4})` : hexA(C.light, (1 - u) ** 1.4);
    ctx.stroke();
  }
  ctx.restore();
}

// ── ambient ──────────────────────────────────────────────────────────────────

function ribbonY(rb, i, x, p) {
  return (
    rb.y +
    rb.amp * Math.sin(x * rb.f1 + TAU * rb.k1 * p + i * 1.7) +
    rb.amp * 0.45 * Math.sin(x * rb.f2 + TAU * rb.k2 * p + i * 2.9)
  );
}

/** Flowing aurora ribbons: each a bright core with layered glow, fading out at
 *  both ends; their phases advance a whole period per loop. */
function drawRibbons(ctx, p) {
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  RIBBONS.forEach((rb, i) => {
    for (const [w, a] of [[78, 0.03], [34, 0.05], [12, 0.1], [2.4, 0.55]]) {
      const g = ctx.createLinearGradient(0, 0, W, 0);
      g.addColorStop(0, hexA(rb.color, 0));
      g.addColorStop(0.28, hexA(rb.color, a * rb.a));
      g.addColorStop(0.72, hexA(rb.color, a * rb.a));
      g.addColorStop(1, hexA(rb.color, 0));
      ctx.beginPath();
      for (let x = -20; x <= W + 20; x += 20) {
        const y = ribbonY(rb, i, x, p);
        if (x === -20) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.lineWidth = w;
      ctx.strokeStyle = g;
      ctx.stroke();
    }
  });
  ctx.restore();
}

/** Light beams fanning from behind the coin. ⚠️ They alternate wide/narrow, so
 *  the pattern repeats every TWO beams — turning one beam-step per loop put a
 *  wide beam where a narrow one was at the seam, a visible jump every 6s. */
function drawRays(ctx, t, p) {
  const { cx, cy } = COIN;
  const n = 12;
  const step = TAU / n;
  const boost = impactBoost(t, 2.6);
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  const g = ctx.createRadialGradient(cx, cy, 120, cx, cy, 760);
  const a = 0.05 + 0.18 * boost;
  g.addColorStop(0, hexA(C.glow, a));
  g.addColorStop(0.45, hexA(C.glow, a * 0.35));
  g.addColorStop(1, hexA(C.glow, 0));
  ctx.fillStyle = g;
  for (let i = 0; i < n; i++) {
    const s = step * i + 2 * step * p;
    const width = i % 2 ? step * 0.16 : step * 0.34;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, 760, s, s + width);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

function drawBokeh(ctx, p, sprites) {
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  for (const b of FIELD.bokeh) {
    const ph = TAU * (p + b.phase);
    blit(ctx, b.cyan ? sprites.cyanSoft : sprites.goldSoft, b.x + Math.sin(ph) * b.drift, b.y + Math.cos(ph) * b.drift * 0.6, b.size, b.a * (0.7 + 0.3 * Math.sin(ph * 2)));
  }
  ctx.restore();
}

/** Four-point star glints that flare and vanish. */
function drawSparkles(ctx, p) {
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  for (const s of FIELD.sparkles) {
    const tw = Math.max(0, Math.sin(TAU * (p * s.cycles + s.phase)));
    const a = tw ** 6;
    if (a < 0.02) continue;
    const col = s.gold ? C.light : "#DDF6FF";
    const L = s.size * (0.6 + 0.8 * a);
    for (const [dx, dy] of [[1, 0], [0, 1]]) {
      const g = ctx.createLinearGradient(s.x - dx * L, s.y - dy * L, s.x + dx * L, s.y + dy * L);
      g.addColorStop(0, hexA(col, 0));
      g.addColorStop(0.5, hexA(col, a));
      g.addColorStop(1, hexA(col, 0));
      ctx.strokeStyle = g;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(s.x - dx * L, s.y - dy * L);
      ctx.lineTo(s.x + dx * L, s.y + dy * L);
      ctx.stroke();
    }
    ctx.fillStyle = `rgba(255,255,255,${a})`;
    ctx.beginPath();
    ctx.arc(s.x, s.y, 1.4, 0, TAU);
    ctx.fill();
  }
  ctx.restore();
}

/** Two lights running round the gold frame, once per loop. */
function drawBorderRun(ctx, p) {
  const w = W - FRAME_INSET * 2;
  const h = H - FRAME_INSET * 2;
  const per = 2 * (w + h) - (8 - TAU) * FRAME_RADIUS;
  const seg = 190;
  ctx.save();
  roundRect(ctx, FRAME_INSET, FRAME_INSET, w, h, FRAME_RADIUS);
  ctx.setLineDash([seg, per / 2 - seg]);
  ctx.lineDashOffset = -p * per;
  ctx.lineWidth = 2.2;
  ctx.strokeStyle = hexA(C.light, 0.9);
  ctx.shadowColor = C.glow;
  ctx.shadowBlur = 14;
  ctx.stroke();
  ctx.restore();
}

/** A light band across a box, clipped to it. */
function shine(ctx, box, u, alpha, radius) {
  if (!box || u <= 0 || u >= 1) return;
  ctx.save();
  roundRect(ctx, box.x, box.y, box.w, box.h, radius);
  ctx.clip();
  const x = box.x - 80 + u * (box.w + 160);
  const g = ctx.createLinearGradient(x - 50, 0, x + 50, 0);
  g.addColorStop(0, "rgba(255,255,255,0)");
  g.addColorStop(0.5, `rgba(225,250,255,${alpha})`);
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.globalCompositeOperation = "lighter";
  ctx.fillStyle = g;
  ctx.fillRect(box.x, box.y, box.w, box.h);
  ctx.restore();
}

// ── the copy, per frame ──────────────────────────────────────────────────────

function drawPill(ctx, t, p, pill) {
  const k = reveal(t, "pill");
  if (k <= 0) return;
  const e = easeOutBack(k);
  const { canvas, x, y, dot } = pill;
  ctx.save();
  ctx.globalAlpha = clamp01(k * 1.6);
  ctx.translate(x, y + canvas.height / 2);
  ctx.scale(0.6 + 0.4 * e, 0.6 + 0.4 * e);
  ctx.drawImage(canvas, 0, -canvas.height / 2);
  ctx.restore();
  if (k < 1) return;
  const f = (p * 3) % 1;
  ctx.beginPath();
  ctx.arc(dot.x, dot.y, 5 + f * 12, 0, TAU);
  ctx.fillStyle = `rgba(61,245,159,${(1 - f) * 0.4})`;
  ctx.fill();
  ctx.beginPath();
  ctx.arc(dot.x, dot.y, 5, 0, TAU);
  ctx.fillStyle = SITE.mint;
  ctx.fill();
}

/** The ticker: wiped in left→right behind a bright leading edge, and
 *  shimmered twice through the hold. */
function drawTicker(ctx, t, tk, scratch) {
  const k = reveal(t, "ticker");
  if (k <= 0) return;
  const e = easeOut(k);
  if (t >= HOLD_END && t < OUT_END) {
    // the exit is a fade, not the wipe run backwards
    ctx.save();
    ctx.globalAlpha = e;
    ctx.drawImage(tk.glow, tk.x - (1 - e) * 24, tk.y);
    ctx.drawImage(tk.crisp, tk.x - (1 - e) * 24, tk.y);
    ctx.restore();
    return;
  }
  const dy = (1 - e) * 14;
  const x0 = tk.x + tk.textX - 20;
  const span = tk.textW + 70;
  const edge = x0 + span * e;
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, edge, H);
  ctx.clip();
  ctx.globalAlpha = clamp01(k * 2);
  ctx.drawImage(tk.glow, tk.x, tk.y + dy);
  ctx.drawImage(tk.crisp, tk.x, tk.y + dy);
  ctx.restore();
  if (k > 0 && k < 1) {
    const cy = tk.y + tk.h / 2 + dy;
    // a soft light riding the wipe — masked to the glyphs, so it reads as the
    // letters catching it rather than a cursor block
    const sx = scratch.getContext("2d");
    sx.globalCompositeOperation = "source-over";
    sx.clearRect(0, 0, scratch.width, scratch.height);
    sx.drawImage(tk.mask, 0, 0);
    sx.globalCompositeOperation = "source-in";
    const ex = edge - tk.x;
    const g = sx.createLinearGradient(ex - 70, 0, ex + 4, 0);
    g.addColorStop(0, "rgba(150,235,255,0)");
    g.addColorStop(0.85, `rgba(235,252,255,${0.95 * Math.sin(k * Math.PI)})`);
    g.addColorStop(1, "rgba(235,252,255,0)");
    sx.fillStyle = g;
    sx.fillRect(0, 0, tk.w, tk.h);
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.drawImage(scratch, 0, 0, tk.w, tk.h, tk.x, tk.y + dy, tk.w, tk.h);
    softGlow(ctx, edge, cy, tk.size * 0.55, C.glow, 0.35 * Math.sin(k * Math.PI));
    ctx.restore();
  }
  // the hold shimmer, masked to the glyphs
  let u = -1;
  if (t >= 0.25 && t <= 0.95) u = (t - 0.25) / 0.7;
  else if (t >= 2.25 && t <= 2.95) u = (t - 2.25) / 0.7;
  if (u < 0 || !scratch) return;
  const sx = scratch.getContext("2d");
  sx.globalCompositeOperation = "source-over";
  sx.clearRect(0, 0, scratch.width, scratch.height);
  sx.drawImage(tk.mask, 0, 0);
  sx.globalCompositeOperation = "source-in";
  const bx = tk.textX - 120 + u * (tk.textW + 240);
  const g = sx.createLinearGradient(bx - 60, 0, bx + 60, tk.h);
  const a = Math.sin(u * Math.PI) * 0.75;
  g.addColorStop(0, "rgba(255,255,255,0)");
  g.addColorStop(0.5, `rgba(235,252,255,${a})`);
  g.addColorStop(1, "rgba(255,255,255,0)");
  sx.fillStyle = g;
  sx.fillRect(0, 0, tk.w, tk.h);
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  ctx.drawImage(scratch, 0, 0, tk.w, tk.h, tk.x, tk.y, tk.w, tk.h);
  ctx.restore();
}

function drawName(ctx, t, nm) {
  if (!nm) return;
  const k = reveal(t, "name");
  if (k <= 0) return;
  const e = easeOut(k);
  ctx.save();
  ctx.globalAlpha = e;
  ctx.drawImage(nm.canvas, nm.x, nm.y + (1 - e) * 16);
  ctx.restore();
}

function drawRule(ctx, t) {
  const k = easeOut(reveal(t, "rule"));
  if (k <= 0) return;
  const w = 180 * k;
  const g = ctx.createLinearGradient(COPY_X, 0, COPY_X + w, 0);
  g.addColorStop(0, hexA(C.mid, 0.95));
  g.addColorStop(1, hexA(C.mid, 0));
  ctx.fillStyle = g;
  ctx.fillRect(COPY_X, 410, w, 1.6);
}

/** The stat panel opens from the left; each value then decodes in turn. */
function drawStats(ctx, t, st) {
  if (!st) return;
  const k0 = reveal(t, "stats");
  if (k0 <= 0) return;
  const open = easeOut(clamp01(k0 * 1.4));
  ctx.save();
  ctx.beginPath();
  ctx.rect(st.x, st.y - 4, (st.w + 8) * open, st.h + 12);
  ctx.clip();
  ctx.globalAlpha = clamp01(k0 * 2);
  ctx.drawImage(st.canvas, st.x, st.y);
  ctx.restore();
  ctx.save();
  ctx.font = st.font;
  ctx.textBaseline = "alphabetic";
  st.cells.forEach((cell, i) => {
    const k = reveal(t, "stats", i);
    if (k <= 0) return;
    ctx.globalAlpha = clamp01(k * 3);
    ctx.fillStyle = i === 0 ? SITE.text : "#F4F7FC";
    ctx.fillText(scramble(cell.value, k, t, 97 + i), cell.x, st.valueY);
  });
  ctx.restore();
}

/** The outro's light sweep — a bright diagonal band crossing the frame. */
function drawSweep(ctx, t) {
  const a = HOLD_END - 0.1;
  const b = OUT_END + 0.05;
  if (t < a || t > b) return;
  const u = (t - a) / (b - a);
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  ctx.translate(-260 + u * (W + 520), H / 2);
  ctx.rotate(0.32);
  const g = ctx.createLinearGradient(-150, 0, 150, 0);
  const al = Math.sin(u * Math.PI) * 0.32;
  g.addColorStop(0, "rgba(120,220,255,0)");
  g.addColorStop(0.5, `rgba(220,248,255,${al})`);
  g.addColorStop(1, "rgba(120,220,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(-150, -H, 300, H * 2);
  ctx.restore();
}

function drawFlash(ctx, t) {
  const v = t - IMPACT;
  if (v < 0 || v > 0.5) return;
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  ctx.fillStyle = `rgba(190,240,255,${0.2 * Math.exp(-v * 10)})`;
  ctx.fillRect(0, 0, W, H);
  ctx.restore();
}

/**
 * Draw the frames in order, handing each one's RGBA to `onFrame` as it is made
 * (awaited, so a slow encoder applies back-pressure). Streaming matters: 150
 * frames at 1280×640 is ~490 MB held at once, on a box running four processes.
 * Returns false when canvas is unavailable.
 */
async function drawFrames(coin, logoBuffer, { count = FRAMES, times = null, badge = null, onFrame, cancel = null }) {
  const cv = kit.canvasLib();
  if (!cv) return false;
  warnBoxes("listing-motion", { symbol: coin.symbol, name: coin.name });

  let img = null;
  if (logoBuffer) {
    try {
      img = await cv.loadImage(logoBuffer);
    } catch {
      img = null; // an unreadable logo draws the struck face, never fails the clip
    }
  }

  const base = cv.createCanvas(W, H);
  drawBase(base.getContext("2d"));
  const vignette = cv.createCanvas(W, H);
  drawVignette(vignette.getContext("2d"));
  const chrome = cv.createCanvas(W, H);
  const cctx = chrome.getContext("2d");
  drawFrameLines(cctx);
  const badgeBox = drawBrand(cctx, badge);
  drawFooter(cctx);

  const front = faceTexture(cv, img, coin.symbol);
  const back = backTexture(cv);
  const sprites = {
    gold: glowSprite(cv, C.mint, 0.18), // the mint orbit + the motes
    cyan: glowSprite(cv, C.mid, 0.18),
    goldSoft: glowSprite(cv, C.mid, 0.02),
    cyanSoft: glowSprite(cv, C.blue, 0.02),
  };
  const pill = pillSprite(cv);
  const tk = tickerSprites(cv, coin.symbol);
  const scratch = cv.createCanvas(tk.w, tk.h);
  const nm = nameSprite(cv, coin.name);
  const st = statsLayout(cv, coin);

  const out = cv.createCanvas(W, H);
  const ctx = out.getContext("2d");
  // `times` (seconds, UNWRAPPED) is the seam test's way in: t = SECONDS must
  // draw what t = 0 draws, which a wrapped frame index can never ask
  const n = times ? times.length : count;
  for (let f = 0; f < n; f++) {
    // a caller that stopped waiting (postMedia's budget) stops the work too —
    // otherwise an abandoned render goes on burning CPU for nobody
    if (cancel && cancel.cancelled) throw new Error("cancelled — the caller stopped waiting");
    const t = times ? times[f] : (f % FRAMES) / FPS;
    const p = t / SECONDS;
    const cs = coinState(t);
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
    ctx.drawImage(base, 0, 0);
    drawRibbons(ctx, p);
    drawRays(ctx, t, p);
    drawBokeh(ctx, p, sprites);
    drawSparkles(ctx, p);
    drawCoinGlow(ctx, cs, t, p);
    drawPedestal(ctx, cs, t, p);
    drawMotes(ctx, cs, p, sprites.gold);
    drawBubbles(ctx, t, p);
    drawOrbits(ctx, cs, p, "back", sprites);
    drawDashRing(ctx, cs, p, sprites.gold);
    // both halves BEHIND the coin: a light crossing in front of the face
    // reads as a scratch over the token's own logo, the one thing that post
    // exists to show
    drawOrbits(ctx, cs, p, "front", sprites);
    drawCoin3D(ctx, cs, front, back);
    drawImpact(ctx, t);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    ctx.drawImage(vignette, 0, 0);
    ctx.drawImage(chrome, 0, 0);
    drawBorderRun(ctx, p);
    if (t >= 1.5 && t <= 2.1) shine(ctx, badgeBox, (t - 1.5) / 0.6, 0.6, badgeBox ? badgeBox.h / 2 : 0);
    drawPill(ctx, t, p, pill);
    drawTicker(ctx, t, tk, scratch);
    drawName(ctx, t, nm);
    drawRule(ctx, t);
    drawStats(ctx, t, st);
    drawSweep(ctx, t);
    drawFlash(ctx, t);
    // ⚠️ canvas.data() is a LIVE VIEW of the canvas's pixels, not a copy
    // (measured: a view taken before a fill reads the fill's colour after it).
    // So the consumer must be DONE with it before the next frame is drawn —
    // the encoder awaits the pipe's write callback, frames() copies.
    // getImageData would copy, and peaked at 1.1 GB over one clip.
    await onFrame(out.data(), f);
  }
  return true;
}

/** The first `count` frames as RGBA buffers — for tests and the preview script. */
async function frames(coin, logoBuffer, { count = FRAMES, badge = null } = {}) {
  const list = [];
  const ok = await drawFrames(coin, logoBuffer, { count, badge, onFrame: (b) => list.push(Buffer.from(b)) });
  return ok ? list : null;
}

function ffmpegPath() {
  try {
    return require("@ffmpeg-installer/ffmpeg").path;
  } catch {
    return null;
  }
}

/** Start an ffmpeg that turns piped RGBA frames into a silent MP4 at `outPath`.
 *  Returns { write(frame), end() → Promise<outPath>, kill() }. */
function encoder(outPath) {
  const bin = ffmpegPath();
  if (!bin) throw new Error("ffmpeg unavailable");
  const args = [
    "-y", "-loglevel", "error",
    "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${W}x${H}`, "-r", String(FPS), "-i", "pipe:0",
    // yuv420p + even size is what every Telegram client decodes; no audio so
    // Telegram treats it as an autoplaying animation, never a video.
    "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p",
    "-movflags", "+faststart", "-an",
    outPath,
  ];
  const p = spawn(bin, args, { stdio: ["pipe", "ignore", "pipe"] });
  let err = "";
  let failed = null;
  p.stderr.on("data", (d) => (err += d));
  const done = new Promise((resolve, reject) => {
    p.on("error", (e) => {
      failed = e;
      reject(e);
    });
    p.on("close", (code) => (code === 0 ? resolve(outPath) : reject(new Error(err.trim() || `ffmpeg exited ${code}`))));
  });
  done.catch(() => {}); // surfaced through end(); never an unhandled rejection
  p.stdin.on("error", (e) => (failed = failed || e));
  return {
    // Resolves once the frame has been handed to the pipe — the caller then
    // overwrites the same pixel memory with the next frame, so returning on
    // write()'s boolean alone would let a queued write read the NEXT frame.
    write(frame) {
      if (failed) return Promise.reject(failed);
      return new Promise((resolve, reject) => {
        p.stdin.write(frame, (e) => (e ? reject(failed || e) : resolve()));
      });
    },
    end() {
      p.stdin.end();
      return done;
    },
    kill() {
      try {
        p.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    },
  };
}

/** LISTING_MOTION=0 restores the old ladder exactly (the admin clip with its
 *  overlay, then the still). Blank or unset is ON — sourceFlag's rule. */
const enabled = () => sourceEnabled("LISTING_MOTION");

const TMP_PREFIX = "bt-out-lm-";
const TMP_MAX_AGE_MS = 10 * 60_000;

/** The clip is a FILE (Telegram detects an animation from the .mp4 name), and
 *  bannerTemplate's sweep only runs when an admin clip is composited — which a
 *  listing no longer does. So this module reclaims its own: anything it wrote
 *  more than ten minutes ago has long been uploaded. Best-effort. */
async function sweepTmp(dir = os.tmpdir(), now = Date.now()) {
  try {
    for (const f of await fss.promises.readdir(dir)) {
      if (!f.startsWith(TMP_PREFIX)) continue;
      const fp = path.join(dir, f);
      const st = await fss.promises.stat(fp).catch(() => null);
      if (st && now - st.mtimeMs > TMP_MAX_AGE_MS) await fss.promises.unlink(fp).catch(() => {});
    }
  } catch {
    /* a temp dir we cannot list costs disk, never the post */
  }
}

/**
 * The premium listing clip for one token → { type: "animation", source: <mp4
 * path> }, or null on any failure. `coin` is fulfillment's bannerCoin
 * ({ symbol, name, chain, price, mcap, liq }); `badge` is the package label;
 * `cancel` is a { cancelled } flag the caller sets when it stops waiting.
 */
async function render(coin, logoBuffer, { badge = null, outPath = null, cancel = null } = {}) {
  const t0 = Date.now();
  let file = null;
  try {
    if (!kit.canvasLib()) {
      log.warn("[listingMotion] @napi-rs/canvas unavailable — premium clip skipped");
      return null;
    }
    if (!outPath) sweepTmp().catch(() => {});
    file = outPath || path.join(os.tmpdir(), `${TMP_PREFIX}${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}.mp4`);
    const enc = encoder(file);
    try {
      await drawFrames(coin || {}, logoBuffer, { badge, cancel, onFrame: (fr) => enc.write(fr) });
    } catch (e) {
      enc.kill();
      throw e;
    }
    await enc.end();
    const st = fss.statSync(file);
    log.info(`[listingMotion] ${tickerOf(coin && coin.symbol)} rendered in ${Date.now() - t0}ms (${Math.round(st.size / 1024)} KB)`);
    return { type: "animation", source: file };
  } catch (e) {
    log.warn(`[listingMotion] ${tickerOf(coin && coin.symbol)} render failed after ${Date.now() - t0}ms: ${e.message}`);
    if (file) fss.promises.unlink(file).catch(() => {}); // a half-written clip is never handed on
    return null;
  }
}

module.exports = {
  render,
  enabled,
  frames,
  statsOf,
  W,
  H,
  FPS,
  FRAMES,
  _window01: window01,
  _scramble: scramble,
  _reveal: reveal,
  _coinState: coinState,
  _timeline: { HOLD_END, OUT_END, IMPACT, SECONDS },
  _impactBoost: impactBoost,
  _sweepTmp: sweepTmp,
  _drawFrames: drawFrames,
  _keys: Object.keys(SCHED),
  _tickerSprites: tickerSprites,
};
