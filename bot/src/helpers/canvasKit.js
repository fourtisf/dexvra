// Shared @napi-rs/canvas plumbing + Dexvra brand primitives.
//
// Extracted from bannerRender.js so the per-token cards (listing / trending /
// rank-up) and the Top-Gainers leaderboard banners draw from ONE palette and one
// set of primitives. Two copies of "the brand mint" is how a banner set starts
// looking like it came from two different products.
//
// The native lib is loaded LAZILY and memoised: requiring @napi-rs/canvas costs
// real startup time, and a box without the prebuilt binary must still boot the
// bot (every renderer degrades to a static banner when available() is false).
const path = require("node:path");
const fss = require("node:fs");
const log = require("./logger");

let CV = null; // null = not tried yet, undefined = tried and unavailable

// Each weight is registered under its OWN family name so weight selection is
// exact — napi-rs' weight matching across several faces of one family is
// unreliable and silently picks the wrong one.
const F = {
  x: "sans-serif", // 800  display
  b: "sans-serif", // 700  bold
  s: "sans-serif", // 600  semibold
  m: "sans-serif", // 500  medium
  r: "sans-serif", // 400  regular
};

function canvasLib() {
  if (CV === undefined) return null;
  if (CV) return CV;
  try {
    CV = require("@napi-rs/canvas");
    const DIR = path.join(__dirname, "..", "..", "assets", "fonts");
    const reg = (file, fam, key) => {
      const p = path.join(DIR, file);
      if (fss.existsSync(p) && CV.GlobalFonts.registerFromPath(p, fam)) F[key] = `"${fam}"`;
    };
    reg("Sora-800.ttf", "Sora XBold", "x");
    reg("Sora-700.ttf", "Sora Bold", "b");
    reg("Sora-600.ttf", "Sora Semi", "s");
    reg("Sora-500.ttf", "Sora Med", "m");
    reg("Sora-400.ttf", "Sora Reg", "r");
    // fallbacks so the module still renders if the premium fonts are missing
    reg("LiberationSans-Bold.ttf", "DexBold", "x");
    if (F.b === "sans-serif") F.b = F.x;
    if (F.s === "sans-serif") F.s = F.x;
    reg("LiberationSans-Regular.ttf", "DexReg", "m");
    if (F.r === "sans-serif") F.r = F.m;
  } catch (e) {
    log.warn(`[banner] canvas unavailable, using static/logo fallback: ${e.message}`);
    CV = undefined;
    return null;
  }
  return CV;
}

// ── Brand palette — refined, not neon ────────────────────────────────────────
const MINT = "#4EE6A8";
const CYAN = "#38D8F0";
const DEEP = "#0E9BD6";
const INK = "#F4F9F8";
const SOFT = "#C4D6D2";
const MUTE = "#8DA6AB";
const FAINT = "#5A6E74";
// Gain / loss. A gainers board is read at a glance: the sign has to be a colour
// before it is a character.
const RISE = "#37E29B";
const FALL = "#E2685F";

// Podium metals — #1 gold, #2 silver, #3 bronze; anything lower falls back to
// the brand mint so a medallion always reads as a premium badge.
const MEDAL = {
  1: { light: "#FFF3C0", mid: "#FFD24D", dark: "#B07A0C", glow: "#FFCE4D" },
  2: { light: "#FFFFFF", mid: "#D6DEE2", dark: "#88949C", glow: "#D6DEE2" },
  3: { light: "#FFD9A8", mid: "#E38A3C", dark: "#8A4B1E", glow: "#E38A3C" },
};
const medalOf = (rank) => MEDAL[rank] || { light: "#CFF6E6", mid: MINT, dark: "#137A54", glow: MINT };

/** #RRGGBB + alpha → rgba() string. */
const hexA = (hex, a) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
};

/** Soft round glow — bright centre fading to transparent edge. */
function radial(ctx, cx, cy, r, color, a0, a1 = 0) {
  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
  g.addColorStop(0, hexA(color, a0));
  g.addColorStop(1, hexA(color, a1));
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
}

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/** The brand sweep: mint → cyan → deep, across an arbitrary box. */
function brandGrad(ctx, x0, y0, x1, y1) {
  const g = ctx.createLinearGradient(x0, y0, x1, y1);
  g.addColorStop(0, MINT);
  g.addColorStop(0.5, CYAN);
  g.addColorStop(1, DEEP);
  return g;
}

/** A 45° metallic sheen across a box (light→mid→dark→mid→light). */
function metalGrad(ctx, x, y, s, m) {
  const g = ctx.createLinearGradient(x - s, y - s, x + s, y + s);
  g.addColorStop(0, m.light);
  g.addColorStop(0.34, m.mid);
  g.addColorStop(0.6, m.dark);
  g.addColorStop(0.82, m.mid);
  g.addColorStop(1, m.light);
  return g;
}

// ── Dexvra gem mark ──────────────────────────────────────────────────────────
function drawGem(ctx, x, y, size) {
  const s = size / 48;
  const P = (px, py) => [x + px * s, y + py * s];
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(...P(15, 12));
  ctx.lineTo(...P(33, 12));
  ctx.lineTo(...P(39, 19));
  ctx.lineTo(...P(24, 37));
  ctx.lineTo(...P(9, 19));
  ctx.closePath();
  ctx.fillStyle = brandGrad(ctx, ...P(9, 12), ...P(39, 37));
  ctx.fill();
  ctx.strokeStyle = "rgba(8,14,20,.5)";
  ctx.lineWidth = Math.max(1, 1.1 * s);
  const seg = (a, b, c, d) => {
    ctx.beginPath();
    ctx.moveTo(...P(a, b));
    ctx.lineTo(...P(c, d));
    ctx.stroke();
  };
  seg(9, 19, 39, 19);
  seg(15, 12, 20, 19);
  seg(33, 12, 28, 19);
  seg(20, 19, 24, 37);
  seg(28, 19, 24, 37);
  ctx.restore();
}

/** Eight-point sparkle — the "premium" glint on a gold badge. */
function sparkle(ctx, x, y, r, color) {
  ctx.save();
  ctx.fillStyle = color;
  ctx.shadowColor = color;
  ctx.shadowBlur = 10;
  ctx.beginPath();
  for (let i = 0; i < 8; i++) {
    const a = (Math.PI / 4) * i;
    const rad = i % 2 ? r * 0.34 : r;
    ctx[i ? "lineTo" : "moveTo"](x + Math.cos(a) * rad, y + Math.sin(a) * rad);
  }
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/**
 * Set a font at the largest size (down from `size`) whose text fits `maxW`, and
 * return the string to draw — truncated with an ellipsis only if even `min`
 * doesn't fit. Every banner has SOME token whose ticker or name is too long;
 * shrink-then-truncate is why one never overflows into the next column.
 */
function fitText(ctx, text, maxW, { weight = 700, size, min = 12, family = F.b } = {}) {
  let s = size;
  ctx.font = `${weight} ${s}px ${family}`;
  while (s > min && ctx.measureText(text).width > maxW) {
    s -= 1;
    ctx.font = `${weight} ${s}px ${family}`;
  }
  if (ctx.measureText(text).width <= maxW) return text;
  let out = text;
  while (out.length > 2 && ctx.measureText(out + "…").width > maxW) out = out.slice(0, -1);
  return out + "…";
}

/** Draw `text` letter-spaced and centred on (cx, cy), returning the run's width.
 *  Canvas letterSpacing exists in napi-rs, but it can't MEASURE a centred tracked
 *  run, so each glyph is placed by hand — which keeps the centre exact at any
 *  tracking. textAlign is forced to "left" for the duration: every glyph is
 *  positioned explicitly, and a caller's leftover "center" would shift each one
 *  by half its own width. */
function trackedCenter(ctx, cx, cy, text, tracking) {
  const chars = [...String(text)];
  const widths = chars.map((c) => ctx.measureText(c).width);
  const total = widths.reduce((a, b) => a + b, 0) + tracking * Math.max(0, chars.length - 1);
  const align = ctx.textAlign;
  ctx.textAlign = "left";
  let x = cx - total / 2;
  for (let i = 0; i < chars.length; i++) {
    ctx.fillText(chars[i], x, cy);
    x += widths[i] + tracking;
  }
  ctx.textAlign = align;
  return total;
}

module.exports = {
  canvasLib,
  available: () => !!canvasLib(),
  F,
  MINT,
  CYAN,
  DEEP,
  INK,
  SOFT,
  MUTE,
  FAINT,
  RISE,
  FALL,
  MEDAL,
  medalOf,
  hexA,
  radial,
  roundRect,
  brandGrad,
  metalGrad,
  drawGem,
  sparkle,
  fitText,
  trackedCenter,
};
