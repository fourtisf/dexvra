"use strict";
// The PREMIUM animated listing banner — a looping MP4 drawn frame by frame.
//
// How it got here, because each step was a "no" worth remembering:
//   1. "bisakah anda buatkan gif premium gif listing lebih bagus premium dari
//      gif sebelumnya" — a still card with a little drift. Too static.
//   2. "gif video looks bad buat lebih premium ada animasi visualnya" — a gold
//      motion piece. Real motion, wrong colours.
//   3. "ini jelek banget, saya ingin sesuai brand kita biru" — the same piece
//      in the brand blue. Right colours, same layout.
//   4. "bisakah anda rubah tampilannya?? berbeda lebih bagus dan premium" —
//      THIS: a different composition. A centred, cinematic poster: an animated
//      mesh-gradient field under a stage spotlight and a perspective floor, the
//      token's logo at centre stage inside rotating rings of light, a big
//      centred ticker that rises in letter by letter, and frosted-glass stat
//      chips. Brand palette throughout (the gem's mint → cyan, royal blue,
//      indigo); restraint over ornament — white type, no foil.
//
// Each loop:
//   0.0–3.2s  HOLD    the full poster, alive: drifting colour field, swaying
//                     light shafts, a floor rolling toward the viewer, rings of
//                     light turning, one full 3D spin of the coin (its reverse
//                     carries the Dexvra mark), a shine across the ticker/chips
//   3.2–3.8s  OUTRO   the coin spins away, the type fades, a light sweep crosses
//   3.8–6.0s  INTRO   the coin flies in spinning and LANDS — flash, shockwaves,
//                     sparks — the rings open, the ticker rises letter by
//                     letter, the chips rise and their numbers decode
//
// FRAME 0 IS THE FULL POSTER, deliberately: Telegram makes the thumbnail and
// the notification preview from the first frame, and a loop that opened on an
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

// THE DEXVRA BRAND: the gem's mint → cyan (canvasKit drawBrandMark, the bundled
// banner artwork), with royal blue and indigo for depth. Every accent reads
// from here.
const C = {
  light: "#D8FAFF", // ice
  mid: "#22D3EE", // the brand cyan
  dark: "#0A6E9C",
  glow: "#22D3EE",
  blue: "#2F86FF",
  royal: "#1A4FD6",
  indigo: "#4A3BFF",
  mint: "#3DF59F",
};

const COIN = { cx: 640, cy: 222, r: 90 };
const BEZEL = 7;
const HORIZON = 318;
const CX = W / 2;

// ── the timeline (seconds) ───────────────────────────────────────────────────
const HOLD_END = 3.2;
const OUT_END = 3.8;
const IN0 = OUT_END;
// [delay, duration] after IN0 — every entry ends by 2.2s, so it is settled
// (and identical to frame 0) when the loop wraps.
const SCHED = {
  coin: [0, 0.9],
  ring: [0.62, 0.55],
  eyebrow: [0.7, 0.5],
  ticker: [0.76, 0.75],
  name: [1.18, 0.45],
  stats: [1.3, 0.45], // + STAT_STAGGER per chip
};
const STAT_STAGGER = 0.1;
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
  const bob = 5 * Math.sin((TAU * t) / SECONDS);
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
 *  the loop wraps, and the light would visibly step at the seam. */
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
  const dust = Array.from({ length: 70 }, () => ({
    x: r() * W,
    y: r() * H,
    size: 0.8 + r() * 2.2,
    phase: r(),
    sway: 6 + r() * 18,
    a: 0.25 + r() * 0.6,
    cyan: r() < 0.6,
  }));
  const sparkles = Array.from({ length: 16 }, () => ({
    x: 60 + r() * (W - 120),
    y: 40 + r() * (H - 120),
    size: 5 + r() * 8,
    phase: r(),
    cycles: 1 + Math.floor(r() * 2),
  }));
  const sparks = Array.from({ length: 64 }, () => ({
    a: r() * TAU,
    speed: 360 + r() * 720,
    life: 0.55 + r() * 0.6,
    w: 1.1 + r() * 1.8,
    white: r() < 0.35,
  }));
  return { dust, sparkles, sparks };
})();

// the colour field: big soft blobs on closed paths, one lap per loop
const BLOBS = [
  { x: 240, y: 520, ax: 90, ay: 50, r: 560, color: "#1A4FD6", a: 0.55, k: 1, ph: 0.0 },
  { x: 1080, y: 110, ax: 80, ay: 60, r: 520, color: "#4A3BFF", a: 0.42, k: 1, ph: 0.3 },
  { x: 1120, y: 560, ax: 70, ay: 40, r: 480, color: "#0A6E9C", a: 0.5, k: -1, ph: 0.55 },
  { x: 150, y: 90, ax: 60, ay: 40, r: 340, color: "#3DF59F", a: 0.14, k: -1, ph: 0.8 },
  { x: 640, y: 230, ax: 30, ay: 18, r: 380, color: "#22D3EE", a: 0.22, k: 1, ph: 0.15 },
];

// ── small drawing helpers ────────────────────────────────────────────────────

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

/** The stat chips the poster carries — a missing figure is LEFT OUT, never
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

/** Ice type: white at the top, the brand cyan at the foot. */
function ice(ctx, y0, y1) {
  const g = ctx.createLinearGradient(0, y0, 0, y1);
  g.addColorStop(0, "#FFFFFF");
  g.addColorStop(0.55, "#E6FBFF");
  g.addColorStop(1, "#7FE7FA");
  return g;
}

// ── the background (per frame: it moves) ────────────────────────────────────

/** Film grain — the difference between a gradient and a photograph. Static, so
 *  it costs the encoder nothing. */
function grainCanvas(cv) {
  const c = cv.createCanvas(W, H);
  const x = c.getContext("2d");
  const id = x.createImageData(W, H);
  const r = rng(77);
  for (let i = 0; i < id.data.length; i += 4) {
    const v = r() < 0.5 ? 0 : 255;
    id.data[i] = v;
    id.data[i + 1] = v;
    id.data[i + 2] = v;
    id.data[i + 3] = Math.floor(r() * 14);
  }
  x.putImageData(id, 0, 0);
  return c;
}

function drawField(ctx, p) {
  ctx.fillStyle = "#020814";
  ctx.fillRect(0, 0, W, H);
  for (const b of BLOBS) {
    const a = TAU * (p * b.k + b.ph);
    softGlow(ctx, b.x + Math.cos(a) * b.ax, b.y + Math.sin(a) * b.ay, b.r, b.color, b.a);
  }
}

/** A perspective floor receding to the horizon behind the coin, rolling toward
 *  the viewer — clear in the centre column, where the type sits. */
function drawFloor(ctx, p) {
  const fade = (a) => {
    const g = ctx.createLinearGradient(0, 0, W, 0);
    g.addColorStop(0, hexA(C.mid, a));
    g.addColorStop(0.3, hexA(C.mid, a * 0.18));
    g.addColorStop(0.5, hexA(C.mid, 0));
    g.addColorStop(0.7, hexA(C.mid, a * 0.18));
    g.addColorStop(1, hexA(C.mid, a));
    return g;
  };
  ctx.save();
  ctx.lineWidth = 1;
  const N = 9;
  for (let j = 0; j < N + 1; j++) {
    const s = (j + ((p * 2) % 1)) / N; // two rows per loop
    if (s > 1) continue;
    const y = HORIZON + (H + 30 - HORIZON) * s * s;
    ctx.strokeStyle = fade(0.32 * s);
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(W, y);
    ctx.stroke();
  }
  for (let i = -10; i <= 10; i++) {
    const xb = CX + i * 150;
    const a = 0.22 * Math.min(1, Math.abs(i) / 3.5);
    if (a <= 0) continue;
    const g = ctx.createLinearGradient(0, HORIZON, 0, H);
    g.addColorStop(0, hexA(C.mid, 0));
    g.addColorStop(1, hexA(C.mid, a));
    ctx.strokeStyle = g;
    ctx.beginPath();
    ctx.moveTo(CX + i * 6, HORIZON);
    ctx.lineTo(xb, H + 30);
    ctx.stroke();
  }
  // the horizon itself: a thin line of light, brightest behind the coin
  const hz = ctx.createLinearGradient(0, 0, W, 0);
  hz.addColorStop(0, hexA(C.mid, 0));
  hz.addColorStop(0.5, hexA(C.light, 0.75));
  hz.addColorStop(1, hexA(C.mid, 0));
  ctx.fillStyle = hz;
  ctx.fillRect(0, HORIZON - 0.75, W, 1.5);
  ctx.restore();
  ctx.save();
  ctx.translate(CX, HORIZON);
  ctx.scale(1, 0.12);
  softGlow(ctx, 0, 0, 520, C.mid, 0.28);
  ctx.restore();
}

/** The stage light: a cone from above onto the coin, with three shafts swaying
 *  inside it. */
function drawSpotlight(ctx, t, p) {
  const boost = impactBoost(t, 2.4);
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  const g = ctx.createLinearGradient(0, 0, 0, HORIZON + 20);
  g.addColorStop(0, hexA(C.light, 0.13 + 0.12 * boost));
  g.addColorStop(1, hexA(C.mid, 0.015));
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.moveTo(CX - 60, -10);
  ctx.lineTo(CX + 60, -10);
  ctx.lineTo(CX + 300, HORIZON + 20);
  ctx.lineTo(CX - 300, HORIZON + 20);
  ctx.closePath();
  ctx.fill();
  for (const [ph, w, a] of [[0, 34, 0.09], [0.33, 20, 0.07], [0.66, 26, 0.08]]) {
    const ang = 0.16 * Math.sin(TAU * (p + ph));
    ctx.save();
    ctx.translate(CX, -10);
    ctx.rotate(ang);
    const s = ctx.createLinearGradient(0, 0, 0, HORIZON);
    s.addColorStop(0, hexA("#FFFFFF", a * (1 + boost)));
    s.addColorStop(1, hexA(C.mid, 0));
    ctx.fillStyle = s;
    ctx.beginPath();
    ctx.moveTo(-w * 0.2, 0);
    ctx.lineTo(w * 0.2, 0);
    ctx.lineTo(w, HORIZON);
    ctx.lineTo(-w, HORIZON);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
  ctx.restore();
}

function drawDust(ctx, p, sprites) {
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  for (const d of FIELD.dust) {
    const y = ((((d.y - p * (H + 40)) % (H + 40)) + H + 40) % (H + 40)) - 20; // one rise per loop
    const x = d.x + Math.sin(TAU * (p + d.phase)) * d.sway;
    const tw = 0.6 + 0.4 * Math.sin(TAU * (p * 2 + d.phase));
    blit(ctx, d.cyan ? sprites.cyan : sprites.white, x, y, d.size * 6, d.a * tw * 0.7);
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
    const L = s.size * (0.6 + 0.8 * a);
    for (const [dx, dy] of [[1, 0], [0, 1]]) {
      const g = ctx.createLinearGradient(s.x - dx * L, s.y - dy * L, s.x + dx * L, s.y + dy * L);
      g.addColorStop(0, hexA(C.light, 0));
      g.addColorStop(0.5, hexA(C.light, a));
      g.addColorStop(1, hexA(C.light, 0));
      ctx.strokeStyle = g;
      ctx.lineWidth = 1.3;
      ctx.beginPath();
      ctx.moveTo(s.x - dx * L, s.y - dy * L);
      ctx.lineTo(s.x + dx * L, s.y + dy * L);
      ctx.stroke();
    }
  }
  ctx.restore();
}

// ── the static chrome ────────────────────────────────────────────────────────

function drawVignette(ctx) {
  const v = ctx.createRadialGradient(CX, H * 0.45, H * 0.35, CX, H * 0.5, W * 0.72);
  v.addColorStop(0, "rgba(0,0,0,0)");
  v.addColorStop(1, "rgba(0,0,0,0.6)");
  ctx.fillStyle = v;
  ctx.fillRect(0, 0, W, H);
  // a soft pool of shade under the type, so it always reads over the floor
  ctx.save();
  ctx.translate(CX, 470);
  ctx.scale(1, 0.32);
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 560);
  g.addColorStop(0, "rgba(2,8,20,0.6)");
  g.addColorStop(1, "rgba(2,8,20,0)");
  ctx.fillStyle = g;
  ctx.fillRect(-560, -560, 1120, 1120);
  ctx.restore();
}

const FRAME_INSET = 14;
const FRAME_RADIUS = 20;

function drawBorder(ctx) {
  roundRect(ctx, FRAME_INSET, FRAME_INSET, W - FRAME_INSET * 2, H - FRAME_INSET * 2, FRAME_RADIUS);
  ctx.lineWidth = 1;
  ctx.strokeStyle = "rgba(216,250,255,0.10)";
  ctx.stroke();
}

/** Brand at top-left, the package badge at top-right. Returns the badge box. */
function drawBrand(ctx, badge) {
  drawBrandMark(ctx, 46, 40, 46);
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = SITE.text;
  ctx.font = `800 25px ${F.x}`;
  ctx.fillText("Dexvra", 102, 64);
  ctx.fillStyle = hexA(C.light, 0.6);
  ctx.font = `700 9.5px ${F.m7}`;
  tracked(ctx, "TOKEN VISIBILITY", 103, 81, 2.4);
  if (!badge) return null;
  const text = String(badge).toUpperCase().slice(0, 28);
  ctx.font = `700 11.5px ${F.m7}`;
  const tw = trackedWidth(ctx, text, 2.2);
  const h = 30;
  const w = tw + 36;
  const x = W - 48 - w;
  const y = 44;
  roundRect(ctx, x, y, w, h, h / 2);
  const bg = ctx.createLinearGradient(x, y, x + w, y + h);
  bg.addColorStop(0, "rgba(61,245,159,0.16)");
  bg.addColorStop(1, "rgba(34,211,238,0.16)");
  ctx.fillStyle = bg;
  ctx.fill();
  ctx.lineWidth = 1.2;
  const bd = ctx.createLinearGradient(x, y, x + w, y);
  bd.addColorStop(0, hexA(C.mint, 0.8));
  bd.addColorStop(1, hexA(C.mid, 0.8));
  ctx.strokeStyle = bd;
  ctx.stroke();
  ctx.fillStyle = "#EFFFFB";
  ctx.textBaseline = "middle";
  tracked(ctx, text, x + 18, y + h / 2 + 1, 2.2);
  ctx.textBaseline = "alphabetic";
  return { x, y, w, h };
}

function icon(ctx, kind, x, y, s) {
  ctx.save();
  ctx.strokeStyle = hexA(C.light, 0.7);
  ctx.lineWidth = 1.5;
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
    ctx.lineWidth = 1.9;
    ctx.beginPath();
    ctx.moveTo(x - s * 0.8, y - s * 0.85);
    ctx.lineTo(x + s * 0.8, y + s * 0.85);
    ctx.moveTo(x + s * 0.8, y - s * 0.85);
    ctx.lineTo(x - s * 0.8, y + s * 0.85);
    ctx.stroke();
  }
  ctx.restore();
}

/** The handles, centred along the foot. */
function drawFooter(ctx) {
  const items = [
    ["web", hostOf(SITE_URL) || "dexvra.io"],
    ["tg", String(CHANNELS.listing || "").startsWith("@") ? CHANNELS.listing : `@${CHANNELS.listing || "dexvralisting"}`],
    ["x", `@${X_LISTING_HANDLE}`],
  ];
  const y = 603;
  ctx.font = `600 14px ${F.d6}`;
  ctx.textBaseline = "middle";
  const widths = items.map(([, t]) => 22 + ctx.measureText(t).width);
  const gap = 38;
  let x = CX - (widths.reduce((a, b) => a + b, 0) + gap * (items.length - 1)) / 2;
  items.forEach(([k, text], i) => {
    icon(ctx, k, x + 7, y, 7);
    ctx.fillStyle = "#A9B8CC";
    ctx.fillText(text, x + 22, y + 1);
    x += widths[i] + gap;
    if (i < items.length - 1) {
      ctx.fillStyle = hexA(C.light, 0.25);
      ctx.beginPath();
      ctx.arc(x - gap / 2, y, 1.6, 0, TAU);
      ctx.fill();
    }
  });
}

// ── type sprites (each element its own canvas, so the intro can move it) ────

/** The ticker, centred: a glow pass, a crisp pass and a mask, plus where each
 *  letter starts — the intro raises the letters one by one. */
function tickerSprites(cv, symbol) {
  const m = cv.createCanvas(10, 10).getContext("2d");
  const text = fitText(m, tickerOf(symbol), 980, { weight: 800, size: 104, min: 48, family: F.x });
  const font = m.font;
  const size = pxOf(font, 104);
  const chars = [...text];
  const tw = m.measureText(text).width;
  const pad = 46;
  const cw = Math.ceil(tw + pad * 2);
  const ch = Math.ceil(size * 1.5 + pad);
  const mid = ch / 2;
  const bounds = [];
  let acc = "";
  for (const c of chars) {
    const x0 = m.measureText(acc).width;
    acc += c;
    bounds.push([pad + x0, pad + m.measureText(acc).width]);
  }
  const mk = () => {
    const c = cv.createCanvas(cw, ch);
    const x = c.getContext("2d");
    x.font = font;
    x.textBaseline = "middle";
    return [c, x];
  };
  const [glow, gx] = mk();
  gx.shadowColor = hexA(C.mid, 0.6);
  gx.shadowBlur = 34;
  gx.fillStyle = hexA(C.mid, 0.55);
  gx.fillText(text, pad, mid);
  const [crisp, cx] = mk();
  cx.shadowColor = "rgba(0,0,0,0.5)";
  cx.shadowBlur = 10;
  cx.shadowOffsetY = 4;
  cx.fillStyle = ice(cx, mid - size * 0.5, mid + size * 0.55);
  cx.fillText(text, pad, mid);
  const [mask, mx] = mk();
  mx.fillStyle = "#FFFFFF";
  mx.fillText(text, pad, mid);
  return { glow, crisp, mask, x: CX - cw / 2, y: 384 - mid, w: cw, h: ch, size, bounds, textX: pad, textW: tw };
}

function nameSprite(cv, name) {
  if (!name) return null;
  const c = cv.createCanvas(900, 46);
  const x = c.getContext("2d");
  const nm = fitText(x, String(name), 860, { weight: 500, size: 26, min: 16, family: F.m });
  x.fillStyle = "#C3D2E6";
  x.textBaseline = "middle";
  x.textAlign = "center";
  x.fillText(nm, 450, 23);
  return { canvas: c, x: CX - 450, y: 446 - 23 };
}

/** The glass chips (static) and where each value goes. */
function chipsLayout(cv, coin) {
  const stats = statsOf(coin);
  if (!stats.length) return null;
  const m = cv.createCanvas(10, 10).getContext("2d");
  let vSize = 21;
  const gap = 14;
  const padX = 22;
  const widest = (v, sz) => {
    m.font = `700 ${sz}px ${F.d7}`;
    return m.measureText(v.replace(/[0-9]/g, "8")).width; // 8 is the widest digit a decode can show
  };
  let widths;
  let total;
  const measure = () => {
    widths = stats.map(([k, v]) => {
      m.font = `700 9.5px ${F.m7}`;
      return Math.ceil(Math.max(trackedWidth(m, k, 2), widest(v, vSize)) + padX * 2);
    });
    total = widths.reduce((a, b) => a + b, 0) + gap * (stats.length - 1);
  };
  measure();
  while (total > 1000 && vSize > 14) {
    vSize -= 1;
    measure();
  }
  const h = 64;
  const y = 488;
  let x = CX - total / 2;
  const chips = stats.map(([k, v], i) => {
    const w = widths[i];
    const c = cv.createCanvas(w + 4, h + 4);
    const g = c.getContext("2d");
    roundRect(g, 2, 2, w, h, 16);
    const bg = g.createLinearGradient(0, 2, 0, h);
    bg.addColorStop(0, "rgba(220,245,255,0.10)");
    bg.addColorStop(1, "rgba(120,190,255,0.035)");
    g.fillStyle = bg;
    g.fill();
    g.lineWidth = 1.2;
    const bd = g.createLinearGradient(0, 2, 0, h);
    bd.addColorStop(0, "rgba(230,250,255,0.42)");
    bd.addColorStop(1, hexA(C.mid, 0.16));
    g.strokeStyle = bd;
    g.stroke();
    g.font = `700 9.5px ${F.m7}`;
    g.fillStyle = hexA(C.light, 0.62);
    g.textBaseline = "alphabetic";
    tracked(g, k, 2 + (w - trackedWidth(g, k, 2)) / 2, 2 + 24, 2);
    const chip = { canvas: c, x: x - 2, y: y - 2, w, h, value: v, cx: x + w / 2 };
    x += w + gap;
    return chip;
  });
  return { chips, font: `700 ${vSize}px ${F.d7}`, valueY: y + 50, box: { x: CX - total / 2, y, w: total, h } };
}

// ── the coin ─────────────────────────────────────────────────────────────────

function coinInitials(symbol) {
  const s = String(symbol || "").replace(/^\$+/, "").toUpperCase();
  return [...s].slice(0, 2).join("") || "?";
}

/** A thin chrome edge — the light rings outside it carry the colour. */
function bezelRing(x, c, r) {
  const g = x.createLinearGradient(c - r, c - r, c + r, c + r);
  g.addColorStop(0, "#FFFFFF");
  g.addColorStop(0.35, "#9EEBFA");
  g.addColorStop(0.6, "#1E6E99");
  g.addColorStop(0.85, "#7FE7FA");
  g.addColorStop(1, "#F2FDFF");
  x.beginPath();
  x.arc(c, c, r + BEZEL / 2, 0, TAU);
  x.lineWidth = BEZEL;
  x.strokeStyle = g;
  x.stroke();
  x.beginPath();
  x.arc(c, c, r + 0.5, 0, TAU);
  x.lineWidth = 1;
  x.strokeStyle = "rgba(0,0,0,0.5)";
  x.stroke();
}

function edgeShade(x, c, r) {
  const edge = x.createRadialGradient(c, c, r * 0.7, c, c, r);
  edge.addColorStop(0, "rgba(0,0,0,0)");
  edge.addColorStop(1, "rgba(0,0,0,0.4)");
  x.fillStyle = edge;
  x.fillRect(0, 0, c * 2, c * 2);
  const gloss = x.createLinearGradient(0, c - r, 0, c);
  gloss.addColorStop(0, "rgba(255,255,255,0.18)");
  gloss.addColorStop(1, "rgba(255,255,255,0)");
  x.fillStyle = gloss;
  x.beginPath();
  x.ellipse(c, c - r * 0.42, r * 0.82, r * 0.5, 0, 0, TAU);
  x.fill();
}

/** The front face: the token's own logo, or a struck face when it has none —
 *  a real logo is never covered. */
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
    g.addColorStop(0, "#173A57");
    g.addColorStop(1, "#050F1A");
    x.fillStyle = g;
    x.fillRect(0, 0, c * 2, c * 2);
    x.beginPath();
    x.arc(c, c, r * 0.8, 0, TAU);
    x.lineWidth = 1.6;
    x.strokeStyle = hexA(C.mid, 0.35);
    x.stroke();
    const ini = coinInitials(symbol);
    x.font = `800 ${ini.length > 1 ? 66 : 80}px ${F.x}`;
    x.textAlign = "center";
    x.textBaseline = "middle";
    x.fillStyle = ice(x, c - 40, c + 40);
    x.fillText(ini, c, c + 4);
    x.textAlign = "left";
  }
  edgeShade(x, c, r);
  x.restore();
  bezelRing(x, c, r);
  return can;
}

/** The reverse: deep ocean carrying the Dexvra mark — what a spin reveals. */
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
    x.lineWidth = 1.3;
    x.strokeStyle = hexA(C.mid, 0.35);
    x.stroke();
  }
  drawBrandMark(x, c - 40, c - 52, 80);
  x.font = `800 15px ${F.x}`;
  x.textAlign = "center";
  x.textBaseline = "middle";
  x.fillStyle = hexA(C.light, 0.85);
  x.fillText("DEXVRA", c, c + 50);
  x.textAlign = "left";
  edgeShade(x, c, r);
  x.restore();
  bezelRing(x, c, r);
  return can;
}

/** Rings of light round the coin: a comet ring turning once per loop, a fine
 *  counter-turning one outside it, and static hairlines. */
function drawRings(ctx, t, p, st, sprites) {
  const k = easeOut(reveal(t, "ring")) * st.alpha;
  if (k <= 0.01) return;
  const { cx, cy, r } = COIN;
  const y = cy + st.bob;
  const open = 0.7 + 0.3 * easeOutBack(Math.min(1, reveal(t, "ring")));
  const R1 = (r + BEZEL + 15) * open;
  const R2 = (r + BEZEL + 29) * open;
  ctx.save();
  for (const [R, a] of [[R1, 0.16], [R2 + 10, 0.08]]) {
    ctx.beginPath();
    ctx.arc(cx, y, R, 0, TAU);
    ctx.lineWidth = 1;
    ctx.strokeStyle = hexA(C.light, a * k);
    ctx.stroke();
  }
  // the comet ring — a conic gradient whose bright head goes round once a loop
  const a1 = TAU * p - Math.PI / 2;
  const g1 = ctx.createConicGradient(a1, cx, y);
  g1.addColorStop(0, hexA(C.mid, 0));
  g1.addColorStop(0.55, hexA(C.blue, 0.25 * k));
  g1.addColorStop(0.9, hexA(C.mid, 0.9 * k));
  g1.addColorStop(0.985, hexA("#FFFFFF", k));
  g1.addColorStop(1, hexA(C.mid, 0));
  ctx.beginPath();
  ctx.arc(cx, y, R1, 0, TAU);
  ctx.lineWidth = 4;
  ctx.strokeStyle = g1;
  ctx.shadowColor = C.mid;
  ctx.shadowBlur = 16;
  ctx.stroke();
  // the outer ring turns the other way, in mint
  const a2 = -TAU * p + Math.PI / 3;
  const g2 = ctx.createConicGradient(a2, cx, y);
  g2.addColorStop(0, hexA(C.mint, 0));
  g2.addColorStop(0.7, hexA(C.mint, 0.12 * k));
  g2.addColorStop(0.97, hexA(C.mint, 0.85 * k));
  g2.addColorStop(1, hexA(C.mint, 0));
  ctx.beginPath();
  ctx.arc(cx, y, R2, 0, TAU);
  ctx.lineWidth = 1.6;
  ctx.strokeStyle = g2;
  ctx.shadowColor = C.mint;
  ctx.shadowBlur = 10;
  ctx.stroke();
  ctx.restore();
  // a spark riding each head
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  const h1 = a1 + TAU * 0.985;
  blit(ctx, sprites.cyan, cx + Math.cos(h1) * R1, y + Math.sin(h1) * R1, 30, k);
  const h2 = a2 + TAU * 0.97;
  blit(ctx, sprites.mint, cx + Math.cos(h2) * R2, y + Math.sin(h2) * R2, 20, k * 0.9);
  ctx.restore();
}

function drawCoinGlow(ctx, st, t, p) {
  const { cx, cy, r } = COIN;
  const y = cy + st.bob;
  const k = st.alpha * Math.min(1, st.s);
  const boost = impactBoost(t, 2.5);
  softGlow(ctx, cx, y, r * 2.8, C.mid, (0.2 + 0.05 * Math.sin(TAU * p * 2)) * k + 0.3 * boost);
  softGlow(ctx, cx, y, r * 1.9, C.blue, 0.16 * k);
  // the coin's light pooled on the floor
  ctx.save();
  ctx.translate(cx, HORIZON + 6);
  ctx.scale(1, 0.14);
  softGlow(ctx, 0, 0, r * 2.2, C.light, 0.2 * k + 0.35 * boost);
  ctx.restore();
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
  const thick = 13 * st.s;
  const dx = sn * thick;
  ctx.save();
  ctx.globalAlpha = st.alpha;
  const steps = Math.max(1, Math.ceil(Math.abs(dx)));
  const rim = ctx.createLinearGradient(0, y - R, 0, y + R);
  rim.addColorStop(0, "#C9F6FF");
  rim.addColorStop(0.35, "#5FC9E6");
  rim.addColorStop(0.7, "#0D4C6E");
  rim.addColorStop(1, "#04202F");
  for (let i = 0; i <= steps; i++) {
    const k = i / steps;
    ctx.beginPath();
    ctx.ellipse(cx - dx / 2 + dx * k, y, R * sx, R, 0, 0, TAU);
    ctx.fillStyle = rim;
    ctx.fill();
  }
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
  softGlow(ctx, cx, cy, 420, C.mid, 0.7 * Math.exp(-v * 6));
  softGlow(ctx, cx, cy, r * 1.3, "#FFFFFF", 0.55 * Math.exp(-v * 9));
  for (const [delay, w, a] of [[0, 6, 0.8], [0.12, 2.6, 0.55]]) {
    const u = (v - delay) / 0.85;
    if (u <= 0 || u >= 1) continue;
    ctx.beginPath();
    ctx.arc(cx, cy, r + 20 + 600 * easeOut(u), 0, TAU);
    ctx.lineWidth = w * (1 - u) + 0.8;
    ctx.strokeStyle = hexA(C.light, (1 - u) ** 2 * a);
    ctx.shadowColor = C.mid;
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
    const y = cy + Math.sin(s.a) * dist + 80 * v * v;
    const len = 6 + s.speed * 0.026 * Math.exp(-v * 3);
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x - Math.cos(s.a) * len, y - Math.sin(s.a) * len);
    ctx.lineWidth = s.w;
    ctx.strokeStyle = s.white ? `rgba(255,255,255,${(1 - u) ** 1.4})` : hexA(C.mid, (1 - u) ** 1.4);
    ctx.stroke();
  }
  ctx.restore();
}

/** A light band across a box, clipped to it. */
function shine(ctx, box, u, alpha, radius) {
  if (!box || u <= 0 || u >= 1) return;
  ctx.save();
  roundRect(ctx, box.x, box.y, box.w, box.h, radius);
  ctx.clip();
  const x = box.x - 80 + u * (box.w + 160);
  const g = ctx.createLinearGradient(x - 60, 0, x + 60, 0);
  g.addColorStop(0, "rgba(255,255,255,0)");
  g.addColorStop(0.5, `rgba(225,250,255,${alpha})`);
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.globalCompositeOperation = "lighter";
  ctx.fillStyle = g;
  ctx.fillRect(box.x, box.y, box.w, box.h);
  ctx.restore();
}

// ── the type, per frame ──────────────────────────────────────────────────────

/** "— NEW LISTING —" centred above the coin: the rules grow outward, the dot
 *  pulses. */
function drawEyebrow(ctx, t, p) {
  const k = reveal(t, "eyebrow");
  if (k <= 0) return;
  const e = easeOut(k);
  const y = 61; // on the brand row, clear of the rings
  const label = "NEW LISTING";
  ctx.save();
  ctx.font = `700 12.5px ${F.m7}`;
  const lw = trackedWidth(ctx, label, 4);
  const total = lw + 22;
  const x0 = CX - total / 2;
  ctx.globalAlpha = e;
  ctx.fillStyle = "#EFFFFB";
  ctx.textBaseline = "middle";
  tracked(ctx, label, x0 + 22, y + 1, 4);
  const f = (p * 3) % 1;
  ctx.beginPath();
  ctx.arc(x0 + 6, y, 4.5 + f * 9 * e, 0, TAU);
  ctx.fillStyle = `rgba(61,245,159,${(1 - f) * 0.4})`;
  ctx.fill();
  ctx.beginPath();
  ctx.arc(x0 + 6, y, 4.5, 0, TAU);
  ctx.fillStyle = C.mint;
  ctx.fill();
  const L = 110 * e;
  for (const dir of [-1, 1]) {
    const xs = dir < 0 ? x0 - 18 : x0 + total + 18;
    const g = ctx.createLinearGradient(xs, 0, xs + dir * L, 0);
    g.addColorStop(0, hexA(C.mint, 0.8));
    g.addColorStop(1, hexA(C.mid, 0));
    ctx.fillStyle = g;
    ctx.fillRect(Math.min(xs, xs + dir * L), y - 0.6, L, 1.2);
  }
  ctx.restore();
}

/** The ticker: letters rise in one by one, and shimmer twice through the hold. */
function drawTicker(ctx, t, tk, scratch) {
  const k = reveal(t, "ticker");
  if (k <= 0) return;
  const outro = t >= HOLD_END && t < OUT_END;
  if (k >= 1 || outro) {
    const e = easeOut(k);
    ctx.save();
    ctx.globalAlpha = e;
    const dy = outro ? (1 - e) * -10 : 0;
    ctx.drawImage(tk.glow, tk.x, tk.y + dy);
    ctx.drawImage(tk.crisp, tk.x, tk.y + dy);
    ctx.restore();
  } else {
    const n = tk.bounds.length;
    for (let i = 0; i < n; i++) {
      const ci = clamp01(k * 1.7 - (i / Math.max(1, n - 1)) * 0.7);
      if (ci <= 0) continue;
      const e = easeOut(ci);
      const [a, b] = tk.bounds[i];
      const x0 = i === 0 ? 0 : a;
      const x1 = i === n - 1 ? tk.w : b;
      const dy = (1 - e) * 46;
      ctx.save();
      ctx.beginPath();
      ctx.rect(tk.x + x0, 0, x1 - x0, H);
      ctx.clip();
      ctx.globalAlpha = e;
      ctx.drawImage(tk.glow, tk.x, tk.y + dy);
      ctx.drawImage(tk.crisp, tk.x, tk.y + dy);
      ctx.restore();
    }
  }
  // the hold shimmer, masked to the glyphs
  let u = -1;
  if (t >= 0.3 && t <= 1.0) u = (t - 0.3) / 0.7;
  else if (t >= 2.3 && t <= 3.0) u = (t - 2.3) / 0.7;
  if (u < 0 || !scratch) return;
  const sx = scratch.getContext("2d");
  sx.globalCompositeOperation = "source-over";
  sx.clearRect(0, 0, scratch.width, scratch.height);
  sx.drawImage(tk.mask, 0, 0);
  sx.globalCompositeOperation = "source-in";
  const bx = tk.textX - 120 + u * (tk.textW + 240);
  const g = sx.createLinearGradient(bx - 60, 0, bx + 60, tk.h);
  const a = Math.sin(u * Math.PI) * 0.8;
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
  ctx.drawImage(nm.canvas, nm.x, nm.y + (1 - e) * 14);
  ctx.restore();
}

/** The glass chips rise in turn; each value then decodes. */
function drawChips(ctx, t, layout) {
  if (!layout) return;
  ctx.save();
  ctx.font = layout.font;
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "center";
  layout.chips.forEach((chip, i) => {
    const k = reveal(t, "stats", i);
    if (k <= 0) return;
    const e = easeOut(clamp01(k * 1.4));
    const dy = (1 - e) * 22;
    ctx.globalAlpha = e;
    ctx.drawImage(chip.canvas, chip.x, chip.y + dy);
    ctx.globalAlpha = clamp01(k * 2.5);
    ctx.fillStyle = "#FFFFFF";
    ctx.fillText(scramble(chip.value, k, t, 97 + i), chip.cx, layout.valueY + dy);
  });
  ctx.restore();
  // a shine across the whole row once in the hold, chip after chip
  if (t >= 1.6 && t <= 2.3) {
    const u = (t - 1.6) / 0.7;
    for (const chip of layout.chips) {
      const lag = ((chip.x - layout.box.x) / Math.max(1, layout.box.w)) * 0.35;
      shine(ctx, { x: chip.x + 2, y: chip.y + 2, w: chip.w, h: chip.h }, clamp01((u - lag) / 0.65), 0.45, 16);
    }
  }
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
  const al = Math.sin(u * Math.PI) * 0.3;
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

  const over = cv.createCanvas(W, H);
  const octx = over.getContext("2d");
  drawVignette(octx);
  octx.drawImage(grainCanvas(cv), 0, 0);
  drawBorder(octx);
  const badgeBox = drawBrand(octx, badge);
  drawFooter(octx);

  const front = faceTexture(cv, img, coin.symbol);
  const back = backTexture(cv);
  const sprites = {
    cyan: glowSprite(cv, C.mid, 0.18),
    mint: glowSprite(cv, C.mint, 0.18),
    white: glowSprite(cv, C.light, 0.25),
  };
  const tk = tickerSprites(cv, coin.symbol);
  const scratch = cv.createCanvas(tk.w, tk.h);
  const nm = nameSprite(cv, coin.name);
  const chips = chipsLayout(cv, coin);

  const out = cv.createCanvas(W, H);
  const ctx = out.getContext("2d");
  // `times` (seconds, unwrapped) is the seam test's seam: t = SECONDS must draw
  // exactly what t = 0 draws, which a wrapped frame index can never show
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
    drawField(ctx, p);
    drawFloor(ctx, p);
    drawSpotlight(ctx, t, p);
    drawDust(ctx, p, sprites);
    drawSparkles(ctx, p);
    drawCoinGlow(ctx, cs, t, p);
    drawRings(ctx, t, p, cs, sprites);
    drawCoin3D(ctx, cs, front, back);
    drawImpact(ctx, t);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    ctx.drawImage(over, 0, 0);
    if (t >= 2.4 && t <= 3.0) shine(ctx, badgeBox, (t - 2.4) / 0.6, 0.55, badgeBox ? badgeBox.h / 2 : 0);
    drawEyebrow(ctx, t, p);
    drawTicker(ctx, t, tk, scratch);
    drawName(ctx, t, nm);
    drawChips(ctx, t, chips);
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
};
