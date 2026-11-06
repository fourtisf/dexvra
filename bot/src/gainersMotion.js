"use strict";
// Dexvra MOTION — the 🎬 Top-Gainers family m1..m10 (2026-11).
//
// "bisakah anda buat banner vidio seperti fourtis banner premium model dexvra"
// (2026-11-06), with a screenshot of the Fourtis gainers panel: 👑 1–10,
// 💎 1–10 and 🎬 1–10, the last being a looping video board. This is Dexvra's
// 🎬: the same KIND of product — a leaderboard that moves, one composition per
// count, frame 0 the full board — in Dexvra's own look, not Fourtis's:
//
//   - a deep sapphire stage: spotlights swaying from above, aurora ribbons
//     behind the headline, a lattice of gem facets, lens bokeh in front of and
//     behind the stage, and a perspective grid floor that mirrors the cards;
//   - sapphire glass cards in a bevelled platinum frame; the leader is rim-lit
//     in the gem's own mint → cyan, with art-deco corners, a light running
//     round its frame, a gold crown on its coin and an orbiting comet ring;
//   - logos struck into a reeded chrome bezel; hexagonal rank badges (gold /
//     silver / bronze for the podium); a light running along every gain bar;
//   - the camera breathes in and out once per loop, the room less than the
//     stage and the front bokeh most — parallax — and is exactly still at
//     frame 0;
//   - the SITE's type: Sora for the figures, Space Grotesk for names,
//     JetBrains Mono for the tracked labels; the Dexvra gem mark.
//
// "buatkan design yang lebih premium" (2026-11-06) is what added the frame,
// the bezel, the crown, the moving light and the camera to the first cut.
//
// ⚠️ THIS FAMILY ONCE EXISTED AND WAS REMOVED ("hapus top gainer yang vidio
// ganti ke foto banner aja", 2026-10-03). It comes back as a FAMILY BESIDE the
// premium stills, never instead of them, and it has an ID SPACE of its own
// (m1..m10): the removed boards were v1..v10, and an install whose stored
// template still names one must not wake up posting a video it never chose.
//
// The loop (fractions of SECONDS), and FRAME 0 IS THE FULL BOARD, so the
// thumbnail Telegram shows before autoplay — and the still that goes to X —
// is never an empty stage:
//
//     hold   0.00 – 0.62  the board at rest; a glint crosses each card in
//                         turn, the leader's ring orbits, the title shines once
//     exit   0.62 – 0.69  the cards dip and fade
//     enter  0.69 – 1.00  they rise back one by one, the gains count up from
//                         zero and the bars fill — ending exactly on frame 0
//
// Every ambient motion (aurora, motes, ring, live pulse) runs whole cycles per
// loop, so the last frame flows into the first. Data is real or absent: a
// price, a market cap or a 24h change the feed did not carry is LEFT OUT,
// never drawn as a zero.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
const { spawn } = require("node:child_process");
const log = require("./helpers/logger");
const kit = require("./helpers/canvasKit");
const { toSendBuffer } = require("./helpers/encodeImage");
const { fmtPct, fmtPrice, fmtCap, ticker } = require("./helpers/format");

const { F, MEDAL, roundRect, drawBrandMark, drawLogoDisc, warnBoxes } = kit;

// Design units are 1280 × 720; the board renders at 1920 × 1080.
const DW = 1280;
const DH = 720;
const K = 1.5;
const W = DW * K;
const H = DH * K;
const FPS = 24;
const SECONDS = 7;
const FRAMES = FPS * SECONDS;
const TAU = Math.PI * 2;

// THE DEXVRA BRAND (the gem's mint → cyan on deep ocean blue, the listing
// clip's palette), and the site's red for a loss.
const C = {
  ice: "#D8FAFF",
  cyan: "#22D3EE",
  mint: "#3DF59F",
  blue: "#2F86FF",
  deep: "#0A6E9C",
  ink: "#F1F5FB",
  dim: "#9AA6BC",
  faint: "#66738C",
  red: "#FF5C7A",
};

// The stage, design units.
const X0 = 56;
const X1 = 1224;
const Y0 = 178;
const Y1 = 612;
const FLOOR = Y1; // a card ending here stands on the floor
const REFLECT = 60; // depth of the mirror image under it
const FOOT_Y = 692;
const PAD = 30; // room around a card in its sprite, for its glow and shadow
// The smallest drawn string, in design units (15px at 1920 wide) — the
// listing clip's floor: X autoplays a ~640px variant, so a label under this
// is a smear on a phone.
const LABEL_MIN = 10;

// The timeline, as fractions of one loop.
const HOLD_END = 0.62;
const EXIT_END = 0.69;
const ENTER_DUR = 0.085; // one card's rise
const COUNT_DELAY = 0.02;
const COUNT_DUR = 0.14; // its figures counting up
const ENTER_SLACK = 0.02; // everything settled this long before the loop ends

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const easeOut = (x) => 1 - (1 - clamp01(x)) ** 3;
const easeIn = (x) => clamp01(x) ** 3;
const easeInOut = (x) => {
  const t = clamp01(x);
  return t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2;
};

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const numOrNull = (v) => {
  if (v === null || v === undefined || v === "") return null; // Number(null) is 0
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const pos = (v) => {
  const n = numOrNull(v);
  return n !== null && n > 0 ? n : null;
};

// ── type ────────────────────────────────────────────────────────────────────
const fx = (s) => `800 ${s}px ${F.x}`; // Sora 800 — headline, tickers, figures
const fname = (s) => `500 ${s}px ${F.d5}`; // Space Grotesk 500 — names, dates
const fcap = (s) => `700 ${Math.max(LABEL_MIN, s)}px ${F.m7}`; // JetBrains Mono 700 — tracked caps
const fnum = (s) => `800 ${s}px ${F.m8}`; // JetBrains Mono 800 — rank numerals, stats

/** Width of a letter-spaced run (drawn glyph by glyph, so measured that way). */
function trackedW(ctx, s, sp) {
  const ch = [...String(s)];
  return ch.reduce((a, c) => a + ctx.measureText(c).width, 0) + sp * Math.max(0, ch.length - 1);
}
function tracked(ctx, s, x, y, sp, align = "left") {
  const w = trackedW(ctx, s, sp);
  let px = align === "center" ? x - w / 2 : align === "right" ? x - w : x;
  const keep = ctx.textAlign;
  ctx.textAlign = "left";
  for (const c of [...String(s)]) {
    ctx.fillText(c, px, y);
    px += ctx.measureText(c).width + sp;
  }
  ctx.textAlign = keep;
  return w;
}

/** Cut `s` with an ellipsis to fit `maxW` — by CODE POINT, never by UTF-16
 *  unit (half an emoji draws as a box). The trending clip's rule. */
function clipTo(ctx, s, maxW) {
  if (ctx.measureText(s).width <= maxW) return s;
  const cs = [...s];
  while (cs.length > 2 && ctx.measureText(cs.join("") + "…").width > maxW) cs.pop();
  return cs.join("") + "…";
}

/** Shrink `text` from `size` toward `floor` until it fits, then cut. Sets
 *  ctx.font to the size chosen. */
function fit(ctx, text, maxW, mk, size, floor) {
  let s = size;
  ctx.font = mk(s);
  while (s > floor && ctx.measureText(text).width > maxW) {
    s = Math.max(floor, s * 0.94);
    ctx.font = mk(s);
  }
  return { text: clipTo(ctx, text, maxW), size: s };
}

function caps(ctx, x, y, s, size, color, align = "left", sp = null) {
  ctx.font = fcap(size);
  ctx.fillStyle = color;
  ctx.textBaseline = "middle";
  return tracked(ctx, String(s).toUpperCase(), x, y, sp === null ? Math.max(LABEL_MIN, size) * 0.2 : sp, align);
}

function lin(ctx, x0, y0, x1, y1, stops) {
  const g = ctx.createLinearGradient(x0, y0, x1, y1);
  for (const [o, c] of stops) g.addColorStop(o, c);
  return g;
}
function rgba(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

// ── coin facts ──────────────────────────────────────────────────────────────
const tickerOf = (c) => ticker(c && c.symbol);
const hasName = (c) => {
  const n = String((c && c.name) || "").trim();
  return !!n && n.toUpperCase() !== String((c && c.symbol) || "").replace(/^\$+/, "").toUpperCase();
};
const metaOf = (c) => {
  const parts = [];
  if (pos(c.price)) parts.push(fmtPrice(c.price));
  if (pos(c.mcap)) parts.push(`MC ${fmtCap(c.mcap)}`);
  return parts.join("  ·  ");
};
const pctOf = (c) => numOrNull(c && c.pct);

/** How full a bar is: the gain against the leader of its group (`min` keeps a
 *  real but tiny gain visible as a sliver). */
function barFrac(c, top, min) {
  const v = pctOf(c);
  if (v === null) return 0;
  return v > 0 ? Math.max(min, Math.min(1, v / top)) : min;
}

/** The leader's gain on this board, the scale every bar is drawn against. */
function topVal(coins) {
  const vals = coins.map(pctOf).filter((v) => v !== null && v > 0);
  return vals.length ? Math.max(...vals) : 1;
}

// ── the board ───────────────────────────────────────────────────────────────
class Board {
  constructor(cv, n, { showPct = true } = {}) {
    this.cv = cv;
    this.n = n;
    this.showPct = showPct !== false;
    this.items = [];
    this.bars = []; // every gain bar, for the light that runs along it
    this.cur = null; // the card being built
    this.ring = null; // { cx, cy, d } of the leader's logo, design units
    this.liveDot = null;
    this.title = null; // { canvas, x, y } — the headline as a mask, px
  }

  hasPct(c) {
    return this.showPct && pctOf(c) !== null;
  }

  // the gain as drawn at count-up progress p (p = 1 is the real figure)
  gain(ctx, c, x, y, size, align, p = 1, glow = false) {
    const v = pctOf(c);
    if (!this.showPct || v === null) return;
    const shown = p >= 1 ? v : v * easeOut(p);
    ctx.save();
    ctx.font = fx(size);
    ctx.textAlign = align;
    ctx.textBaseline = "middle";
    const up = v >= 0;
    ctx.fillStyle = up ? lin(ctx, 0, y - size / 2, 0, y + size / 2, [[0, "#B6FFDD"], [0.55, C.mint], [1, "#17C6A0"]]) : C.red;
    if (glow) {
      ctx.shadowColor = rgba(up ? C.mint : C.red, 0.55);
      ctx.shadowBlur = size * 0.45 * K;
    }
    // counting up from zero still carries the sign of where it is going
    ctx.fillText(shown === 0 && v > 0 ? "+0.0%" : fmtPct(shown), x, y);
    ctx.restore();
  }

  gainW(ctx, c, size) {
    const v = pctOf(c);
    if (!this.showPct || v === null) return 0;
    ctx.font = fx(size);
    return ctx.measureText(fmtPct(v)).width;
  }

  sym(ctx, c, x, y, size, align, maxW, floor = 13) {
    ctx.save();
    const r = fit(ctx, tickerOf(c), maxW || 9999, fx, size, Math.min(size, floor));
    ctx.textAlign = align;
    ctx.textBaseline = "middle";
    ctx.fillStyle = C.ink;
    ctx.shadowColor = "rgba(0,0,0,0.55)";
    ctx.shadowBlur = 6 * K;
    ctx.shadowOffsetY = 2 * K;
    ctx.fillText(r.text, x, y);
    const w = ctx.measureText(r.text).width;
    ctx.restore();
    return w;
  }

  nm(ctx, c, x, y, size, align, maxW) {
    if (!hasName(c)) return;
    ctx.save();
    ctx.font = fname(Math.max(LABEL_MIN, size));
    ctx.textAlign = align;
    ctx.textBaseline = "middle";
    ctx.fillStyle = C.dim;
    ctx.fillText(clipTo(ctx, String(c.name).trim(), maxW || 9999), x, y);
    ctx.restore();
  }

  meta(ctx, c, x, y, size, align, maxW) {
    const s = metaOf(c);
    if (!s) return;
    ctx.save();
    ctx.font = `600 ${Math.max(LABEL_MIN, size)}px ${F.m6}`;
    ctx.textAlign = align;
    ctx.textBaseline = "middle";
    ctx.fillStyle = C.dim;
    ctx.fillText(clipTo(ctx, s, maxW || 9999), x, y);
    ctx.restore();
  }

  /** Sapphire glass in a platinum frame. The leader is rim-lit, mint → cyan,
   *  with art-deco corners — and a light runs round its frame (compose). */
  card(ctx, box, r, hero) {
    const [x0, y0, x1, y1] = box;
    const w = x1 - x0;
    const h = y1 - y0;
    ctx.save();
    roundRect(ctx, x0, y0, w, h, r);
    ctx.fillStyle = "rgba(3,8,18,1)";
    ctx.shadowColor = "rgba(0,0,0,0.78)";
    ctx.shadowBlur = 30 * K;
    ctx.shadowOffsetY = 16 * K;
    ctx.fill();
    if (hero) {
      ctx.shadowColor = rgba(C.cyan, 0.5);
      ctx.shadowBlur = 42 * K;
      ctx.shadowOffsetY = 0;
      ctx.fill();
    }
    ctx.restore();

    ctx.save();
    roundRect(ctx, x0, y0, w, h, r);
    ctx.clip();
    ctx.fillStyle = lin(ctx, 0, y0, 0, y1, hero
      ? [[0, "#1B4C76"], [0.38, "#0E2C4D"], [1, "#05122A"]]
      : [[0, "#15304F"], [0.5, "#0B1C34"], [1, "#050E1E"]]);
    ctx.fillRect(x0, y0, w, h);
    // the light from above pooling on the top of the card
    const lg = ctx.createRadialGradient(x0 + w / 2, y0 - h * 0.12, 0, x0 + w / 2, y0 - h * 0.12, Math.max(w, h) * 0.75);
    lg.addColorStop(0, rgba(hero ? "#7FE8FF" : "#9FD8FF", hero ? 0.3 : 0.12));
    lg.addColorStop(1, rgba(C.cyan, 0));
    ctx.fillStyle = lg;
    ctx.fillRect(x0, y0, w, h);
    // the gem facet: a cut of glass across the top-left corner
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x0 + Math.min(w * 0.46, 240), y0);
    ctx.lineTo(x0 + Math.min(w * 0.2, 110), y0 + h * 0.62);
    ctx.lineTo(x0, y0 + h * 0.4);
    ctx.closePath();
    ctx.fillStyle = lin(ctx, x0, y0, x0 + w * 0.3, y0 + h * 0.5, [[0, "rgba(255,255,255,0.08)"], [1, "rgba(255,255,255,0.008)"]]);
    ctx.fill();
    // a specular band along the top
    ctx.fillStyle = lin(ctx, 0, y0, 0, y0 + Math.min(70, h * 0.22), [[0, "rgba(255,255,255,0.09)"], [1, "rgba(255,255,255,0)"]]);
    ctx.fillRect(x0, y0, w, Math.min(70, h * 0.22));
    // weight at the bottom
    ctx.fillStyle = lin(ctx, 0, y0 + h * 0.55, 0, y1, [[0, "rgba(0,0,0,0)"], [1, "rgba(0,0,0,0.32)"]]);
    ctx.fillRect(x0, y0, w, h);
    ctx.restore();

    // the frame: platinum, bevelled
    ctx.save();
    roundRect(ctx, x0 + 1, y0 + 1, w - 2, h - 2, r - 1);
    ctx.lineWidth = hero ? 2.4 : 2;
    ctx.strokeStyle = hero
      ? lin(ctx, x0, y0, x1, y1, [[0, "#B8FFE0"], [0.3, C.mint], [0.55, "#9DEFFF"], [0.8, C.cyan], [1, C.blue]])
      : lin(ctx, x0, y0, x1, y1, [[0, "#EEF5FB"], [0.3, "#7C91A7"], [0.55, "#D3E0EB"], [0.8, "#53677D"], [1, "#9FB2C4"]]);
    if (!hero) ctx.globalAlpha = 0.55;
    ctx.stroke();
    ctx.globalAlpha = 1;
    roundRect(ctx, x0 + 3.5, y0 + 3.5, w - 7, h - 7, Math.max(2, r - 3.5));
    ctx.lineWidth = 1;
    ctx.strokeStyle = `rgba(255,255,255,${hero ? 0.1 : 0.06})`;
    ctx.stroke();
    // a bright hairline along the top edge
    ctx.beginPath();
    ctx.moveTo(x0 + r * 1.2, y0 + 1.2);
    ctx.lineTo(x1 - r * 1.2, y0 + 1.2);
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = lin(ctx, x0 + r, 0, x1 - r, 0, [[0, "rgba(255,255,255,0)"], [0.5, `rgba(255,255,255,${hero ? 0.85 : 0.4})`], [1, "rgba(255,255,255,0)"]]);
    ctx.stroke();
    if (hero) {
      // art-deco corners: an L and a diamond at each
      const L = Math.min(26, w * 0.08);
      const ins = 9;
      ctx.lineWidth = 1.6;
      ctx.strokeStyle = rgba(C.ice, 0.9);
      ctx.fillStyle = rgba(C.ice, 0.95);
      for (const [sx, sy] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
        const cx = sx > 0 ? x0 + ins : x1 - ins;
        const cy = sy > 0 ? y0 + ins : y1 - ins;
        ctx.beginPath();
        ctx.moveTo(cx, cy + sy * L);
        ctx.lineTo(cx, cy);
        ctx.lineTo(cx + sx * L, cy);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(cx + sx * 6, cy + sy * 2.5);
        ctx.lineTo(cx + sx * 8.5, cy + sy * 6);
        ctx.lineTo(cx + sx * 6, cy + sy * 9.5);
        ctx.lineTo(cx + sx * 3.5, cy + sy * 6);
        ctx.closePath();
        ctx.fill();
      }
    }
    ctx.restore();
  }

  /** The logo struck into a reeded chrome bezel; no logo (or bytes that are
   *  not one) is a monogram. */
  disc(ctx, c, cx, cy, d, hero = false) {
    const r = d / 2;
    const band = Math.max(2.4, d * 0.07);
    const ri = r - band;
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, TAU);
    ctx.fillStyle = "#06101E";
    ctx.shadowColor = "rgba(0,0,0,0.7)";
    ctx.shadowBlur = d * 0.14 * K;
    ctx.shadowOffsetY = d * 0.07 * K;
    ctx.fill();
    if (hero) {
      ctx.shadowColor = rgba(C.cyan, 0.7);
      ctx.shadowBlur = d * 0.34 * K;
      ctx.shadowOffsetY = 0;
      ctx.fill();
    }
    ctx.restore();

    // the bezel: chrome, reeded
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, TAU);
    ctx.arc(cx, cy, ri, 0, TAU, true);
    ctx.fillStyle = lin(ctx, cx - r, cy - r, cx + r, cy + r, hero
      ? [[0, "#FFFFFF"], [0.25, "#B9FFE4"], [0.5, C.cyan], [0.75, "#E4FBFF"], [1, C.deep]]
      : [[0, "#FFFFFF"], [0.3, "#AFC2D3"], [0.52, "#EAF2F8"], [0.78, "#5B7088"], [1, "#C9D7E3"]]);
    ctx.fill();
    if (d >= 44) {
      const n = Math.round(Math.min(120, d * 0.9));
      ctx.lineWidth = Math.max(0.5, d * 0.006);
      ctx.strokeStyle = "rgba(10,24,40,0.35)";
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const a = (i * TAU) / n;
        ctx.moveTo(cx + Math.cos(a) * (ri + band * 0.22), cy + Math.sin(a) * (ri + band * 0.22));
        ctx.lineTo(cx + Math.cos(a) * (r - band * 0.18), cy + Math.sin(a) * (r - band * 0.18));
      }
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.arc(cx, cy, r - 0.4, 0, TAU);
    ctx.lineWidth = 0.8;
    ctx.strokeStyle = "rgba(255,255,255,0.55)";
    ctx.stroke();
    ctx.restore();

    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, ri, 0, TAU);
    ctx.clip();
    if (c.img) {
      drawLogoDisc(ctx, c.img, cx, cy, ri, { backdrop: "#0B1424" });
    } else {
      const g = ctx.createRadialGradient(cx - ri * 0.3, cy - ri * 0.35, 0, cx, cy, ri);
      g.addColorStop(0, "#1C4A6E");
      g.addColorStop(1, "#071426");
      ctx.fillStyle = g;
      ctx.fillRect(cx - ri, cy - ri, ri * 2, ri * 2);
      const ini = [...String(c.symbol || "?").replace(/^\$+/, "")].slice(0, 2).join("").toUpperCase() || "?";
      ctx.font = fx(ri * 0.8);
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = lin(ctx, cx - ri, cy - ri, cx + ri, cy + ri, [[0, C.mint], [1, C.cyan]]);
      ctx.fillText(ini, cx, cy + ri * 0.04);
    }
    // gloss on the upper half, weight on the lower, and the inner rim
    ctx.fillStyle = lin(ctx, 0, cy - ri, 0, cy + ri * 0.1, [[0, "rgba(255,255,255,0.24)"], [1, "rgba(255,255,255,0)"]]);
    ctx.beginPath();
    ctx.ellipse(cx, cy - ri * 0.42, ri * 0.68, ri * 0.5, 0, 0, TAU);
    ctx.fill();
    ctx.fillStyle = lin(ctx, 0, cy, 0, cy + ri, [[0, "rgba(0,0,0,0)"], [1, "rgba(0,0,0,0.3)"]]);
    ctx.fillRect(cx - ri, cy, ri * 2, ri);
    ctx.restore();
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, ri, 0, TAU);
    ctx.lineWidth = Math.max(0.8, d * 0.01);
    ctx.strokeStyle = "rgba(4,12,24,0.75)";
    ctx.stroke();
    ctx.restore();
  }

  /** The champion's crown, sat on top of its coin: gold, a cyan gem. */
  crown(ctx, cx, bottom, w) {
    const h = w * 0.62;
    const top = bottom - h;
    const m = MEDAL[1];
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(cx - w / 2, bottom);
    ctx.lineTo(cx - w / 2, top + h * 0.34);
    ctx.lineTo(cx - w * 0.25, top + h * 0.6);
    ctx.lineTo(cx, top + h * 0.12);
    ctx.lineTo(cx + w * 0.25, top + h * 0.6);
    ctx.lineTo(cx + w / 2, top + h * 0.34);
    ctx.lineTo(cx + w / 2, bottom);
    ctx.closePath();
    ctx.shadowColor = rgba(m.glow, 0.6);
    ctx.shadowBlur = w * 0.3 * K;
    ctx.fillStyle = lin(ctx, 0, top, 0, bottom, [[0, m.light], [0.45, m.mid], [1, m.dark]]);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.lineWidth = Math.max(0.8, w * 0.025);
    ctx.strokeStyle = rgba("#FFF6D8", 0.8);
    ctx.stroke();
    // the band
    ctx.fillStyle = lin(ctx, 0, bottom - h * 0.24, 0, bottom, [[0, m.mid], [1, m.dark]]);
    ctx.fillRect(cx - w / 2, bottom - h * 0.24, w, h * 0.24);
    // pearls on the points, a cyan gem in the band
    for (const [px, py] of [[cx - w / 2, top + h * 0.34], [cx, top + h * 0.12], [cx + w / 2, top + h * 0.34]]) {
      ctx.beginPath();
      ctx.arc(px, py, w * 0.07, 0, TAU);
      ctx.fillStyle = "#FFFBEA";
      ctx.fill();
    }
    ctx.beginPath();
    ctx.moveTo(cx, bottom - h * 0.21);
    ctx.lineTo(cx + w * 0.07, bottom - h * 0.12);
    ctx.lineTo(cx, bottom - h * 0.03);
    ctx.lineTo(cx - w * 0.07, bottom - h * 0.12);
    ctx.closePath();
    ctx.fillStyle = lin(ctx, cx - w * 0.07, 0, cx + w * 0.07, 0, [[0, C.mint], [1, C.cyan]]);
    ctx.fill();
    ctx.restore();
  }

  /** A hexagonal rank badge — a cut gem; metal for the podium. */
  badge(ctx, cx, cy, s, rank) {
    const m = rank <= 3 ? MEDAL[rank] : null;
    ctx.save();
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
      const a = -Math.PI / 2 + (i * TAU) / 6;
      const px = cx + s * Math.cos(a);
      const py = cy + s * Math.sin(a);
      if (i) ctx.lineTo(px, py);
      else ctx.moveTo(px, py);
    }
    ctx.closePath();
    ctx.shadowColor = m ? rgba(m.glow, 0.45) : "rgba(0,0,0,0.5)";
    ctx.shadowBlur = s * 0.6 * K;
    ctx.fillStyle = m
      ? lin(ctx, cx, cy - s, cx, cy + s, [[0, m.light], [0.5, m.mid], [1, m.dark]])
      : lin(ctx, cx, cy - s, cx, cy + s, [[0, "#163654"], [1, "#081628"]]);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = m ? rgba("#FFFFFF", 0.55) : rgba(C.cyan, 0.6);
    ctx.stroke();
    ctx.font = fnum(Math.max(LABEL_MIN, s * 0.98));
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = m ? "#0B1220" : C.ink;
    ctx.fillText(String(rank), cx, cy + s * 0.06);
    ctx.restore();
  }

  /** Gain bar: a faint track, a blue → cyan → mint fill and a glowing head. */
  comet(ctx, x0, x1, y, h, c, top, p = 1) {
    if (!this.showPct) return; // the bar is the % drawn as a length
    ctx.save();
    roundRect(ctx, x0, y - h / 2, x1 - x0, h, h / 2);
    ctx.fillStyle = "rgba(255,255,255,0.07)";
    ctx.fill();
    const v = pctOf(c);
    if (v === null) return ctx.restore();
    const frac = barFrac(c, top, 0.04) * easeOut(p);
    if (frac < 0.005) return ctx.restore();
    const xe = x0 + (x1 - x0) * frac;
    const up = v >= 0;
    roundRect(ctx, x0, y - h / 2, Math.max(xe - x0, h), h, h / 2);
    ctx.fillStyle = lin(ctx, x0, 0, xe, 0, up ? [[0, C.blue], [0.55, C.cyan], [1, C.mint]] : [[0, "#5A1424"], [1, C.red]]);
    ctx.shadowColor = rgba(up ? C.cyan : C.red, 0.5);
    ctx.shadowBlur = h * 1.4 * K;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(xe, y, h * 0.95, 0, TAU);
    ctx.fillStyle = "#FFFFFF";
    ctx.shadowColor = rgba(up ? C.mint : C.red, 0.9);
    ctx.shadowBlur = h * 2.2 * K;
    ctx.fill();
    ctx.restore();
  }

  /** Equalizer column: the height is the gain against the leader. */
  vbar(ctx, cx, yb, yt, w, c, top, p = 1) {
    if (!this.showPct) return;
    ctx.save();
    roundRect(ctx, cx - w / 2, yt, w, yb - yt, w / 2);
    ctx.fillStyle = "rgba(255,255,255,0.05)";
    ctx.fill();
    const v = pctOf(c);
    if (v === null) return ctx.restore();
    const frac = barFrac(c, top, 0.05) * easeOut(p);
    if (frac < 0.005) return ctx.restore();
    const ye = yb - (yb - yt) * frac;
    const up = v >= 0;
    roundRect(ctx, cx - w / 2, ye, w, yb - ye, w / 2);
    ctx.fillStyle = lin(ctx, 0, ye, 0, yb, up ? [[0, C.mint], [0.45, C.cyan], [1, "#0B3460"]] : [[0, C.red], [1, "#3A0E1C"]]);
    ctx.shadowColor = rgba(up ? C.cyan : C.red, 0.45);
    ctx.shadowBlur = w * 0.8 * K;
    ctx.fill();
    ctx.shadowBlur = 0;
    roundRect(ctx, cx - w / 2, ye, w, Math.min(w * 0.5, yb - ye), w / 2);
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    ctx.fill();
    ctx.restore();
  }

  /** Rows of (height, fn(y)) drawn top-down as one block centred on cy. */
  stack(cy, rows) {
    let y = cy - rows.reduce((a, [h]) => a + h, 0) / 2;
    for (const [h, fn] of rows) {
      fn(y + h / 2);
      y += h;
    }
  }

  /** One card into its own sprite: build() draws the static parts and returns
   *  the LIVE ones (count-up gains, filling bars) as fn(ctx, p). */
  item(box, order, build, { r = 20, hero = false } = {}) {
    const [x0, y0, x1, y1] = box;
    const sw = Math.ceil((x1 - x0 + PAD * 2) * K);
    const sh = Math.ceil((y1 - y0 + PAD * 2) * K);
    const local = (ctx) => {
      ctx.scale(K, K);
      ctx.translate(PAD - x0, PAD - y0);
    };
    const body = this.cv.createCanvas(sw, sh);
    const bx = body.getContext("2d");
    local(bx);
    this.card(bx, box, r, hero);
    this.cur = { order, hero, box };
    const lives = build(bx) || [];
    this.cur = null;
    const final = this.cv.createCanvas(sw, sh);
    const fx2 = final.getContext("2d");
    fx2.drawImage(body, 0, 0);
    local(fx2);
    for (const lv of lives) lv(fx2, 1);
    let reflect = null;
    if (Math.abs(y1 - FLOOR) < 0.5) {
      const rh = Math.round(REFLECT * K);
      reflect = this.cv.createCanvas(sw, rh);
      const rx = reflect.getContext("2d");
      rx.translate(0, (PAD + y1 - y0) * K);
      rx.scale(1, -1);
      rx.drawImage(final, 0, 0);
      rx.setTransform(1, 0, 0, 1, 0, 0);
      rx.globalCompositeOperation = "destination-in";
      rx.fillStyle = lin(rx, 0, 0, 0, rh, [[0, "rgba(0,0,0,0.30)"], [1, "rgba(0,0,0,0)"]]);
      rx.fillRect(0, 0, sw, rh);
    }
    this.items.push({
      box, r, hero, order, lives, body, final, reflect,
      x: Math.round((x0 - PAD) * K),
      y: Math.round((y0 - PAD) * K),
      local,
    });
  }
}

// ── card contents ───────────────────────────────────────────────────────────
const at = (coins, i) => (i < coins.length && coins[i] ? coins[i] : null);

/** Logo on top; ticker, name, gain and the market line stacked under it. */
function portrait(b, ctx, box, c, rank, { plinth = false } = {}) {
  const [x0, y0, x1, y1] = box;
  const w = x1 - x0;
  const cx = (x0 + x1) / 2;
  const hero = rank === 1;
  const lives = [];
  const base = y1 - (plinth ? 56 : 0);
  const bs = w > 240 ? 15 : 13;
  b.badge(ctx, x0 + 18 + bs, y0 + 18 + bs, bs, rank);
  if (hero) caps(ctx, x0 + 18 + bs * 2 + 10, y0 + 18 + bs, "TOP GAINER", w > 240 ? 11 : 10, C.mint);
  let symSz = Math.min(46, Math.max(18, w * 0.13));
  let gSz = Math.min(44, Math.max(17, w * 0.12));
  // the champion's crown sits on its coin: room for it under the badge row
  const topY = y0 + 30 + bs * 2 + (hero ? Math.min(46, w * 0.11) : 0);
  const botY = base - 14;
  const avail = botY - topY;
  let withMeta = !!metaOf(c);
  let d = 0;
  let textH = 0;
  for (let k = 0; k < 8; k++) {
    textH = symSz * 1.25 + (hasName(c) ? Math.max(LABEL_MIN, symSz * 0.36) * 1.7 : 0) + (b.hasPct(c) ? gSz * 1.5 : 0) + (withMeta ? 22 : 0);
    d = Math.min(w * 0.44, 190, avail - textH - 16);
    if (d >= Math.max(46, avail * 0.3)) break;
    if (withMeta) {
      withMeta = false; // the market line is the first thing to go
      continue;
    }
    symSz = Math.max(13, symSz * 0.9);
    gSz = Math.max(12, gSz * 0.9);
  }
  d = Math.max(34, d);
  const block = d + 16 + textH;
  const t0 = topY + Math.max(0, (avail - block) * 0.42);
  const dcy = t0 + d / 2;
  b.disc(ctx, c, cx, dcy, d, hero);
  if (hero) {
    b.ring = { cx, cy: dcy, d };
    b.crownSpec = { cx: cx, bottom: dcy - d / 2 + d * 0.4 * 0.62 * 0.3, w: d * 0.4 };
  }
  const room = w - 36;
  const rows = [[symSz * 1.25, (y) => b.sym(ctx, c, cx, y, symSz, "center", room)]];
  if (hasName(c)) rows.push([Math.max(LABEL_MIN, symSz * 0.36) * 1.7, (y) => b.nm(ctx, c, cx, y, symSz * 0.36, "center", room)]);
  if (b.hasPct(c)) rows.push([gSz * 1.5, (y) => lives.push((cx2, p) => b.gain(cx2, c, cx, y, gSz, "center", p, hero))]);
  if (withMeta) rows.push([22, (y) => b.meta(ctx, c, cx, y, w > 300 ? 11 : 10, "center", room)]);
  b.stack(dcy + d / 2 + 16 + textH / 2, rows);
  if (plinth) {
    ctx.save();
    roundRect(ctx, x0 + 1, base, w - 2, y1 - base - 1, 16);
    ctx.fillStyle = "rgba(0,0,0,0.28)";
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(x0 + 18, base);
    ctx.lineTo(x1 - 18, base);
    ctx.lineWidth = 1;
    ctx.strokeStyle = lin(ctx, x0, 0, x1, 0, [[0, rgba(C.cyan, 0)], [0.5, rgba(hero ? C.mint : C.cyan, 0.7)], [1, rgba(C.cyan, 0)]]);
    ctx.stroke();
    ctx.font = fnum(hero ? 30 : 24);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const m = MEDAL[rank];
    ctx.fillStyle = m ? lin(ctx, 0, base + 14, 0, base + 42, [[0, m.light], [1, m.mid]]) : C.dim;
    ctx.fillText(String(rank).padStart(2, "0"), cx, base + 29);
    ctx.restore();
  }
  return lives;
}

/** Logo on the left, the text beside it; the gain big on the right. */
function landscape(b, ctx, box, c, rank, { big = true } = {}) {
  const [x0, y0, x1, y1] = box;
  const h = y1 - y0;
  const cy = (y0 + y1) / 2;
  const hero = rank === 1;
  const lives = [];
  const d = Math.min(h * 0.64, 150);
  const dcx = x0 + 26 + d / 2;
  b.disc(ctx, c, dcx, cy, d, hero);
  if (hero) {
    b.ring = { cx: dcx, cy, d };
    b.crownSpec = { cx: dcx, bottom: cy - d / 2 + d * 0.36 * 0.62 * 0.3, w: d * 0.36 };
  }
  const right = x1 - 28;
  const gSz = big ? Math.min(56, h * 0.3) : Math.min(30, h * 0.22);
  const gw = big ? b.gainW(ctx, c, gSz) : 0;
  if (big && gw) {
    caps(ctx, right, cy - gSz * 0.66, "24H CHANGE", 10, hero ? C.mint : C.faint, "right");
    lives.push((c2, p) => b.gain(c2, c, right, cy + 10, gSz, "right", p, hero));
  }
  const tx = dcx + d / 2 + 22;
  const room = right - tx - (gw ? gw + 30 : 0);
  const symSz = Math.min(50, h * 0.27);
  const bs = 11;
  const rows = [[24, (y) => {
    b.badge(ctx, tx + bs, y, bs, rank);
    caps(ctx, tx + bs * 2 + 8, y, hero ? "TOP GAINER" : `RANK ${rank}`, 10, hero ? C.mint : C.dim);
  }], [symSz * 1.22, (y) => b.sym(ctx, c, tx, y, symSz, "left", room)]];
  if (hasName(c) && h > 110) rows.push([Math.max(LABEL_MIN, symSz * 0.34) * 1.6, (y) => b.nm(ctx, c, tx + 1, y, symSz * 0.34, "left", room)]);
  if (!big && b.hasPct(c)) rows.push([gSz * 1.45, (y) => lives.push((c2, p) => b.gain(c2, c, tx + 1, y, gSz, "left", p))]);
  if (metaOf(c) && h >= 136) rows.push([20, (y) => b.meta(ctx, c, tx + 1, y, 11, "left", room)]);
  b.stack(cy, rows);
  return lives;
}

/** Small card: logo, ticker and gain; the rank in the corner. */
function compact(b, ctx, box, c, rank) {
  const [x0, y0, x1, y1] = box;
  const w = x1 - x0;
  const h = y1 - y0;
  const cy = (y0 + y1) / 2;
  const lives = [];
  const d = Math.min(h * 0.5, 84, w * 0.3);
  const dcx = x0 + 16 + d / 2;
  b.disc(ctx, c, dcx, cy, d);
  b.badge(ctx, x1 - 20, y0 + 20, 11, rank);
  const tx = dcx + d / 2 + 14;
  const room = x1 - 14 - tx - 18;
  const symSz = Math.min(26, Math.max(14, h * 0.17), w * 0.09);
  const gSz = Math.min(22, Math.max(13, h * 0.15));
  const rows = [[symSz * 1.25, (y) => b.sym(ctx, c, tx, y, symSz, "left", room, 11)]];
  if (b.hasPct(c)) rows.push([gSz * 1.45, (y) => lives.push((c2, p) => b.gain(c2, c, tx + 1, y, gSz, "left", p))]);
  b.stack(cy, rows);
  return lives;
}

/** Leaderboard row: badge, logo, ticker, comet bar, gain. */
function row(b, ctx, box, c, rank, top) {
  const [x0, y0, x1, y1] = box;
  const w = x1 - x0;
  const h = y1 - y0;
  const cy = (y0 + y1) / 2;
  const lives = [];
  const bs = Math.min(17, h * 0.2);
  const nx = x0 + 16 + bs;
  b.badge(ctx, nx, cy, bs, rank);
  const d = Math.min(h * 0.58, 70);
  const dcx = nx + bs + 14 + d / 2;
  b.disc(ctx, c, dcx, cy, d, rank === 1);
  const right = x1 - 24;
  const gSz = Math.min(30, h * 0.27);
  const gw = b.gainW(ctx, c, gSz);
  if (gw) lives.push((c2, p) => b.gain(c2, c, right, cy, gSz, "right", p, rank === 1));
  const tx = dcx + d / 2 + 16;
  const barX1 = right - (gw ? gw + 26 : 0);
  const symSz = Math.min(26, h * 0.25);
  const ty = b.hasPct(c) ? cy - h * 0.13 : cy;
  const sw = b.sym(ctx, c, tx, ty, symSz, "left", Math.min(barX1 - tx, w * 0.34));
  // the name beside the ticker, only where it fits whole enough to read
  const nameX = tx + sw + 12;
  if (hasName(c) && barX1 - nameX > 70) b.nm(ctx, c, nameX, ty + symSz * 0.08, Math.max(LABEL_MIN, symSz * 0.5), "left", barX1 - nameX);
  if (b.hasPct(c)) {
    const bh = Math.max(4, h * 0.06);
    lives.push((c2, p) => b.comet(c2, tx, barX1, cy + h * 0.22, bh, c, top, p));
    b.bars.push({ kind: "h", x0: tx, x1: barX1, y: cy + h * 0.22, h: bh, frac: barFrac(c, top, 0.04), order: b.cur.order });
  }
  return lives;
}

/** Equalizer column: the bar rises behind; logo, ticker and gain below. */
function column(b, ctx, box, c, rank, top) {
  const [x0, y0, x1, y1] = box;
  const w = x1 - x0;
  const h = y1 - y0;
  const cx = (x0 + x1) / 2;
  const lives = [];
  b.badge(ctx, cx, y0 + 22, 12, rank);
  const foot = h * 0.44;
  const d = Math.min(w * 0.4, foot * 0.42, 64);
  const dcy = y1 - foot + 10 + d / 2;
  const yb = dcy - d / 2 - 12;
  const yt = y0 + 44;
  if (b.hasPct(c)) {
    const bw = Math.min(w * 0.22, 26);
    lives.push((c2, p) => b.vbar(c2, cx, yb, yt, bw, c, top, p));
    b.bars.push({ kind: "v", cx, yb, yt, w: bw, frac: barFrac(c, top, 0.05), order: b.cur.order });
  }
  b.disc(ctx, c, cx, dcy, d);
  const symSz = Math.min(20, w * 0.11);
  const gSz = Math.min(19, w * 0.1);
  const rows = [[symSz * 1.3, (y) => b.sym(ctx, c, cx, y, symSz, "center", w - 20, 11)]];
  if (b.hasPct(c)) rows.push([gSz * 1.45, (y) => lives.push((c2, p) => b.gain(c2, c, cx, y, gSz, "center", p))]);
  b.stack((dcy + d / 2 + y1) / 2, rows);
  return lives;
}

/** m1: one card — the logo large with the orbit ring, the gain huge, and a
 *  strip of whatever market numbers the feed carried. */
function heroStage(b, ctx, box, c) {
  const [x0, y0, x1, y1] = box;
  const w = x1 - x0;
  const lives = [];
  const stats = [
    ["PRICE", pos(c.price) ? fmtPrice(c.price) : null],
    ["MARKET CAP", pos(c.mcap) ? fmtCap(c.mcap) : null],
    ["LIQUIDITY", pos(c.liq) ? fmtCap(c.liq) : null],
  ].filter(([, v]) => v);
  const split = stats.length ? y1 - 96 : y1;
  const cy = (y0 + split) / 2;
  const d = Math.min(220, (split - y0) * 0.7);
  const dcx = x0 + 70 + d / 2;
  b.disc(ctx, c, dcx, cy, d, true);
  b.ring = { cx: dcx, cy, d };
  b.crownSpec = { cx: dcx, bottom: cy - d / 2 + d * 0.34 * 0.62 * 0.3, w: d * 0.34 };
  const right = x1 - 60;
  const gSz = 78;
  const gw = b.gainW(ctx, c, gSz);
  if (gw) {
    caps(ctx, right, cy - 56, "24H CHANGE", 12, C.mint, "right");
    lives.push((c2, p) => b.gain(c2, c, right, cy + 8, gSz, "right", p, true));
  }
  const tx = dcx + d / 2 + 46;
  const room = right - tx - (gw ? gw + 40 : 0);
  const rows = [
    [30, (y) => {
      b.badge(ctx, tx + 13, y, 13, 1);
      caps(ctx, tx + 36, y, "TOP GAINER OF THE DAY", 12, C.mint);
    }],
    [84, (y) => b.sym(ctx, c, tx, y, 70, "left", room, 26)],
  ];
  if (hasName(c)) rows.push([34, (y) => b.nm(ctx, c, tx + 3, y, 21, "left", room)]);
  b.stack(cy, rows);
  if (stats.length) {
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(x0 + 34, split);
    ctx.lineTo(x1 - 34, split);
    ctx.lineWidth = 0.9;
    ctx.strokeStyle = lin(ctx, x0, 0, x1, 0, [[0, "rgba(255,255,255,0)"], [0.5, "rgba(160,220,255,0.3)"], [1, "rgba(255,255,255,0)"]]);
    ctx.stroke();
    const cw = w / stats.length;
    stats.forEach(([k, v], j) => {
      const mx = x0 + cw * (j + 0.5);
      if (j) {
        ctx.beginPath();
        ctx.moveTo(x0 + cw * j, split + 22);
        ctx.lineTo(x0 + cw * j, y1 - 22);
        ctx.lineWidth = 0.8;
        ctx.strokeStyle = "rgba(160,220,255,0.18)";
        ctx.stroke();
      }
      caps(ctx, mx, split + 32, k, 11, C.faint, "center");
      ctx.font = fnum(24);
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = C.ink;
      ctx.fillText(clipTo(ctx, v, cw - 30), mx, split + 64);
    });
    ctx.restore();
  }
  return lives;
}

// ── the ten compositions ────────────────────────────────────────────────────
function m1(b, coins) {
  const c = at(coins, 0);
  if (!c) return;
  const box = [X0 + 70, Y0, X1 - 70, Y1];
  b.item(box, 0, (ctx) => heroStage(b, ctx, box, c), { r: 26, hero: true });
}

function m2(b, coins) {
  const gap = 28;
  const w = (X1 - X0 - gap) / 2;
  [[0, [X0, Y0, X0 + w, Y1]], [1, [X0 + w + gap, Y0 + 34, X1, Y1]]].forEach(([i, box]) => {
    const c = at(coins, i);
    if (c) b.item(box, i, (ctx) => portrait(b, ctx, box, c, i + 1), { r: 24, hero: i === 0 });
  });
}

function m3(b, coins) {
  const sw = 352;
  const cw = 420;
  const gap = 22;
  [[1, [X0, Y0 + 50, X0 + sw, Y1]], [0, [X0 + sw + gap, Y0, X0 + sw + gap + cw, Y1]], [2, [X1 - sw, Y0 + 86, X1, Y1]]].forEach(([i, box]) => {
    const c = at(coins, i);
    if (c) b.item(box, i, (ctx) => portrait(b, ctx, box, c, i + 1, { plinth: true }), { r: 24, hero: i === 0 });
  });
}

function m4(b, coins) {
  const gap = 20;
  const w = (X1 - X0 - gap * 3) / 4;
  for (let i = 0; i < 4; i++) {
    const c = at(coins, i);
    if (!c) continue;
    const box = [X0 + i * (w + gap), Y0, X0 + i * (w + gap) + w, Y1];
    b.item(box, i, (ctx) => portrait(b, ctx, box, c, i + 1), { r: 22, hero: i === 0 });
  }
}

function m5(b, coins) {
  const c = at(coins, 0);
  const lw = 400;
  if (c) {
    const box = [X0, Y0, X0 + lw, Y1];
    b.item(box, 0, (ctx) => portrait(b, ctx, box, c, 1), { r: 24, hero: true });
  }
  // the rows' bars against the leader OF THE ROWS: the hero carries no bar,
  // and a +3981% leader would leave every row a sliver
  const top = topVal(coins.slice(1, 5));
  const gap = 14;
  const h = (Y1 - Y0 - gap * 3) / 4;
  for (let k = 0; k < 4; k++) {
    const cc = at(coins, k + 1);
    if (!cc) continue;
    const y0 = Y0 + k * (h + gap);
    const box = [X0 + lw + 24, y0, X1, y0 + h];
    b.item(box, k + 1, (ctx) => row(b, ctx, box, cc, k + 2, top), { r: 18 });
  }
}

function m6(b, coins) {
  const th = 206;
  const gap = 20;
  [[0, [X0, Y0, X0 + 700, Y0 + th]], [1, [X0 + 700 + gap, Y0, X1, Y0 + th]]].forEach(([i, box]) => {
    const c = at(coins, i);
    if (c) b.item(box, i, (ctx) => landscape(b, ctx, box, c, i + 1, { big: i === 0 }), { r: 22, hero: i === 0 });
  });
  const g = 18;
  const w = (X1 - X0 - g * 3) / 4;
  for (let k = 0; k < 4; k++) {
    const c = at(coins, k + 2);
    if (!c) continue;
    const x0 = X0 + k * (w + g);
    const box = [x0, Y0 + th + 18, x0 + w, Y1];
    b.item(box, k + 2, (ctx) => portrait(b, ctx, box, c, k + 3), { r: 20 });
  }
}

function m7(b, coins) {
  const th = 150;
  const c = at(coins, 0);
  if (c) {
    const box = [X0, Y0, X1, Y0 + th];
    b.item(box, 0, (ctx) => landscape(b, ctx, box, c, 1), { r: 22, hero: true });
  }
  const top = topVal(coins.slice(1, 7)); // the columns against their own leader
  const gap = 16;
  const w = (X1 - X0 - gap * 5) / 6;
  for (let k = 0; k < 6; k++) {
    const cc = at(coins, k + 1);
    if (!cc) continue;
    const x0 = X0 + k * (w + gap);
    const box = [x0, Y0 + th + 18, x0 + w, Y1];
    b.item(box, k + 1, (ctx) => column(b, ctx, box, cc, k + 2, top), { r: 20 });
  }
}

function m8(b, coins) {
  const top = topVal(coins.slice(0, 8));
  const gx = 24;
  const gy = 12;
  const w = (X1 - X0 - gx) / 2;
  const h = (Y1 - Y0 - gy * 3) / 4;
  for (let i = 0; i < 8; i++) {
    const c = at(coins, i);
    if (!c) continue;
    const col = Math.floor(i / 4);
    const r = i % 4;
    const x0 = X0 + col * (w + gx);
    const y0 = Y0 + r * (h + gy);
    const box = [x0, y0, x0 + w, y0 + h];
    b.item(box, i, (ctx) => row(b, ctx, box, c, i + 1, top), { r: 18, hero: i === 0 });
  }
}

function m9(b, coins) {
  const c = at(coins, 0);
  const h1 = 136;
  if (c) {
    const box = [X0 + 234, Y0, X1 - 234, Y0 + h1];
    b.item(box, 0, (ctx) => landscape(b, ctx, box, c, 1), { r: 22, hero: true });
  }
  const g = 18;
  const w2 = (X1 - X0 - g * 2) / 3;
  const y2 = Y0 + h1 + 14;
  const h2 = 132;
  for (let k = 0; k < 3; k++) {
    const cc = at(coins, k + 1);
    if (!cc) continue;
    const x0 = X0 + k * (w2 + g);
    const box = [x0, y2, x0 + w2, y2 + h2];
    b.item(box, k + 1, (ctx) => landscape(b, ctx, box, cc, k + 2, { big: false }), { r: 20 });
  }
  const g3 = 14;
  const w3 = (X1 - X0 - g3 * 4) / 5;
  const y3 = y2 + h2 + 14;
  for (let k = 0; k < 5; k++) {
    const cc = at(coins, k + 4);
    if (!cc) continue;
    const x0 = X0 + k * (w3 + g3);
    const box = [x0, y3, x0 + w3, Y1];
    b.item(box, k + 4, (ctx) => compact(b, ctx, box, cc, k + 5), { r: 18 });
  }
}

function m10(b, coins) {
  const lw = 360;
  const c = at(coins, 0);
  if (c) {
    const box = [X0, Y0, X0 + lw, Y1];
    b.item(box, 0, (ctx) => portrait(b, ctx, box, c, 1), { r: 24, hero: true });
  }
  const gx = 14;
  const gy = 12;
  const w = (X1 - X0 - lw - 20 - gx * 2) / 3;
  const h = (Y1 - Y0 - gy * 2) / 3;
  for (let k = 0; k < 9; k++) {
    const cc = at(coins, k + 1);
    if (!cc) continue;
    const r = Math.floor(k / 3);
    const col = k % 3;
    const x0 = X0 + lw + 20 + col * (w + gx);
    const y0 = Y0 + r * (h + gy);
    const box = [x0, y0, x0 + w, y0 + h];
    b.item(box, k + 1, (ctx) => compact(b, ctx, box, cc, k + 2), { r: 18 });
  }
}

const LAYOUTS = { 1: m1, 2: m2, 3: m3, 4: m4, 5: m5, 6: m6, 7: m7, 8: m8, 9: m9, 10: m10 };
const NAMES = {
  1: "Hero Stage", 2: "Face-off", 3: "Podium", 4: "Showcase", 5: "Spotlight + Rows",
  6: "Two Tier", 7: "Hero + Equalizer", 8: "Ranked Rows", 9: "Pyramid 1-3-5", 10: "Hero + Nine",
};
const TEMPLATE_IDS = Object.keys(LAYOUTS).map((n) => `m${n}`);
const isTemplate = (id) => TEMPLATE_IDS.includes(id);
const countOf = (id) => (isTemplate(id) ? Number(String(id).slice(1)) : null);
const labelOf = (id) => (isTemplate(id) ? `🎬 ${NAMES[countOf(id)]}` : String(id));

// ── chrome: the stage, the header, the footer ───────────────────────────────
function backdrop(cv) {
  const out = cv.createCanvas(W, H);
  const ctx = out.getContext("2d");
  ctx.scale(K, K);
  ctx.fillStyle = lin(ctx, 0, 0, 0, DH, [[0, "#0B2244"], [0.4, "#06142C"], [1, "#020611"]]);
  ctx.fillRect(0, 0, DW, DH);
  const bloom = (x, y, r, color, a) => {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, rgba(color, a));
    g.addColorStop(1, rgba(color, 0));
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  };
  bloom(640, 60, 680, "#1C78C0", 0.45); // behind the headline
  bloom(640, FLOOR + 10, 620, "#1784C4", 0.32); // the light pooling on the floor
  bloom(60, 420, 440, "#123F80", 0.32);
  bloom(1220, 420, 440, "#123F80", 0.32);

  // a lattice of gem facets, fading down from the top
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, DW, FLOOR);
  ctx.clip();
  ctx.strokeStyle = lin(ctx, 0, 0, 0, FLOOR, [[0, rgba("#A8DCFF", 0.075)], [0.45, rgba("#A8DCFF", 0.03)], [1, rgba("#A8DCFF", 0)]]);
  ctx.lineWidth = 0.7;
  const k = Math.tan(Math.PI / 6);
  ctx.beginPath();
  for (let x = -FLOOR; x < DW + FLOOR; x += 56) {
    ctx.moveTo(x, 0);
    ctx.lineTo(x + FLOOR / k / 2.2, FLOOR);
    ctx.moveTo(x, 0);
    ctx.lineTo(x - FLOOR / k / 2.2, FLOOR);
  }
  ctx.stroke();
  ctx.restore();

  // the floor: a sheen under the horizon and a perspective grid
  ctx.fillStyle = lin(ctx, 0, FLOOR, 0, DH, [[0, rgba(C.cyan, 0.09)], [1, rgba(C.cyan, 0)]]);
  ctx.fillRect(0, FLOOR, DW, DH - FLOOR);
  const vpY = FLOOR - 340;
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, FLOOR, DW, DH - FLOOR);
  ctx.clip();
  for (let i = -16; i <= 16; i++) {
    const xb = 640 + i * 110;
    const t = (FLOOR - vpY) / (DH + 40 - vpY);
    ctx.beginPath();
    ctx.moveTo(640 + (xb - 640) * t, FLOOR);
    ctx.lineTo(xb, DH + 40);
    ctx.lineWidth = 0.8;
    ctx.strokeStyle = lin(ctx, 0, FLOOR, 0, DH, [[0, rgba(C.cyan, 0.16)], [1, rgba(C.cyan, 0.02)]]);
    ctx.stroke();
  }
  for (let j = 1; j <= 6; j++) {
    const y = FLOOR + 6 * j * j * 0.9;
    if (y > DH) break;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(DW, y);
    ctx.lineWidth = 0.7;
    ctx.strokeStyle = lin(ctx, 0, 0, DW, 0, [[0, rgba(C.cyan, 0)], [0.5, rgba(C.cyan, 0.11 / j ** 0.5)], [1, rgba(C.cyan, 0)]]);
    ctx.stroke();
  }
  ctx.restore();
  // the horizon line
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(60, FLOOR);
  ctx.lineTo(1220, FLOOR);
  ctx.lineWidth = 1.4;
  ctx.strokeStyle = lin(ctx, 60, 0, 1220, 0, [[0, rgba(C.cyan, 0)], [0.25, rgba(C.cyan, 0.6)], [0.5, rgba(C.mint, 0.9)], [0.75, rgba(C.cyan, 0.6)], [1, rgba(C.cyan, 0)]]);
  ctx.shadowColor = rgba(C.cyan, 0.85);
  ctx.shadowBlur = 12 * K;
  ctx.stroke();
  ctx.restore();
  return out;
}

/** The cinematic vignette, laid over everything last. */
function vignette(cv) {
  const out = cv.createCanvas(W, H);
  const ctx = out.getContext("2d");
  ctx.scale(K, K);
  const vg = ctx.createRadialGradient(640, 380, 330, 640, 380, 860);
  vg.addColorStop(0, "rgba(0,0,0,0)");
  vg.addColorStop(1, "rgba(0,0,0,0.66)");
  ctx.fillStyle = vg;
  ctx.fillRect(0, 0, DW, DH);
  return out;
}

/** The header and footer, on a transparent layer drawn over the aurora. */
function chrome(cv, b, n, dateText) {
  const out = cv.createCanvas(W, H);
  const ctx = out.getContext("2d");
  ctx.scale(K, K);
  ctx.textBaseline = "middle";

  // kicker: ● LIVE · ◆ DEXVRA · 24H TOP GAINERS
  const y = 40;
  ctx.font = fcap(11);
  const sp = 2.6;
  const wLive = trackedW(ctx, "LIVE", sp);
  const wDex = trackedW(ctx, "DEXVRA", sp);
  const wTail = trackedW(ctx, "24H TOP GAINERS", sp);
  const mark = 17;
  const sep = 30;
  const total = 13 + wLive + sep + mark + 8 + wDex + sep + wTail;
  let x = 640 - total / 2;
  // the kicker sits in a glass capsule
  ctx.save();
  roundRect(ctx, x - 18, y - 14, total + 36, 28, 14);
  ctx.fillStyle = "rgba(255,255,255,0.05)";
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = lin(ctx, x - 18, 0, x + total + 18, 0, [[0, rgba(C.cyan, 0.15)], [0.5, rgba("#BFE9FF", 0.4)], [1, rgba(C.cyan, 0.15)]]);
  ctx.stroke();
  ctx.restore();
  b.liveDot = { x: x + 3.5, y };
  ctx.save();
  ctx.beginPath();
  ctx.arc(x + 3.5, y, 3.5, 0, TAU);
  ctx.fillStyle = C.mint;
  ctx.shadowColor = C.mint;
  ctx.shadowBlur = 8 * K;
  ctx.fill();
  ctx.restore();
  x += 13;
  ctx.fillStyle = C.mint;
  tracked(ctx, "LIVE", x, y, sp);
  x += wLive + sep / 2;
  ctx.fillStyle = C.faint;
  ctx.textAlign = "center";
  ctx.fillText("·", x, y);
  ctx.textAlign = "left";
  x += sep / 2;
  drawBrandMark(ctx, x, y - mark / 2, mark);
  x += mark + 8;
  ctx.font = fcap(11);
  ctx.fillStyle = C.ink;
  tracked(ctx, "DEXVRA", x, y, sp);
  x += wDex + sep / 2;
  ctx.fillStyle = C.faint;
  ctx.textAlign = "center";
  ctx.fillText("·", x, y);
  ctx.textAlign = "left";
  x += sep / 2;
  ctx.fillStyle = C.dim;
  tracked(ctx, "24H TOP GAINERS", x, y, sp);

  // the headline: chrome, the count in the gem's mint → cyan
  const ty = 94;
  const tsz = 56;
  const parts = n === 1 ? [["TOP GAINER", false]] : [["TOP ", false], [String(n), true], [" GAINERS", false]];
  ctx.font = fx(tsz);
  const tsp = 1.4;
  const widths = parts.map(([t]) => trackedW(ctx, t, tsp));
  const tw = widths.reduce((a, v) => a + v, 0);
  // the title as a mask, for the shine that crosses it once per loop
  const pad = 12;
  const mx = Math.floor((640 - tw / 2 - pad) * K);
  const my = Math.floor((ty - tsz * 0.75) * K);
  const mw = Math.ceil((tw + pad * 2) * K);
  const mh = Math.ceil(tsz * 1.5 * K);
  const mask = cv.createCanvas(mw, mh);
  const mc = mask.getContext("2d");
  mc.scale(K, K);
  mc.translate(-(640 - tw / 2 - pad), -(ty - tsz * 0.75));
  mc.font = fx(tsz);
  mc.textBaseline = "middle";
  mc.fillStyle = "#FFFFFF";
  x = 640 - tw / 2;
  parts.forEach(([t, em], i) => {
    ctx.save();
    ctx.font = fx(tsz);
    ctx.shadowColor = em ? rgba(C.cyan, 0.55) : "rgba(0,0,0,0.85)";
    ctx.shadowBlur = (em ? 22 : 12) * K;
    ctx.shadowOffsetY = em ? 0 : 4 * K;
    ctx.fillStyle = em
      ? lin(ctx, 0, ty - tsz / 2, 0, ty + tsz / 2, [[0, "#E6FFF5"], [0.45, C.mint], [1, C.cyan]])
      : lin(ctx, 0, ty - tsz / 2, 0, ty + tsz / 2, [[0, "#FFFFFF"], [0.5, C.ice], [0.62, "#9EB8CF"], [1, "#E8F4FF"]]);
    tracked(ctx, t, x, ty, tsp);
    ctx.restore();
    tracked(mc, t, x, ty, tsp);
    x += widths[i];
  });
  b.title = { canvas: mask, x: mx, y: my };

  // the date between two fading rules
  if (dateText) {
    const dy = 136;
    ctx.font = fname(12);
    ctx.fillStyle = C.dim;
    const wd = tracked(ctx, String(dateText).toUpperCase(), 640, dy, 2.2, "center");
    for (const s of [-1, 1]) {
      const a0 = 640 + s * (wd / 2 + 18);
      const a1 = a0 + s * 150;
      ctx.beginPath();
      ctx.moveTo(Math.min(a0, a1), dy);
      ctx.lineTo(Math.max(a0, a1), dy);
      ctx.lineWidth = 0.9;
      ctx.strokeStyle = lin(ctx, a0, 0, a1, 0, [[0, rgba(C.cyan, 0.6)], [1, rgba(C.cyan, 0)]]);
      ctx.stroke();
      // a cut diamond where each rule begins
      ctx.beginPath();
      ctx.moveTo(a0 - s * 2, dy);
      ctx.lineTo(a0 - s * 6, dy - 4);
      ctx.lineTo(a0 - s * 10, dy);
      ctx.lineTo(a0 - s * 6, dy + 4);
      ctx.closePath();
      ctx.fillStyle = lin(ctx, 0, dy - 4, 0, dy + 4, [[0, C.mint], [1, C.cyan]]);
      ctx.fill();
    }
  }

  // footer: ◆ dexvra.io, between the tagline and the ranking rule
  ctx.font = fx(14);
  const fm = 16;
  const fw = fm + 8 + ctx.measureText("dexvra.io").width;
  const fx0 = 640 - fw / 2;
  drawBrandMark(ctx, fx0, FOOT_Y - fm / 2, fm);
  ctx.font = fx(14);
  ctx.fillStyle = C.ink;
  ctx.textAlign = "left";
  ctx.fillText("dexvra.io", fx0 + fm + 8, FOOT_Y);
  for (const s of [-1, 1]) {
    const a0 = 640 + s * (fw / 2 + 22);
    const a1 = a0 + s * 200;
    ctx.beginPath();
    ctx.moveTo(Math.min(a0, a1), FOOT_Y);
    ctx.lineTo(Math.max(a0, a1), FOOT_Y);
    ctx.lineWidth = 0.8;
    ctx.strokeStyle = lin(ctx, a0, 0, a1, 0, [[0, rgba(C.cyan, 0.4)], [1, rgba(C.cyan, 0)]]);
    ctx.stroke();
  }
  caps(ctx, X0, FOOT_Y, "FIND THE NEXT MOONSHOT", 10, C.faint, "left", 1.8);
  caps(ctx, X1, FOOT_Y, "RANKED BY 24H CHANGE", 10, C.faint, "right", 1.8);
  return out;
}

// the aurora: ribbons whose phases advance a WHOLE number of cycles per loop
const RIBBONS = [
  { y: 112, amp: 18, th: 16, k1: 2, c1: 1, k2: 3, c2: -1, k3: 1, c3: 1, color: "#22D3EE", a: 0.07 },
  { y: 150, amp: 14, th: 12, k1: 1, c1: -1, k2: 4, c2: 1, k3: 2, c3: -1, color: "#2F86FF", a: 0.06 },
  { y: 70, amp: 12, th: 10, k1: 3, c1: 1, k2: 2, c2: 1, k3: 1, c3: -1, color: "#3DF59F", a: 0.04 },
];
function drawAurora(ctx, u) {
  ctx.save();
  ctx.scale(K, K);
  for (const r of RIBBONS) {
    const pts = [];
    for (let x = -20; x <= DW + 20; x += 20) {
      const s = x / DW;
      const yc = r.y + r.amp * Math.sin(TAU * (r.k1 * s + r.c1 * u)) + r.amp * 0.6 * Math.sin(TAU * (r.k2 * s + r.c2 * u) + 1.3);
      const t = r.th * (0.55 + 0.45 * Math.sin(TAU * (r.k3 * s + r.c3 * u) + 0.7));
      pts.push([x, yc, t]);
    }
    for (const [mul, a] of [[3, 0.35], [1.8, 0.6], [1, 1]]) {
      ctx.beginPath();
      pts.forEach(([x, y, t], i) => (i ? ctx.lineTo(x, y - t * mul) : ctx.moveTo(x, y - t * mul)));
      for (let i = pts.length - 1; i >= 0; i--) ctx.lineTo(pts[i][0], pts[i][1] + pts[i][2] * mul);
      ctx.closePath();
      ctx.fillStyle = lin(ctx, 0, 0, DW, 0, [[0, rgba(r.color, 0)], [0.25, rgba(r.color, r.a * a)], [0.5, rgba(r.color, r.a * a * 1.4)], [0.75, rgba(r.color, r.a * a)], [1, rgba(r.color, 0)]]);
      ctx.fill();
    }
  }
  ctx.restore();
}

function glowSprite(cv, D, color) {
  const s = cv.createCanvas(D, D);
  const x = s.getContext("2d");
  const g = x.createRadialGradient(D / 2, D / 2, 0, D / 2, D / 2, D / 2);
  g.addColorStop(0, rgba("#FFFFFF", 0.95));
  g.addColorStop(0.25, rgba(color, 0.7));
  g.addColorStop(1, rgba(color, 0));
  x.fillStyle = g;
  x.fillRect(0, 0, D, D);
  return s;
}

/** The leader's orbit ring: a light arc with a bright head and a fading tail. */
function ringSprite(cv, dPx) {
  const pad = Math.max(10, Math.round(dPx * 0.14));
  const S = dPx + pad * 2;
  const s = cv.createCanvas(S, S);
  const x = s.getContext("2d");
  const r = dPx / 2;
  const segs = 90;
  const lw = Math.max(2, dPx * 0.022);
  x.lineCap = "round";
  for (let i = 0; i < segs; i++) {
    const f = i / (segs - 1);
    const a0 = -Math.PI / 2 + (i * (TAU * 300 / 360)) / segs;
    x.beginPath();
    x.arc(S / 2, S / 2, r, a0, a0 + (TAU * 300 / 360) / segs + 0.02);
    x.lineWidth = lw;
    x.strokeStyle = rgba(f > 0.6 ? C.mint : C.cyan, f ** 2.2);
    x.shadowColor = rgba(C.cyan, f ** 2);
    x.shadowBlur = dPx * 0.05;
    x.stroke();
  }
  const ha = -Math.PI / 2 + TAU * 300 / 360;
  x.beginPath();
  x.arc(S / 2 + r * Math.cos(ha), S / 2 + r * Math.sin(ha), lw * 1.5, 0, TAU);
  x.fillStyle = "#FFFFFF";
  x.shadowColor = C.mint;
  x.shadowBlur = dPx * 0.08;
  x.fill();
  return s;
}

/** A lens bokeh: a soft disc with a brighter rim. */
function bokehSprite(cv, D, color) {
  const s = cv.createCanvas(D, D);
  const x = s.getContext("2d");
  const g = x.createRadialGradient(D / 2, D / 2, 0, D / 2, D / 2, D / 2);
  g.addColorStop(0, rgba(color, 0.55));
  g.addColorStop(0.78, rgba(color, 0.62));
  g.addColorStop(0.9, rgba(color, 0.85));
  g.addColorStop(1, rgba(color, 0));
  x.fillStyle = g;
  x.beginPath();
  x.arc(D / 2, D / 2, D / 2, 0, TAU);
  x.fill();
  return s;
}

/** The champion's crown as a sprite, drawn over its orbit ring. */
function crownSprite(cv, b, spec) {
  const Sw = Math.ceil(spec.w * 1.7 * K);
  const Sh = Math.ceil(spec.w * 1.3 * K);
  const s = cv.createCanvas(Sw, Sh);
  const x = s.getContext("2d");
  x.scale(K, K);
  const bx = spec.w * 0.85;
  const by = spec.w * 1.05;
  b.crown(x, bx, by, spec.w);
  return { canvas: s, dx: spec.cx * K - bx * K, dy: spec.bottom * K - by * K };
}

/** Behind the cards: the champion's spotlight, and a pool of light under every
 *  card that stands on the floor. */
function stageBack(cv, b) {
  const out = cv.createCanvas(W, H);
  const ctx = out.getContext("2d");
  ctx.scale(K, K);
  const hero = b.items.find((it) => it.hero);
  if (hero) {
    const [x0, y0, x1] = hero.box;
    const cx = (x0 + x1) / 2;
    const w = x1 - x0;
    ctx.beginPath();
    ctx.moveTo(cx - w * 0.12, -40);
    ctx.lineTo(cx + w * 0.12, -40);
    ctx.lineTo(cx + w * 0.62, y0 + 40);
    ctx.lineTo(cx - w * 0.62, y0 + 40);
    ctx.closePath();
    ctx.fillStyle = lin(ctx, 0, -40, 0, y0 + 40, [[0, rgba(C.ice, 0.0)], [0.35, rgba(C.ice, 0.07)], [1, rgba(C.cyan, 0.12)]]);
    ctx.fill();
  }
  for (const it of b.items) {
    const [x0, , x1, y1] = it.box;
    if (Math.abs(y1 - FLOOR) > 0.5) continue;
    const cx = (x0 + x1) / 2;
    const rx = (x1 - x0) * 0.62;
    ctx.save();
    ctx.translate(cx, FLOOR + 4);
    ctx.scale(1, 0.09);
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, rx);
    g.addColorStop(0, rgba(it.hero ? C.mint : C.cyan, it.hero ? 0.55 : 0.32));
    g.addColorStop(1, rgba(C.cyan, 0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0, 0, rx, 0, TAU);
    ctx.fill();
    ctx.restore();
  }
  return out;
}

// the spotlights from above: each sways one whole cycle per loop
const BEAMS = [
  { x: 230, w: 250, a: 0.06, ph: 0.0 },
  { x: 500, w: 290, a: 0.085, ph: 0.3 },
  { x: 780, w: 290, a: 0.085, ph: 0.55 },
  { x: 1050, w: 250, a: 0.06, ph: 0.8 },
];
function drawBeams(ctx, u) {
  ctx.save();
  ctx.scale(K, K);
  ctx.globalCompositeOperation = "lighter";
  for (const bm of BEAMS) {
    const sway = 70 * Math.sin(TAU * (u + bm.ph));
    const fx = bm.x + (640 - bm.x) * 0.22 + sway;
    ctx.beginPath();
    ctx.moveTo(bm.x - 16, -60);
    ctx.lineTo(bm.x + 16, -60);
    ctx.lineTo(fx + bm.w / 2, FLOOR);
    ctx.lineTo(fx - bm.w / 2, FLOOR);
    ctx.closePath();
    ctx.fillStyle = lin(ctx, 0, -60, 0, FLOOR, [[0, rgba(C.ice, bm.a)], [0.5, rgba(C.cyan, bm.a * 0.45)], [1, rgba(C.cyan, 0)]]);
    ctx.fill();
  }
  ctx.restore();
}

/** Lay out the board once: the stage, the chrome, and every card's sprite. */
function build(cv, n, coins, { dateText = "", showPct = true } = {}) {
  const b = new Board(cv, n, { showPct });
  b.bg = backdrop(cv);
  b.chrome = chrome(cv, b, n, dateText);
  b.vig = vignette(cv);
  LAYOUTS[n](b, coins);
  b.back = stageBack(cv, b);
  if (b.ring) b.ringSprite = ringSprite(cv, Math.round(b.ring.d * 1.22 * K));
  if (b.crownSpec) b.crownSprite = crownSprite(cv, b, b.crownSpec);
  const r = rng(n * 7919 + 3);
  const sprites = { 4: glowSprite(cv, Math.round(6 * K), C.cyan), 7: glowSprite(cv, Math.round(10 * K), C.mint), 11: glowSprite(cv, Math.round(15 * K), C.ice) };
  b.motes = Array.from({ length: 34 }, () => ({
    x: 40 + r() * (DW - 80),
    y: 160 + r() * (FLOOR - 170),
    sprite: sprites[[4, 4, 7, 7, 11][Math.floor(r() * 5)]],
    laps: r() < 0.6 ? 1 : 2,
    sway: 4 + r() * 12,
    ph: r() * TAU,
    tw: 1 + Math.floor(r() * 3),
    a: 0.2 + r() * 0.45,
  }));
  const bok = { cyan: bokehSprite(cv, 192, "#5FD8FF"), blue: bokehSprite(cv, 192, "#3E7BFF"), mint: bokehSprite(cv, 192, "#5DF5B2") };
  const kinds = ["cyan", "cyan", "blue", "mint"];
  b.bokehBack = Array.from({ length: 14 }, () => ({
    x: r() * DW, y: 150 + r() * (FLOOR - 120), rad: 22 + r() * 46,
    sprite: bok[kinds[Math.floor(r() * 4)]], a: 0.05 + r() * 0.08,
    ax: 18 + r() * 40, ph: r(),
  }));
  const corners = [[70, 160], [1210, 180], [40, 640], [1250, 620], [640, 700]];
  b.bokehFront = corners.map(([x, y]) => ({
    x, y, rad: 80 + r() * 70, sprite: bok[kinds[Math.floor(r() * 4)]], a: 0.035 + r() * 0.035,
    ax: 26 + r() * 30, ph: r(),
  }));
  // sparkles round the champion's coin, each twinkling whole cycles per loop
  if (b.ring) {
    b.sparkles = [-0.95, -0.35, 0.35, 2.25, 2.85, 3.55].map((a, i) => ({
      a, rad: b.ring.d * (0.66 + 0.12 * r()), size: 4 + r() * 5, tw: 1 + (i % 3), ph: r(),
    }));
  }
  b.tmp = null;
  return b;
}

function itemState(it, u, nItems) {
  if (u < HOLD_END) return [1, 0, 1];
  if (u < EXIT_END) {
    const k = easeIn((u - HOLD_END) / (EXIT_END - HOLD_END));
    return [1 - k, 12 * k, 1];
  }
  const span = Math.max(0, 1 - ENTER_SLACK - EXIT_END - COUNT_DELAY - COUNT_DUR - ENTER_DUR);
  const step = Math.min(0.016, span / Math.max(1, nItems - 1));
  const start = EXIT_END + 0.004 + it.order * step;
  const e = easeOut((u - start) / ENTER_DUR);
  const p = clamp01((u - start - COUNT_DELAY) / COUNT_DUR);
  return [e, 22 * (1 - e), p];
}

function glintWindow(it, nItems) {
  if (it.order === 0) return [0.05, 0.19];
  const g = Math.min(0.05, (0.56 - 0.21 - 0.1) / Math.max(1, nItems - 2));
  const s = 0.21 + (it.order - 1) * g;
  return [s, s + 0.1];
}

// The camera breathes in and back out once per loop — the background less
// than the stage, the front bokeh more: parallax. At u = 0 every scale is
// exactly 1, so frame 0 is the still.
const camScale = (u, amp) => 1 + (amp * (1 - Math.cos(TAU * u))) / 2;
function camera(ctx, s) {
  const cx = W / 2;
  const cy = H * 0.56;
  ctx.translate(cx, cy);
  ctx.scale(s, s);
  ctx.translate(-cx, -cy);
}

// the champion lands at about this point of the loop: a ring of light bursts
const FLASH = [0.765, 0.86];

/** One frame at loop position u ∈ [0, 1). compose(b, ctx, 0) is the full board. */
function compose(b, ctx, u) {
  u = ((u % 1) + 1) % 1;
  const nItems = b.items.length;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
  // bilinear, not "high": the camera moves every sprite by under 3%, where a
  // high-quality resample is invisible and costs half the frame (measured:
  // 126ms → 62ms of rasterising per frame)
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "low";

  // ── the room (slow camera)
  ctx.save();
  camera(ctx, camScale(u, 0.012));
  ctx.drawImage(b.bg, 0, 0);
  drawBeams(ctx, u);
  drawAurora(ctx, u);
  ctx.save();
  ctx.scale(K, K);
  for (const k of b.bokehBack) {
    const x = k.x + k.ax * Math.sin(TAU * (u + k.ph));
    const y = k.y + 8 * Math.sin(TAU * (2 * u + k.ph));
    ctx.globalAlpha = k.a;
    ctx.drawImage(k.sprite, x - k.rad, y - k.rad, k.rad * 2, k.rad * 2);
  }
  ctx.restore();
  ctx.restore();
  ctx.globalAlpha = 1;

  // ── the header and footer stand still: the parallax is against them
  ctx.drawImage(b.chrome, 0, 0);

  // ── the stage (the camera's push)
  ctx.save();
  camera(ctx, camScale(u, 0.026));
  ctx.drawImage(b.back, 0, 0);

  // motes rising through the light, behind the cards; whole laps per loop
  const span = FLOOR - 120;
  for (const m of b.motes) {
    const y = 120 + ((((m.y - 120 - span * m.laps * u) % span) + span) % span);
    const x = m.x + m.sway * Math.sin(TAU * u * m.laps + m.ph);
    const a = m.a * (0.55 + 0.45 * Math.sin(TAU * u * m.tw + m.ph * 1.7));
    if (a <= 0.01) continue;
    ctx.globalAlpha = a;
    ctx.drawImage(m.sprite, x * K - m.sprite.width / 2, y * K - m.sprite.height / 2);
  }
  ctx.globalAlpha = 1;

  for (const it of b.items) {
    const [a, dy, p] = itemState(it, u, nItems);
    if (a <= 0.004) continue;
    const oy = Math.round(dy * K);
    ctx.globalAlpha = a;
    if (p >= 0.999) {
      ctx.drawImage(it.final, it.x, it.y + oy);
    } else {
      ctx.drawImage(it.body, it.x, it.y + oy);
      ctx.save();
      ctx.translate(it.x, it.y + oy);
      it.local(ctx);
      for (const lv of it.lives) lv(ctx, p);
      ctx.restore();
    }
    if (it.reflect) ctx.drawImage(it.reflect, it.x, Math.round(FLOOR * K) + 2 * K - oy);
  }
  ctx.globalAlpha = 1;

  ctx.save();
  ctx.scale(K, K);
  // a glint crosses each card in turn (hold only)
  for (const it of b.items) {
    const [g0, g1] = glintWindow(it, nItems);
    if (!(u >= g0 && u < g1 && u < HOLD_END)) continue;
    const [x0, y0, x1, y1] = it.box;
    const gp = easeInOut((u - g0) / (g1 - g0));
    const w = x1 - x0;
    const bw = Math.max(30, w * 0.18);
    const sk = (y1 - y0) * 0.35;
    const bx = x0 - bw - sk + (w + bw + sk) * gp;
    ctx.save();
    roundRect(ctx, x0, y0, w, y1 - y0, it.r);
    ctx.clip();
    ctx.beginPath();
    ctx.moveTo(bx + sk, y0);
    ctx.lineTo(bx + sk + bw, y0);
    ctx.lineTo(bx + bw, y1);
    ctx.lineTo(bx, y1);
    ctx.closePath();
    ctx.fillStyle = lin(ctx, bx, 0, bx + bw + sk, 0, [[0, "rgba(255,255,255,0)"], [0.5, `rgba(255,255,255,${it.hero ? 0.17 : 0.12})`], [1, "rgba(255,255,255,0)"]]);
    ctx.fill();
    ctx.restore();
  }

  // a light runs along every gain bar, one after another (hold only)
  for (const bar of b.bars) {
    const s0 = 0.1 + bar.order * 0.03;
    if (!(u >= s0 && u < s0 + 0.16) || bar.frac <= 0) continue;
    const q = easeInOut((u - s0) / 0.16);
    ctx.save();
    if (bar.kind === "h") {
      const xe = bar.x0 + (bar.x1 - bar.x0) * bar.frac;
      roundRect(ctx, bar.x0, bar.y - bar.h / 2, Math.max(xe - bar.x0, bar.h), bar.h, bar.h / 2);
      ctx.clip();
      const L = Math.max(40, (xe - bar.x0) * 0.35);
      const px = bar.x0 - L + (xe - bar.x0 + L) * q;
      ctx.fillStyle = lin(ctx, px, 0, px + L, 0, [[0, "rgba(255,255,255,0)"], [0.6, "rgba(255,255,255,0.75)"], [1, "rgba(255,255,255,0)"]]);
      ctx.fillRect(px, bar.y - bar.h, L, bar.h * 2);
    } else {
      const ye = bar.yb - (bar.yb - bar.yt) * bar.frac;
      roundRect(ctx, bar.cx - bar.w / 2, ye, bar.w, bar.yb - ye, bar.w / 2);
      ctx.clip();
      const L = Math.max(30, (bar.yb - ye) * 0.4);
      const py = bar.yb - (bar.yb - ye + L) * q;
      ctx.fillStyle = lin(ctx, 0, py + L, 0, py, [[0, "rgba(255,255,255,0)"], [0.6, "rgba(255,255,255,0.7)"], [1, "rgba(255,255,255,0)"]]);
      ctx.fillRect(bar.cx - bar.w, py, bar.w * 2, L);
    }
    ctx.restore();
  }

  // the champion: a light running round its frame, once per loop
  const hero = b.items.find((it) => it.hero);
  if (hero) {
    const [a, dy] = itemState(hero, u, nItems);
    if (a > 0.01) {
      const [x0, y0, x1, y1] = hero.box;
      const cx = (x0 + x1) / 2;
      const cy = (y0 + y1) / 2 + dy;
      const g = ctx.createConicGradient(-Math.PI / 2 + TAU * u, cx, cy);
      g.addColorStop(0, "rgba(255,255,255,0)");
      g.addColorStop(0.05, "rgba(220,255,245,0.95)");
      g.addColorStop(0.11, "rgba(61,245,159,0)");
      g.addColorStop(0.5, "rgba(34,211,238,0)");
      g.addColorStop(0.54, "rgba(160,235,255,0.6)");
      g.addColorStop(0.58, "rgba(34,211,238,0)");
      g.addColorStop(1, "rgba(255,255,255,0)");
      ctx.save();
      ctx.globalAlpha = a;
      roundRect(ctx, x0 + 1, y0 + 1 + dy, x1 - x0 - 2, y1 - y0 - 2, hero.r - 1);
      ctx.strokeStyle = g;
      ctx.lineWidth = 7;
      ctx.globalAlpha = a * 0.35;
      ctx.stroke();
      ctx.lineWidth = 2.4;
      ctx.globalAlpha = a;
      ctx.stroke();
      ctx.restore();
    }
  }
  ctx.restore();

  // the leader's orbit ring: two turns per loop; the crown rides over it
  const lead = b.items.find((it) => it.order === 0);
  if (lead && b.ring) {
    const [a, dy] = itemState(lead, u, nItems);
    if (a > 0.01) {
      if (b.ringSprite) {
        ctx.save();
        ctx.globalAlpha = a;
        ctx.translate(b.ring.cx * K, (b.ring.cy + dy) * K);
        ctx.rotate(-TAU * 2 * u);
        ctx.drawImage(b.ringSprite, -b.ringSprite.width / 2, -b.ringSprite.height / 2);
        ctx.restore();
      }
      if (b.crownSprite) {
        ctx.globalAlpha = a;
        ctx.drawImage(b.crownSprite.canvas, b.crownSprite.dx, b.crownSprite.dy + dy * K);
      }
      // sparkles twinkling round the coin
      for (const sp of b.sparkles || []) {
        const tw = 0.5 + 0.5 * Math.sin(TAU * (u * sp.tw + sp.ph));
        if (tw < 0.25) continue;
        const sx = (b.ring.cx + Math.cos(sp.a) * sp.rad) * K;
        const sy = (b.ring.cy + dy + Math.sin(sp.a) * sp.rad) * K;
        const r = sp.size * K * (0.55 + 0.45 * tw);
        ctx.save();
        ctx.globalAlpha = a * tw;
        ctx.fillStyle = "#FFFFFF";
        ctx.shadowColor = C.cyan;
        ctx.shadowBlur = r * 2.2;
        ctx.beginPath();
        for (let i = 0; i < 8; i++) {
          const ang = (Math.PI / 4) * i;
          const rad = i % 2 ? r * 0.22 : r;
          ctx[i ? "lineTo" : "moveTo"](sx + Math.cos(ang) * rad, sy + Math.sin(ang) * rad);
        }
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      }
      // the landing: a ring of light bursting off the coin
      if (u >= FLASH[0] && u < FLASH[1]) {
        const q = (u - FLASH[0]) / (FLASH[1] - FLASH[0]);
        const R = b.ring.d * (0.5 + 0.95 * easeOut(q)) * K;
        ctx.save();
        ctx.globalAlpha = (1 - q) ** 1.6;
        ctx.beginPath();
        ctx.arc(b.ring.cx * K, (b.ring.cy + dy) * K, R, 0, TAU);
        ctx.lineWidth = 3 * K * (1 - q) + 1;
        ctx.strokeStyle = "#D8FAFF";
        ctx.shadowColor = C.cyan;
        ctx.shadowBlur = 18 * K;
        ctx.stroke();
        const gl = ctx.createRadialGradient(b.ring.cx * K, (b.ring.cy + dy) * K, 0, b.ring.cx * K, (b.ring.cy + dy) * K, R);
        gl.addColorStop(0, rgba(C.cyan, 0.22 * (1 - q)));
        gl.addColorStop(1, rgba(C.cyan, 0));
        ctx.fillStyle = gl;
        ctx.fill();
        ctx.restore();
      }
      ctx.globalAlpha = 1;
    }
  }
  ctx.restore();

  // ── the front bokeh, closest to the lens: the most parallax
  ctx.save();
  camera(ctx, camScale(u, 0.045));
  ctx.scale(K, K);
  for (const k of b.bokehFront) {
    const x = k.x + k.ax * Math.sin(TAU * (u + k.ph));
    ctx.globalAlpha = k.a;
    ctx.drawImage(k.sprite, x - k.rad, k.y - k.rad, k.rad * 2, k.rad * 2);
  }
  ctx.restore();
  ctx.globalAlpha = 1;

  // the headline shine, once per loop
  if (b.title && u >= 0.3 && u < 0.44) {
    const t = b.title;
    if (!b.tmp) b.tmp = b.cv.createCanvas(t.canvas.width, t.canvas.height);
    const tx = b.tmp.getContext("2d");
    tx.setTransform(1, 0, 0, 1, 0, 0);
    tx.globalCompositeOperation = "source-over";
    tx.clearRect(0, 0, b.tmp.width, b.tmp.height);
    const gp = easeInOut((u - 0.3) / 0.14);
    const bw = t.canvas.height * 1.1;
    const bx = -bw * 1.5 + (t.canvas.width + bw * 2) * gp;
    tx.beginPath();
    tx.moveTo(bx + bw * 0.6, 0);
    tx.lineTo(bx + bw * 1.2, 0);
    tx.lineTo(bx + bw * 0.6, t.canvas.height);
    tx.lineTo(bx, t.canvas.height);
    tx.closePath();
    tx.fillStyle = lin(tx, bx, 0, bx + bw * 1.2, 0, [[0, "rgba(255,255,255,0)"], [0.5, "rgba(255,255,255,0.8)"], [1, "rgba(255,255,255,0)"]]);
    tx.fill();
    tx.globalCompositeOperation = "destination-in";
    tx.drawImage(t.canvas, 0, 0);
    ctx.drawImage(b.tmp, t.x, t.y);
  }

  // the LIVE dot breathes: three pulses per loop
  if (b.liveDot) {
    const ph = (u * 3) % 1;
    ctx.save();
    ctx.scale(K, K);
    ctx.beginPath();
    ctx.arc(b.liveDot.x, b.liveDot.y, 3.5 + 9 * ph, 0, TAU);
    ctx.lineWidth = 0.9;
    ctx.strokeStyle = rgba(C.mint, 0.6 * (1 - ph));
    ctx.stroke();
    ctx.restore();
  }

  ctx.drawImage(b.vig, 0, 0);
}

// ── render ──────────────────────────────────────────────────────────────────
/** The coins as this family draws them: copies (never the caller's), the
 *  hidden figures removed, logos decoded. */
async function prepare(cv, template, coins, { showMcap = true, showPrice = true } = {}) {
  const n = countOf(template);
  const list = (coins || []).filter(Boolean).slice(0, n).map((c) => ({
    ...c,
    ...(showMcap === false ? { mcap: null } : {}),
    ...(showPrice === false ? { price: null } : {}),
  }));
  await Promise.all(list.map(async (c) => {
    c.img = null;
    if (!c.logo) return;
    try {
      c.img = await cv.loadImage(c.logo);
    } catch {
      c.img = null; // bytes that are not an image → the monogram
    }
  }));
  for (const c of list) warnBoxes("gainers-motion", { symbol: c.symbol, name: c.name });
  return list;
}

async function board(cv, opts) {
  const n = countOf(opts.template);
  if (!n) return null;
  const list = await prepare(cv, opts.template, opts.coins, opts);
  if (!list.length) return null; // nothing real to show → the caller posts nothing
  return build(cv, n, list, opts);
}

/** The board at rest — frame 0 of the clip — as a PNG. Never throws. */
async function renderStill(opts = {}) {
  const cv = kit.canvasLib();
  if (!cv || !isTemplate(opts.template)) return null;
  try {
    const b = await board(cv, opts);
    if (!b) return null;
    const out = cv.createCanvas(W, H);
    compose(b, out.getContext("2d"), 0);
    return toSendBuffer(out);
  } catch (e) {
    log.warn(`[gainersMotion] still ${opts.template} failed: ${e.message}`);
    return null;
  }
}

/** Draw the loop, frame by frame, handing each to onFrame(rgba). `times`
 *  (loop fractions) is a test seam. */
async function drawFrames(opts = {}, { count = FRAMES, times = null, onFrame, cancel = null } = {}) {
  const cv = kit.canvasLib();
  if (!cv) return false;
  const b = await board(cv, opts);
  if (!b) return false;
  const out = cv.createCanvas(W, H);
  const ctx = out.getContext("2d");
  const n = times ? times.length : count;
  for (let f = 0; f < n; f++) {
    if (cancel && cancel.cancelled) throw new Error("cancelled — the caller stopped waiting");
    compose(b, ctx, times ? times[f] : f / count);
    // ⚠️ canvas.data() is a LIVE VIEW of the pixels: the frame must be in the
    // pipe before the next one is drawn into the same memory.
    if (onFrame) await onFrame(out.data(), f);
    await new Promise((r) => setImmediate(r));
  }
  return true;
}

function ffmpegPath() {
  try {
    return require("@ffmpeg-installer/ffmpeg").path;
  } catch {
    return null;
  }
}

function encoder(outPath) {
  const bin = ffmpegPath();
  if (!bin) throw new Error("ffmpeg unavailable");
  const args = [
    "-y", "-loglevel", "error",
    "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${W}x${H}`, "-r", String(FPS), "-i", "pipe:0",
    "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p",
    "-movflags", "+faststart", "-an",
    outPath,
  ];
  const p = spawn(bin, args, { stdio: ["pipe", "ignore", "pipe"] });
  let err = "";
  let failed = null;
  p.stderr.on("data", (d) => (err += d));
  const done = new Promise((resolve, reject) => {
    p.on("error", (e) => { failed = e; reject(e); });
    p.on("close", (code) => (code === 0 ? resolve(outPath) : reject(new Error(err.trim() || `ffmpeg exited ${code}`))));
  });
  done.catch(() => {});
  p.stdin.on("error", (e) => (failed = failed || e));
  return {
    write(frame) {
      if (failed) return Promise.reject(failed);
      return new Promise((resolve, reject) => p.stdin.write(frame, (e) => (e ? reject(failed || e) : resolve())));
    },
    end() { p.stdin.end(); return done; },
    kill() { try { p.kill("SIGKILL"); } catch { /* already gone */ } },
  };
}

const TMP_PREFIX = "bt-out-gm-";
const TMP_MAX_AGE_MS = 10 * 60_000;
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

/** The looping clip → { type: "animation", source: <mp4 path> }, or null. */
async function render(opts = {}, { outPath = null, cancel = null, count = FRAMES } = {}) {
  const t0 = Date.now();
  let file = null;
  try {
    if (!kit.canvasLib()) return null;
    if (!isTemplate(opts.template)) return null;
    if (!outPath) sweepTmp().catch(() => {});
    file = outPath || path.join(os.tmpdir(), `${TMP_PREFIX}${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}.mp4`);
    const enc = encoder(file);
    let ok = false;
    try {
      ok = await drawFrames(opts, { count, cancel, onFrame: (fr) => enc.write(fr) });
    } catch (e) {
      enc.kill();
      throw e;
    }
    if (!ok) {
      enc.kill();
      fss.promises.unlink(file).catch(() => {});
      return null;
    }
    await enc.end();
    const st = fss.statSync(file);
    log.info(`[gainersMotion] ${opts.template} rendered in ${Date.now() - t0}ms (${Math.round(st.size / 1024)} KB)`);
    return { type: "animation", source: file };
  } catch (e) {
    log.warn(`[gainersMotion] ${opts.template} render failed after ${Date.now() - t0}ms: ${e.message}`);
    if (file) fss.promises.unlink(file).catch(() => {}); // a half-written clip is never handed on
    return null;
  }
}

module.exports = {
  W,
  H,
  FPS,
  SECONDS,
  FRAMES,
  TEMPLATE_IDS,
  NAMES,
  LAYOUTS,
  isTemplate,
  countOf,
  labelOf,
  render,
  renderStill,
  drawFrames,
  available: () => !!kit.canvasLib(),
  _compose: compose,
  _build: build,
  _clipTo: clipTo,
  _itemState: itemState,
  TMP_PREFIX,
};
