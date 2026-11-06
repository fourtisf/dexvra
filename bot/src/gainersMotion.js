"use strict";
// Dexvra MOTION — the 🎬 Top-Gainers family m1..m10 (2026-11).
//
// "bisakah anda buat banner vidio seperti fourtis banner premium model dexvra"
// asked for the KIND of product the Fourtis panel has — a looping video board
// per count — and "mksud saya tampilan design harus beda masa sama persis kaya
// fourtis" is what it has to look like: NOT Fourtis. The first cut copied the
// Fourtis board almost line for line (its ten layouts, the stage and mirrored
// floor, spotlights, the orbit ring, comet bars, the centred kicker / title /
// date and the two-tagline footer) and changed only the colour. Nothing of
// that structure is left. This is built from DEXVRA's own surfaces:
//
//   - the room is a cut gem: a low-poly facet field in deep blue, a light
//     sliding across it and catching the facet edges;
//   - a TERMINAL top bar (the site's): brand lockup left, the title centre,
//     LIVE and the date right — and the site's "Top Movers" ticker tape
//     scrolling along the bottom;
//   - gem-cut plates (two corners cut deep, two shallow) instead of cards,
//     logos set in hexagons, the site's terminal TABLE for the ranked lists,
//     LED segment bars for the strength of each move;
//   - the site's type: Sora for figures, Space Grotesk for names, JetBrains
//     Mono for every label and column.
//
// The loop, and FRAME 0 IS THE FULL BOARD (the thumbnail before autoplay, and
// the still that goes to X):
//
//     hold   0.00 – 0.60  the board; the light slides over the facets, the
//                         tape scrolls, a pulse runs down each LED bar, a
//                         glint crosses the leader's plate, the title shines
//     off    0.60 – 0.68  the plates switch off like a terminal — each folds
//                         to a bright line and is gone, the last rank first
//     on     0.70 – 1.00  they switch back on, the leader first, and every
//                         figure DECODES into place; the bars light segment by
//                         segment — ending exactly on frame 0
//
// Every ambient motion runs whole cycles per loop, so the loop has no seam.
// Data is real or absent: a price, a cap or a change the feed did not carry is
// LEFT OUT, never drawn as "$0", "—" or "0.0%".
//
// ⚠️ THIS FAMILY ONCE EXISTED AND WAS REMOVED ("hapus top gainer yang vidio",
// 2026-10-03). It comes back BESIDE the premium stills, never instead of them,
// with an id space of its own (m1..m10): the removed boards were v1..v10, and a
// config still naming one must not wake up posting a video nobody chose.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
const { spawn } = require("node:child_process");
const log = require("./helpers/logger");
const kit = require("./helpers/canvasKit");
const { toSendBuffer } = require("./helpers/encodeImage");
const { fmtPct, fmtPrice, fmtCap, ticker } = require("./helpers/format");

const { F, drawBrandMark, drawLogoDisc, warnBoxes } = kit;

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

// THE DEXVRA BRAND: the gem's mint → cyan, deep blue, the site's red.
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

// Zones, design units.
const SX0 = 56;
const SX1 = 1224;
const SY0 = 140;
const SY1 = 644;
const BAR_Y = 112; // the hairline under the top bar
const TAPE_Y = 668; // the ticker tape runs from here to the bottom edge
const TAPE_L = 196; // the left chip ends here
const TAPE_R = 1090; // the right chip starts here
const PAD = 26; // room round a plate in its sprite, for its glow and shadow
// The smallest drawn string, in design units (15px at 1920 wide): X autoplays
// a ~640px variant, so a label under this is a smear on a phone.
const LABEL_MIN = 10;

// The timeline, as fractions of one loop.
const HOLD_END = 0.6;
const OFF_END = 0.68;
const OFF_DUR = 0.035;
const ON0 = 0.7;
const ON_DUR = 0.06;
const COUNT_DELAY = 0.025;
const COUNT_DUR = 0.14;
const ENTER_SLACK = 0.02;

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
const hash2 = (a, b) => {
  let h = (a * 374761393 + b * 668265263) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
};

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
const fx = (s) => `800 ${s}px ${F.x}`; // Sora 800 — titles, tickers, figures
const fx7 = (s) => `700 ${s}px ${F.b}`; // Sora 700
const fname = (s) => `500 ${Math.max(LABEL_MIN, s)}px ${F.d5}`; // Space Grotesk 500 — names, dates
const fword = (s) => `700 ${s}px ${F.d7}`; // Space Grotesk 700 — the wordmark
const fcap = (s) => `700 ${Math.max(LABEL_MIN, s)}px ${F.m7}`; // JetBrains Mono 700 — labels
const fmono = (s) => `600 ${Math.max(LABEL_MIN, s)}px ${F.m6}`; // JetBrains Mono 600 — figures in a table
const fnum = (s) => `800 ${Math.max(LABEL_MIN, s)}px ${F.m8}`; // JetBrains Mono 800 — rank numerals

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

/** Shrink `text` from `size` toward `floor` until it fits, then cut. */
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
const pctOf = (c) => numOrNull(c && c.pct);

/** How full a bar is: the gain against the leader of its group (`min` keeps a
 *  real but tiny gain visible). */
function barFrac(c, top, min = 0.04) {
  const v = pctOf(c);
  if (v === null) return 0;
  return v > 0 ? Math.max(min, Math.min(1, v / top)) : min;
}
function topVal(coins) {
  const vals = coins.map(pctOf).filter((v) => v !== null && v > 0);
  return vals.length ? Math.max(...vals) : 1;
}

/** A figure as it reads while it DECODES: the digits not yet locked are
 *  noise; p = 1 is the real string. */
function decode(final, p, salt) {
  if (p >= 1) return final;
  const chars = [...final];
  const fixed = Math.floor(chars.length * easeOut(p));
  return chars.map((ch, i) => (i < fixed || !/[0-9]/.test(ch) ? ch : String(hash2(i + 1, salt) % 10))).join("");
}

// ── geometry ────────────────────────────────────────────────────────────────
/** A quadrilateral [tl, tr, br, bl] with its corners cut — deep on the top-left
 *  and bottom-right, shallow on the other two: a gem's cut, not a card. */
function gemPath(ctx, P, deep, shallow = deep * 0.35) {
  ctx.beginPath();
  for (let i = 0; i < 4; i++) {
    const a = P[(i + 3) % 4];
    const b = P[i];
    const d = P[(i + 1) % 4];
    const cut = i % 2 === 0 ? deep : shallow;
    const n1 = Math.hypot(a[0] - b[0], a[1] - b[1]) || 1;
    const n2 = Math.hypot(d[0] - b[0], d[1] - b[1]) || 1;
    const p1 = [b[0] + ((a[0] - b[0]) / n1) * cut, b[1] + ((a[1] - b[1]) / n1) * cut];
    const p2 = [b[0] + ((d[0] - b[0]) / n2) * cut, b[1] + ((d[1] - b[1]) / n2) * cut];
    if (i) ctx.lineTo(...p1);
    else ctx.moveTo(...p1);
    ctx.lineTo(...p2);
  }
  ctx.closePath();
}
const rectQuad = ([x0, y0, x1, y1]) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
const quadBox = (P) => [
  Math.min(...P.map((p) => p[0])), Math.min(...P.map((p) => p[1])),
  Math.max(...P.map((p) => p[0])), Math.max(...P.map((p) => p[1])),
];
function inset(P, d) {
  const cx = P.reduce((a, p) => a + p[0], 0) / 4;
  const cy = P.reduce((a, p) => a + p[1], 0) / 4;
  return P.map(([x, y]) => {
    const dx = cx - x;
    const dy = cy - y;
    const n = Math.hypot(dx, dy) || 1;
    return [x + (dx / n) * d * 1.3, y + (dy / n) * d];
  });
}

function hexPath(ctx, cx, cy, R) {
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const a = -Math.PI / 2 + (i * TAU) / 6;
    const x = cx + R * Math.cos(a);
    const y = cy + R * Math.sin(a);
    if (i) ctx.lineTo(x, y);
    else ctx.moveTo(x, y);
  }
  ctx.closePath();
}

// ── the board ───────────────────────────────────────────────────────────────
class Board {
  constructor(cv, n, coins, { showPct = true } = {}) {
    this.cv = cv;
    this.n = n;
    this.coins = coins;
    this.showPct = showPct !== false;
    this.items = [];
    this.bars = [];
    this.cur = null;
    this.liveDot = null;
    this.title = null;
  }

  hasPct(c) {
    return this.showPct && pctOf(c) !== null;
  }

  /** The gain, decoding while p < 1, with a small arrow ahead of it. */
  gain(ctx, c, x, y, size, align, p = 1, salt = 0, glow = false) {
    const v = pctOf(c);
    if (!this.showPct || v === null) return;
    const s = decode(fmtPct(v), p, salt);
    const up = v >= 0;
    ctx.save();
    ctx.font = fx(size);
    ctx.textBaseline = "middle";
    const tw = ctx.measureText(fmtPct(v)).width;
    const aw = size * 0.42;
    const gap = size * 0.18;
    const x0 = align === "right" ? x - tw - aw - gap : align === "center" ? x - (tw + aw + gap) / 2 : x;
    ctx.fillStyle = up ? C.mint : C.red;
    ctx.beginPath(); // the arrow
    const ay = y;
    if (up) {
      ctx.moveTo(x0, ay + aw * 0.42);
      ctx.lineTo(x0 + aw / 2, ay - aw * 0.48);
      ctx.lineTo(x0 + aw, ay + aw * 0.42);
    } else {
      ctx.moveTo(x0, ay - aw * 0.42);
      ctx.lineTo(x0 + aw / 2, ay + aw * 0.48);
      ctx.lineTo(x0 + aw, ay - aw * 0.42);
    }
    ctx.closePath();
    ctx.fill();
    ctx.textAlign = "left";
    ctx.fillStyle = up ? lin(ctx, 0, y - size / 2, 0, y + size / 2, [[0, "#C9FFE6"], [0.5, C.mint], [1, "#19C79A"]]) : C.red;
    if (glow) {
      ctx.shadowColor = rgba(up ? C.mint : C.red, 0.5);
      ctx.shadowBlur = size * 0.4 * K;
    }
    ctx.fillText(s, x0 + aw + gap, y);
    ctx.restore();
  }

  gainW(ctx, c, size) {
    const v = pctOf(c);
    if (!this.showPct || v === null) return 0;
    ctx.font = fx(size);
    return ctx.measureText(fmtPct(v)).width + size * 0.6;
  }

  sym(ctx, c, x, y, size, align, maxW, floor = 12) {
    ctx.save();
    const r = fit(ctx, tickerOf(c), maxW || 9999, fx, size, Math.min(size, floor));
    ctx.textAlign = align;
    ctx.textBaseline = "middle";
    ctx.fillStyle = C.ink;
    ctx.fillText(r.text, x, y);
    const w = ctx.measureText(r.text).width;
    ctx.restore();
    return w;
  }

  nm(ctx, c, x, y, size, align, maxW) {
    if (!hasName(c)) return;
    ctx.save();
    ctx.font = fname(size);
    ctx.textAlign = align;
    ctx.textBaseline = "middle";
    ctx.fillStyle = C.dim;
    ctx.fillText(clipTo(ctx, String(c.name).trim(), maxW || 9999), x, y);
    ctx.restore();
  }

  /** A gem-cut plate. The leader's edge is the gem's own mint → cyan. */
  plate(ctx, P, { lead = false, deep = 22 } = {}) {
    const [x0, y0, x1, y1] = quadBox(P);
    ctx.save();
    gemPath(ctx, P, deep);
    ctx.fillStyle = "rgba(2,6,14,1)";
    ctx.shadowColor = "rgba(0,0,0,0.75)";
    ctx.shadowBlur = 26 * K;
    ctx.shadowOffsetY = 12 * K;
    ctx.fill();
    if (lead) {
      ctx.shadowColor = rgba(C.mint, 0.32);
      ctx.shadowBlur = 36 * K;
      ctx.shadowOffsetY = 0;
      ctx.fill();
    }
    ctx.restore();

    ctx.save();
    gemPath(ctx, P, deep);
    ctx.clip();
    ctx.fillStyle = lin(ctx, 0, y0, 0, y1, lead
      ? [[0, "#103A4C"], [0.5, "#0A2436"], [1, "#061522"]]
      : [[0, "#13233C"], [1, "#081222"]]);
    ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
    // the table facet: a lighter cut along the top
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y0);
    ctx.lineTo(x1 - (x1 - x0) * 0.08, y0 + Math.min(46, (y1 - y0) * 0.18));
    ctx.lineTo(x0 + (x1 - x0) * 0.08, y0 + Math.min(46, (y1 - y0) * 0.18));
    ctx.closePath();
    ctx.fillStyle = `rgba(255,255,255,${lead ? 0.06 : 0.04})`;
    ctx.fill();
    // a crown facet across the top-left
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x0 + Math.min(260, (x1 - x0) * 0.42), y0);
    ctx.lineTo(x0, y0 + Math.min(220, (y1 - y0) * 0.8));
    ctx.closePath();
    ctx.fillStyle = lin(ctx, x0, y0, x0 + 160, y0 + 120, [[0, "rgba(255,255,255,0.07)"], [1, "rgba(255,255,255,0)"]]);
    ctx.fill();
    ctx.restore();

    ctx.save();
    // the bevel: an inner cut, lit from the top-left
    gemPath(ctx, inset(P, 5), Math.max(4, deep - 5));
    ctx.lineWidth = 1;
    ctx.strokeStyle = lin(ctx, x0, y0, x1, y1, [[0, "rgba(255,255,255,0.14)"], [0.5, "rgba(255,255,255,0.03)"], [1, "rgba(0,0,0,0.25)"]]);
    ctx.stroke();
    gemPath(ctx, P, deep);
    ctx.lineWidth = lead ? 2 : 1.2;
    ctx.strokeStyle = lead
      ? lin(ctx, x0, y0, x1, y1, [[0, C.mint], [0.5, C.cyan], [1, C.blue]])
      : lin(ctx, x0, y0, x1, y1, [[0, "rgba(170,225,255,0.45)"], [0.5, "rgba(120,180,240,0.16)"], [1, "rgba(170,225,255,0.3)"]]);
    ctx.stroke();
    ctx.restore();
  }

  /** The logo set in a hexagon, the hexagon in a bevelled metal frame. */
  hexLogo(ctx, c, cx, cy, R, lead = false) {
    const Ri = R * 0.84;
    ctx.save();
    hexPath(ctx, cx, cy, R);
    ctx.fillStyle = "#050C18";
    ctx.shadowColor = lead ? rgba(C.mint, 0.55) : "rgba(0,0,0,0.6)";
    ctx.shadowBlur = R * (lead ? 0.5 : 0.25) * K;
    ctx.fill();
    ctx.restore();
    ctx.save();
    hexPath(ctx, cx, cy, R);
    ctx.fillStyle = lin(ctx, cx - R, cy - R, cx + R, cy + R, lead
      ? [[0, "#E9FFF6"], [0.35, C.mint], [0.7, C.cyan], [1, C.deep]]
      : [[0, "#F1F8FF"], [0.4, "#8FA6BC"], [0.7, "#D9E6F1"], [1, "#3E5268"]]);
    ctx.fill();
    hexPath(ctx, cx, cy, Ri);
    ctx.clip();
    if (c.img) {
      drawLogoDisc(ctx, c.img, cx, cy, Ri, { backdrop: "#0B1424" });
    } else {
      ctx.fillStyle = lin(ctx, cx, cy - Ri, cx, cy + Ri, [[0, "#173B5E"], [1, "#07152A"]]);
      ctx.fillRect(cx - Ri, cy - Ri, Ri * 2, Ri * 2);
      const ini = [...String(c.symbol || "?").replace(/^\$+/, "")].slice(0, 2).join("").toUpperCase() || "?";
      ctx.font = fx(Ri * 0.72);
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = lin(ctx, cx - Ri, cy - Ri, cx + Ri, cy + Ri, [[0, C.mint], [1, C.cyan]]);
      ctx.fillText(ini, cx, cy + Ri * 0.05);
    }
    // a facet of light over the upper half
    ctx.beginPath();
    ctx.moveTo(cx - Ri, cy - Ri);
    ctx.lineTo(cx + Ri, cy - Ri);
    ctx.lineTo(cx + Ri, cy - Ri * 0.15);
    ctx.lineTo(cx - Ri, cy + Ri * 0.2);
    ctx.closePath();
    ctx.fillStyle = "rgba(255,255,255,0.12)";
    ctx.fill();
    ctx.restore();
    ctx.save();
    hexPath(ctx, cx, cy, Ri);
    ctx.lineWidth = Math.max(0.8, R * 0.025);
    ctx.strokeStyle = "rgba(3,10,22,0.8)";
    ctx.stroke();
    ctx.restore();
  }

  /** The rank as a slanted tag: the leader's is solid mint. Returns its width. */
  tag(ctx, x, y, rank, size = 12, lead = false) {
    const s = String(rank).padStart(2, "0");
    ctx.save();
    ctx.font = fnum(size);
    const tw = ctx.measureText(s).width;
    const h = size * 1.7;
    const sl = h * 0.35;
    const w = tw + size * 1.2 + sl;
    ctx.beginPath();
    ctx.moveTo(x + sl, y - h / 2);
    ctx.lineTo(x + w, y - h / 2);
    ctx.lineTo(x + w - sl, y + h / 2);
    ctx.lineTo(x, y + h / 2);
    ctx.closePath();
    if (lead) {
      ctx.fillStyle = lin(ctx, x, 0, x + w, 0, [[0, C.mint], [1, C.cyan]]);
      ctx.fill();
    } else {
      ctx.fillStyle = "rgba(255,255,255,0.06)";
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = rgba(C.cyan, rank <= 3 ? 0.65 : 0.35);
      ctx.stroke();
    }
    ctx.fillStyle = lead ? "#04121A" : rank <= 3 ? C.ice : C.dim;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(s, x + w / 2, y + size * 0.04);
    ctx.restore();
    return w;
  }

  /** LED segments: as many lit as the move is strong against the leader. */
  led(ctx, x0, x1, y, h, c, top, p = 1, segs = 24) {
    if (!this.showPct) return; // the bar is the % drawn as a length
    const v = pctOf(c);
    const gap = Math.max(1.5, h * 0.35);
    const sw = (x1 - x0 - gap * (segs - 1)) / segs;
    const lit = v === null ? 0 : Math.max(1, Math.round(barFrac(c, top) * segs));
    const on = Math.round(lit * easeOut(p));
    const up = v === null || v >= 0;
    ctx.save();
    for (let i = 0; i < segs; i++) {
      const x = x0 + i * (sw + gap);
      if (i < on) {
        const t = i / Math.max(1, segs - 1);
        ctx.fillStyle = up ? (t < 0.4 ? C.blue : t < 0.75 ? C.cyan : C.mint) : C.red;
        if (i === on - 1) {
          ctx.shadowColor = rgba(up ? C.mint : C.red, 0.85);
          ctx.shadowBlur = h * 2 * K;
        }
      } else {
        ctx.fillStyle = "rgba(255,255,255,0.07)";
      }
      ctx.fillRect(x, y - h / 2, sw, h);
      ctx.shadowBlur = 0;
    }
    ctx.restore();
    return { lit, segs, sw, gap };
  }

  /** The label above, the value under it — a terminal's readout. Skipped for
   *  a value the feed did not carry. */
  cells(ctx, x0, x1, y, list, size = 20) {
    const live = list.filter(([, v]) => v);
    if (!live.length) return;
    const cw = (x1 - x0) / live.length;
    live.forEach(([k, v], j) => {
      const mx = x0 + cw * j + 18;
      if (j) {
        ctx.beginPath();
        ctx.moveTo(x0 + cw * j, y - size * 0.95);
        ctx.lineTo(x0 + cw * j, y + size * 0.95);
        ctx.lineWidth = 0.8;
        ctx.strokeStyle = "rgba(160,220,255,0.18)";
        ctx.stroke();
      }
      caps(ctx, mx, y - size * 0.55, k, 10, C.faint);
      ctx.font = fmono(size);
      ctx.fillStyle = C.ink;
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(clipTo(ctx, v, cw - 30), mx, y + size * 0.45);
    });
  }

  /** Rows of (height, fn(y)) drawn top-down as one block centred on cy. */
  stack(cy, rows) {
    let y = cy - rows.reduce((a, [h]) => a + h, 0) / 2;
    for (const [h, fn] of rows) {
      fn(y + h / 2);
      y += h;
    }
  }

  /** One element into its own sprite: build() draws the static parts and
   *  returns the LIVE ones (decoding figures, lighting bars) as fn(ctx, p, salt). */
  item(P, order, build, { lead = false, plate = true, deep = 22 } = {}) {
    const box = quadBox(P);
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
    if (plate) this.plate(bx, P, { lead, deep });
    this.cur = { order };
    const lives = build(bx) || [];
    this.cur = null;
    const final = this.cv.createCanvas(sw, sh);
    const fc = final.getContext("2d");
    fc.drawImage(body, 0, 0);
    local(fc);
    for (const lv of lives) lv(fc, 1, 0);
    this.items.push({ P, box, order, lead, plate, deep, lives, body, final, local, x: Math.round((x0 - PAD) * K), y: Math.round((y0 - PAD) * K) });
  }
}

// ── plate contents ──────────────────────────────────────────────────────────
const at = (coins, i) => (i < coins.length && coins[i] ? coins[i] : null);
const statsOf = (c) => [
  ["PRICE", pos(c.price) ? fmtPrice(c.price) : null],
  ["MARKET CAP", pos(c.mcap) ? fmtCap(c.mcap) : null],
  ["LIQUIDITY", pos(c.liq) ? fmtCap(c.liq) : null],
];

/** Register a bar, for the pulse that runs down it in the hold. */
function regBar(b, x0, x1, y, h, c, top, segs = 24) {
  if (!b.hasPct(c)) return;
  const lit = Math.max(1, Math.round(barFrac(c, top) * segs));
  b.bars.push({ x0, x1, y, h, segs, lit, order: b.cur.order, up: pctOf(c) >= 0 });
}

/** m1: the one token, large: hexagon left, the figures right, a readout
 *  strip along the bottom of the plate. */
function solo(b, ctx, P, c) {
  const [x0, y0, x1, y1] = quadBox(P);
  const lives = [];
  const stats = statsOf(c);
  const hasStats = stats.some(([, v]) => v);
  const split = hasStats ? y1 - 96 : y1;
  const R = Math.min(128, (split - y0) * 0.36);
  const hx = x0 + 70 + R;
  const hy = (y0 + split) / 2;
  b.hexLogo(ctx, c, hx, hy, R, true);
  const tx = hx + R + 56;
  const right = x1 - 56;
  const tw = b.tag(ctx, tx, y0 + 64, 1, 13, true);
  caps(ctx, tx + tw + 14, y0 + 64, "TOP GAINER OF THE DAY", 12, C.mint);
  b.sym(ctx, c, tx, y0 + 140, 66, "left", right - tx, 26);
  if (hasName(c)) b.nm(ctx, c, tx + 2, y0 + 192, 22, "left", right - tx);
  if (b.hasPct(c)) {
    lives.push((cc, p, salt) => b.gain(cc, c, tx, y0 + 270, 80, "left", p, salt, true));
    lives.push((cc, p) => b.led(cc, tx, right, y0 + 330, 10, c, pctOf(c) || 1, p, 32));
    regBar(b, tx, right, y0 + 330, 10, c, pctOf(c) || 1, 32);
  }
  if (hasStats) {
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(x0 + 30, split);
    ctx.lineTo(x1 - 30, split);
    ctx.lineWidth = 1;
    ctx.strokeStyle = lin(ctx, x0, 0, x1, 0, [[0, "rgba(160,220,255,0)"], [0.5, "rgba(160,220,255,0.3)"], [1, "rgba(160,220,255,0)"]]);
    ctx.stroke();
    ctx.restore();
    b.cells(ctx, x0 + 40, x1 - 40, split + 48, stats, 24);
  }
  return lives;
}

/** Standing plate: the hexagon on top; ticker, name, gain and bar stacked
 *  under it; the market line along the bottom. Everything is measured first
 *  and the hexagon takes what is left, so nothing ever lands on anything. */
function upright(b, ctx, P, c, rank, top) {
  const [x0, y0, x1, y1] = quadBox(P);
  const w = x1 - x0;
  const lead = rank === 1;
  const lives = [];
  const cx = (x0 + x1) / 2;
  const tw = b.tag(ctx, x0 + 30, y0 + 34, rank, 13, lead);
  if (lead) caps(ctx, x0 + 30 + tw + 12, y0 + 34, "TOP GAINER", 11, C.mint);
  const stats = statsOf(c).slice(0, 2);
  const hasStats = stats.some(([, v]) => v);
  const areaTop = y0 + 62;
  const areaBot = hasStats ? y1 - 88 : y1 - 30;
  const symSz = Math.min(50, w * 0.09);
  const gSz = Math.min(54, w * 0.095);
  const rows = [];
  rows.push([symSz * 1.2, (y) => b.sym(ctx, c, cx, y, symSz, "center", w - 80)]);
  if (hasName(c)) rows.push([28, (y) => b.nm(ctx, c, cx, y, 17, "center", w - 80)]);
  if (b.hasPct(c)) {
    rows.push([gSz * 1.35, (y) => lives.push((cc, p, salt) => b.gain(cc, c, cx, y, gSz, "center", p, salt, lead))]);
    rows.push([26, (y) => {
      const bx0 = x0 + 56;
      const bx1 = x1 - 56;
      lives.push((cc, p) => b.led(cc, bx0, bx1, y, 8, c, top, p));
      regBar(b, bx0, bx1, y, 8, c, top);
    }]);
  }
  const textH = rows.reduce((a2, [h]) => a2 + h, 0);
  const R = Math.max(30, Math.min(88, w * 0.16, (areaBot - areaTop - textH - 26) / 2));
  const blockH = R * 2 + 26 + textH;
  let y = areaTop + Math.max(0, (areaBot - areaTop - blockH) / 2);
  b.hexLogo(ctx, c, cx, y + R, R, lead);
  y += R * 2 + 26;
  for (const [h, fn] of rows) {
    fn(y + h / 2);
    y += h;
  }
  if (hasStats) b.cells(ctx, x0 + 30, x1 - 30, y1 - 46, stats, 18);
  return lives;
}

/** Lying plate: the hexagon on the left and the text beside it. Wide enough,
 *  the gain stands on the right; too narrow for that, it goes under the
 *  ticker — never on top of the logo. The bar runs along the bottom. */
function wide(b, ctx, P, c, rank, top, { big = true } = {}) {
  const [x0, y0, x1, y1] = quadBox(P);
  const w = x1 - x0;
  const h = y1 - y0;
  const lead = rank === 1;
  const lives = [];
  const barY = y1 - Math.max(20, h * 0.12);
  const midY = (y0 + barY) / 2 + 2;
  const R = Math.min(h * 0.29, 74, w * 0.12);
  const hx = x0 + 30 + R;
  b.hexLogo(ctx, c, hx, midY, R, lead);
  const right = x1 - 30;
  const tx = hx + R + 24;
  const gBig = big ? Math.min(54, h * 0.24) : Math.min(32, h * 0.2);
  const gw = b.gainW(ctx, c, gBig);
  const side = gw && right - tx - gw - 26 >= Math.max(170, w * 0.26);
  const room = side ? right - tx - gw - 26 : right - tx;
  const symSz = Math.min(lead ? 46 : 38, h * 0.2);
  const rows = [[24, (y) => {
    const tw = b.tag(ctx, tx, y, rank, 11, lead);
    if (lead) caps(ctx, tx + tw + 10, y, "TOP GAINER", 10, C.mint);
  }], [symSz * 1.18, (y) => b.sym(ctx, c, tx, y, symSz, "left", room)]];
  if (hasName(c) && h > (side ? 130 : 200)) rows.push([Math.max(12, symSz * 0.34) * 1.7, (y) => b.nm(ctx, c, tx + 1, y, Math.max(12, symSz * 0.34), "left", room)]);
  if (gw && side) lives.push((cc, p, salt) => b.gain(cc, c, right, midY + 4, gBig, "right", p, salt, lead));
  if (gw && !side) {
    const gS = Math.min(gBig, h * 0.19, 40);
    rows.push([gS * 1.3, (y) => lives.push((cc, p, salt) => b.gain(cc, c, tx, y, gS, "left", p, salt, lead))]);
  }
  b.stack(midY, rows);
  if (b.hasPct(c)) {
    lives.push((cc, p) => b.led(cc, x0 + 28, x1 - 28, barY, 6, c, top, p, 36));
    regBar(b, x0 + 28, x1 - 28, barY, 6, c, top, 36);
  }
  return lives;
}

/** Small plate: hexagon, ticker and gain; the tag in the corner. */
function tile(b, ctx, P, c, rank, top) {
  const [x0, y0, x1, y1] = quadBox(P);
  const h = y1 - y0;
  const lives = [];
  const R = Math.min(h * 0.27, 40);
  const hx = x0 + 26 + R;
  const cy = y0 + h * 0.44;
  b.hexLogo(ctx, c, hx, cy, R);
  b.tag(ctx, x1 - 58, y0 + 22, rank, 10);
  const tx = hx + R + 18;
  const room = x1 - 20 - tx;
  b.sym(ctx, c, tx, cy - 12, Math.min(26, h * 0.17), "left", room - 40, 11);
  if (b.hasPct(c)) {
    lives.push((cc, p, salt) => b.gain(cc, c, tx, cy + 20, Math.min(22, h * 0.15), "left", p, salt));
    const ly = y1 - 18;
    lives.push((cc, p) => b.led(cc, x0 + 22, x1 - 22, ly, 5, c, top, p, 28));
    regBar(b, x0 + 22, x1 - 22, ly, 5, c, top, 28);
  }
  return lives;
}

// ── the terminal table (the site's) ─────────────────────────────────────────
function columns(w) {
  const cols = [["rank", 74], ["token", 0], ["price", 150], ["mcap", 150], ["bar", 220], ["chg", 150]];
  const drop = (k) => cols.splice(cols.findIndex(([x]) => x === k), 1);
  if (w < 980) drop("price");
  if (w < 700) drop("mcap");
  if (w < 560) drop("bar");
  const fixed = cols.reduce((a, [, cw]) => a + cw, 0);
  cols.find(([k]) => k === "token")[1] = Math.max(140, w - 48 - fixed);
  return cols;
}
const COL_LABEL = { rank: "#", token: "TOKEN", price: "PRICE", mcap: "MKT CAP", bar: "MOMENTUM", chg: "24H" };

/** The table's frame and its header row, as one item. Returns the row slots. */
function table(b, box, rows, firstRank, order, top) {
  const [x0, y0, x1, y1] = box;
  const headH = 40;
  const rowH = Math.min(96, (y1 - y0 - headH - 10) / rows.length);
  const cols = columns(x1 - x0);
  b.item(rectQuad(box), order, (ctx) => {
    let cx = x0 + 24;
    for (const [k, cw] of cols) {
      const right = k === "chg" || k === "price" || k === "mcap";
      caps(ctx, right ? cx + cw - 12 : k === "bar" ? cx + 30 : cx, y0 + headH / 2 + 4, COL_LABEL[k], 10, C.faint, right ? "right" : "left");
      cx += cw;
    }
    ctx.beginPath();
    ctx.moveTo(x0 + 16, y0 + headH);
    ctx.lineTo(x1 - 16, y0 + headH);
    ctx.lineWidth = 1;
    ctx.strokeStyle = lin(ctx, x0, 0, x1, 0, [[0, rgba(C.mint, 0.6)], [0.5, rgba(C.cyan, 0.35)], [1, rgba(C.cyan, 0.05)]]);
    ctx.stroke();
    for (let i = 1; i < rows.length; i++) {
      const y = y0 + headH + 4 + rowH * i;
      ctx.beginPath();
      ctx.moveTo(x0 + 16, y);
      ctx.lineTo(x1 - 16, y);
      ctx.lineWidth = 0.7;
      ctx.strokeStyle = "rgba(160,220,255,0.08)";
      ctx.stroke();
    }
    return [];
  }, { deep: 20 });
  rows.forEach((c, i) => {
    if (!c) return;
    const ry0 = y0 + headH + 4 + rowH * i;
    const rbox = [x0 + 8, ry0, x1 - 8, ry0 + rowH];
    const rank = firstRank + i;
    b.item(rectQuad(rbox), order + 1 + i, (ctx) => tableRow(b, ctx, rbox, cols, x0, c, rank, top), { plate: false });
  });
}

function tableRow(b, ctx, box, cols, tableX0, c, rank, top) {
  const [x0, y0, x1, y1] = box;
  const h = y1 - y0;
  const cy = (y0 + y1) / 2;
  const lead = rank === 1;
  const lives = [];
  if (lead) {
    ctx.fillStyle = lin(ctx, x0, 0, x1, 0, [[0, rgba(C.mint, 0.14)], [0.6, rgba(C.cyan, 0.05)], [1, rgba(C.cyan, 0)]]);
    ctx.fillRect(x0, y0 + 3, x1 - x0, h - 6);
    ctx.fillStyle = lin(ctx, 0, y0, 0, y1, [[0, C.mint], [1, C.cyan]]);
    ctx.fillRect(x0, y0 + 6, 3, h - 12);
  }
  let cx = tableX0 + 24;
  for (const [k, cw] of cols) {
    if (k === "rank") b.tag(ctx, cx, cy, rank, Math.min(12, h * 0.2), lead);
    if (k === "token") {
      const R = Math.min(h * 0.33, 30);
      b.hexLogo(ctx, c, cx + R, cy, R, lead);
      const tx = cx + R * 2 + 14;
      const room = cw - R * 2 - 24;
      const sz = Math.min(lead ? 26 : 24, h * 0.3);
      if (hasName(c) && h >= 50) {
        b.sym(ctx, c, tx, cy - h * 0.14, sz, "left", room, 11);
        b.nm(ctx, c, tx + 1, cy + h * 0.2, Math.max(LABEL_MIN, sz * 0.5), "left", room);
      } else b.sym(ctx, c, tx, cy, sz, "left", room, 11);
    }
    if (k === "price" || k === "mcap") {
      const v = k === "price" ? (pos(c.price) ? fmtPrice(c.price) : null) : (pos(c.mcap) ? fmtCap(c.mcap) : null);
      if (v) {
        ctx.font = fmono(Math.min(17, h * 0.22));
        ctx.fillStyle = C.ink;
        ctx.textAlign = "right";
        ctx.textBaseline = "middle";
        ctx.fillText(clipTo(ctx, v, cw - 20), cx + cw - 12, cy);
      }
    }
    if (k === "bar" && b.hasPct(c)) {
      const bx0 = cx + 30;
      const bx1 = cx + cw - 16;
      lives.push((cc, p) => b.led(cc, bx0, bx1, cy, 7, c, top, p, 16));
      regBar(b, bx0, bx1, cy, 7, c, top, 16);
    }
    if (k === "chg") {
      const gx = cx + cw - 12;
      lives.push((cc, p, salt) => b.gain(cc, c, gx, cy, Math.min(26, h * 0.3), "right", p, salt, lead));
    }
    cx += cw;
  }
  return lives;
}

// ── the ten compositions ────────────────────────────────────────────────────
function m1(b, coins) {
  const c = at(coins, 0);
  if (!c) return;
  const P = rectQuad([150, 150, 1130, 632]);
  b.item(P, 0, (ctx) => solo(b, ctx, P, c), { lead: true, deep: 34 });
}

/** m2: two slanted plates, the cut between them a diagonal. */
function m2(b, coins) {
  const top = topVal(coins.slice(0, 2));
  const plates = [
    [[SX0, 150], [672, 150], [622, 636], [SX0, 636]],
    [[700, 172], [SX1, 172], [SX1, 636], [650, 636]],
  ];
  plates.forEach((P, i) => {
    const c = at(coins, i);
    if (c) b.item(P, i, (ctx) => upright(b, ctx, P, c, i + 1, top), { lead: i === 0, deep: 30 });
  });
}

/** m3: the leader at the apex, the next two beneath it. */
function m3(b, coins) {
  const top = topVal(coins.slice(0, 3));
  const boxes = [[372, 146, 908, 396], [SX0, 414, 628, 640], [652, 414, SX1, 640]];
  boxes.forEach((box, i) => {
    const c = at(coins, i);
    const P = rectQuad(box);
    if (c) b.item(P, i, (ctx) => wide(b, ctx, P, c, i + 1, top, { big: i === 0 }), { lead: i === 0, deep: 26 });
  });
}

function m4(b, coins) {
  const top = topVal(coins.slice(0, 4));
  const w = (SX1 - SX0 - 24) / 2;
  const h = (SY1 - SY0 - 20) / 2;
  for (let i = 0; i < 4; i++) {
    const c = at(coins, i);
    if (!c) continue;
    const x0 = SX0 + (i % 2) * (w + 24);
    const y0 = SY0 + Math.floor(i / 2) * (h + 20);
    const P = rectQuad([x0, y0, x0 + w, y0 + h]);
    b.item(P, i, (ctx) => wide(b, ctx, P, c, i + 1, top), { lead: i === 0 });
  }
}

/** m5: the site's terminal table, five rows. */
function m5(b, coins) {
  table(b, [SX0, SY0, SX1, SY1], coins.slice(0, 5), 1, 0, topVal(coins.slice(0, 5)));
}

/** m6: a hive — three plates over three, the lower row offset by half. */
function m6(b, coins) {
  const top = topVal(coins.slice(0, 6));
  const w = 340;
  const g = 22;
  const h = 236;
  const rows = [[SX0, SY0], [SX1 - (w * 3 + g * 2), SY1 - h]];
  for (let i = 0; i < 6; i++) {
    const c = at(coins, i);
    if (!c) continue;
    const [rx, ry] = rows[Math.floor(i / 3)];
    const x0 = rx + (i % 3) * (w + g);
    const P = rectQuad([x0, ry, x0 + w, ry + h]);
    b.item(P, i, (ctx) => wide(b, ctx, P, c, i + 1, top, { big: i === 0 }), { lead: i === 0 });
  }
}

/** m7: the leader standing on the left, the next six in the table. */
function m7(b, coins) {
  const c = at(coins, 0);
  if (c) {
    const P = rectQuad([SX0, SY0, 452, SY1]);
    b.item(P, 0, (ctx) => upright(b, ctx, P, c, 1, pctOf(c) || 1), { lead: true, deep: 30 });
  }
  table(b, [472, SY0, SX1, SY1], coins.slice(1, 7), 2, 1, topVal(coins.slice(1, 7)));
}

function m8(b, coins) {
  table(b, [SX0, SY0, SX1, SY1], coins.slice(0, 8), 1, 0, topVal(coins.slice(0, 8)));
}

/** m9: a honeycomb of nine small plates, the middle row offset. */
function m9(b, coins) {
  const top = topVal(coins.slice(0, 9));
  const w = 360;
  const g = 20;
  const h = 152;
  const vg = (SY1 - SY0 - h * 3) / 2;
  for (let i = 0; i < 9; i++) {
    const c = at(coins, i);
    if (!c) continue;
    const r = Math.floor(i / 3);
    const x0 = SX0 + (r === 1 ? SX1 - SX0 - (w * 3 + g * 2) : 0) + (i % 3) * (w + g);
    const y0 = SY0 + r * (h + vg);
    const P = rectQuad([x0, y0, x0 + w, y0 + h]);
    if (i === 0) b.item(P, i, (ctx) => wide(b, ctx, P, c, 1, top, { big: false }), { lead: true, deep: 18 });
    else b.item(P, i, (ctx) => tile(b, ctx, P, c, i + 1, top), { deep: 18 });
  }
}

/** m10: the leader across the top, the next nine in two tables. */
function m10(b, coins) {
  const c = at(coins, 0);
  if (c) {
    const P = rectQuad([SX0, SY0, SX1, 300]);
    b.item(P, 0, (ctx) => wide(b, ctx, P, c, 1, pctOf(c) || 1), { lead: true, deep: 28 });
  }
  const top = topVal(coins.slice(1, 10));
  table(b, [SX0, 318, 632, SY1], coins.slice(1, 6), 2, 1, top);
  table(b, [648, 318, SX1, SY1], coins.slice(6, 10), 7, 7, top);
}

const LAYOUTS = { 1: m1, 2: m2, 3: m3, 4: m4, 5: m5, 6: m6, 7: m7, 8: m8, 9: m9, 10: m10 };
const NAMES = {
  1: "Solo Gem", 2: "Slant Duel", 3: "Apex", 4: "Quad", 5: "Terminal 5",
  6: "Hive", 7: "Leader + Table", 8: "Terminal 8", 9: "Honeycomb", 10: "Leader + Board",
};
const TEMPLATE_IDS = Object.keys(LAYOUTS).map((n) => `m${n}`);
const isTemplate = (id) => TEMPLATE_IDS.includes(id);
const countOf = (id) => (isTemplate(id) ? Number(String(id).slice(1)) : null);
const labelOf = (id) => (isTemplate(id) ? `🎬 ${NAMES[countOf(id)]}` : String(id));

// ── the room: a cut gem ─────────────────────────────────────────────────────
/** A low-poly facet field, lit from the top-left, and its edges on their own
 *  layer for the light that slides across them. */
function facetRoom(cv) {
  const out = cv.createCanvas(W, H);
  const ctx = out.getContext("2d");
  ctx.scale(K, K);
  ctx.fillStyle = "#06101F";
  ctx.fillRect(0, 0, DW, DH);
  const r = rng(90919);
  const cols = 18;
  const rows = 11;
  const cw = DW / cols;
  const ch = DH / rows;
  const pts = [];
  for (let j = 0; j <= rows; j++) {
    pts.push([]);
    for (let i = 0; i <= cols; i++) {
      const edge = i === 0 || j === 0 || i === cols || j === rows;
      pts[j].push([i * cw + (edge ? 0 : (r() - 0.5) * cw * 0.8), j * ch + (edge ? 0 : (r() - 0.5) * ch * 0.8), r()]);
    }
  }
  const tris = [];
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const a = pts[j][i];
      const b2 = pts[j][i + 1];
      const c2 = pts[j + 1][i + 1];
      const d = pts[j + 1][i];
      if ((i + j) % 2) tris.push([a, b2, c2], [a, c2, d]);
      else tris.push([a, b2, d], [b2, c2, d]);
    }
  }
  const L = [-0.45, -0.65, 0.62];
  for (const t of tris) {
    const [p0, p1, p2] = t;
    const u = [p1[0] - p0[0], p1[1] - p0[1], (p1[2] - p0[2]) * 60];
    const v = [p2[0] - p0[0], p2[1] - p0[1], (p2[2] - p0[2]) * 60];
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const nl = Math.hypot(...n) || 1;
    const lit = Math.abs((n[0] * L[0] + n[1] * L[1] + n[2] * L[2]) / nl);
    const cyM = (p0[1] + p1[1] + p2[1]) / 3;
    const fall = 1 - Math.min(1, cyM / DH) * 0.55;
    const k2 = (0.25 + lit * 0.75) * fall;
    const R = Math.round(7 + 22 * k2);
    const G = Math.round(17 + 42 * k2);
    const B = Math.round(36 + 80 * k2);
    ctx.beginPath();
    ctx.moveTo(p0[0], p0[1]);
    ctx.lineTo(p1[0], p1[1]);
    ctx.lineTo(p2[0], p2[1]);
    ctx.closePath();
    ctx.fillStyle = `rgb(${R},${G},${B})`;
    ctx.fill();
    ctx.strokeStyle = `rgb(${R},${G},${B})`; // seal the seams between facets
    ctx.lineWidth = 0.6;
    ctx.stroke();
  }
  // the light from the brand side of the room, and the dark it falls into
  const g1 = ctx.createRadialGradient(640, 60, 0, 640, 60, 760);
  g1.addColorStop(0, rgba("#2F86FF", 0.22));
  g1.addColorStop(1, rgba("#2F86FF", 0));
  ctx.fillStyle = g1;
  ctx.fillRect(0, 0, DW, DH);
  const vg = ctx.createRadialGradient(640, 380, 300, 640, 380, 860);
  vg.addColorStop(0, "rgba(0,0,0,0)");
  vg.addColorStop(1, "rgba(0,0,0,0.6)");
  ctx.fillStyle = vg;
  ctx.fillRect(0, 0, DW, DH);

  // the facet edges, half resolution: the light reveals them
  const edges = cv.createCanvas(Math.round(W / 2), Math.round(H / 2));
  const ex = edges.getContext("2d");
  ex.scale(K / 2, K / 2);
  ex.strokeStyle = "rgba(170,230,255,0.9)";
  ex.lineWidth = 1.1;
  ex.beginPath();
  for (const [p0, p1, p2] of tris) {
    ex.moveTo(p0[0], p0[1]);
    ex.lineTo(p1[0], p1[1]);
    ex.lineTo(p2[0], p2[1]);
    ex.closePath();
  }
  ex.stroke();
  return { base: out, edges };
}

// the two lights that slide across the facets; whole cycles per loop
const LIGHTS = [
  { ax: 520, ay: 150, cx: 1, cy: 2, ph: 0, r: 380, color: "#22D3EE", a: 0.1 },
  { ax: 460, ay: 120, cx: -1, cy: 1, ph: 0.4, r: 300, color: "#3DF59F", a: 0.06 },
];
function lightAt(l, u) {
  return [640 + l.ax * Math.cos(TAU * (l.cx * u + l.ph)), 360 + l.ay * Math.sin(TAU * (l.cy * u + l.ph))];
}

// ── chrome: the top bar and the ticker tape ─────────────────────────────────
function chrome(cv, b, n, dateText) {
  const out = cv.createCanvas(W, H);
  const ctx = out.getContext("2d");
  ctx.scale(K, K);
  ctx.textBaseline = "middle";

  // the bar's glass
  ctx.fillStyle = lin(ctx, 0, 0, 0, BAR_Y, [[0, "rgba(3,8,18,0.7)"], [1, "rgba(3,8,18,0.35)"]]);
  ctx.fillRect(0, 0, DW, BAR_Y);
  ctx.fillStyle = lin(ctx, 0, 0, DW, 0, [[0, rgba(C.mint, 0.9)], [0.35, rgba(C.cyan, 0.7)], [0.75, rgba(C.blue, 0.25)], [1, rgba(C.blue, 0)]]);
  ctx.fillRect(0, BAR_Y - 1, DW, 2);

  // left: the brand lockup
  drawBrandMark(ctx, SX0, 30, 50);
  ctx.font = fword(26);
  ctx.fillStyle = C.ink;
  tracked(ctx, "DEXVRA", SX0 + 64, 49, 4.5);
  caps(ctx, SX0 + 65, 75, "MARKET INTELLIGENCE", 10, C.faint, "left", 2.2);

  // centre: the title, the count in the gem's colours
  const ty = 50;
  const tsz = 42;
  const parts = n === 1 ? [["TOP GAINER", false]] : [["TOP ", false], [String(n), true], [" GAINERS", false]];
  ctx.font = fx(tsz);
  const tsp = 1.2;
  const widths = parts.map(([t]) => trackedW(ctx, t, tsp));
  const tw = widths.reduce((a, v) => a + v, 0);
  const pad = 10;
  const mxD = 640 - tw / 2 - pad;
  const myD = ty - tsz * 0.75;
  const mask = cv.createCanvas(Math.ceil((tw + pad * 2) * K), Math.ceil(tsz * 1.5 * K));
  const mc = mask.getContext("2d");
  mc.scale(K, K);
  mc.translate(-mxD, -myD);
  mc.font = fx(tsz);
  mc.textBaseline = "middle";
  mc.fillStyle = "#FFFFFF";
  let x = 640 - tw / 2;
  parts.forEach(([t, em], i) => {
    ctx.save();
    ctx.font = fx(tsz);
    ctx.fillStyle = em
      ? lin(ctx, 0, ty - tsz / 2, 0, ty + tsz / 2, [[0, "#E6FFF5"], [0.45, C.mint], [1, C.cyan]])
      : lin(ctx, 0, ty - tsz / 2, 0, ty + tsz / 2, [[0, "#FFFFFF"], [0.55, C.ice], [1, "#B8CCE0"]]);
    if (em) {
      ctx.shadowColor = rgba(C.mint, 0.5);
      ctx.shadowBlur = 16 * K;
    }
    tracked(ctx, t, x, ty, tsp);
    ctx.restore();
    tracked(mc, t, x, ty, tsp);
    x += widths[i];
  });
  b.title = { canvas: mask, x: Math.floor(mxD * K), y: Math.floor(myD * K) };
  caps(ctx, 640, 86, "24H · RANKED BY PRICE CHANGE", 10, C.faint, "center", 2.2);

  // right: LIVE, and the date under it
  const pw = 74;
  const px0 = SX1 - pw;
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(px0 + 10, 34);
  ctx.lineTo(SX1, 34);
  ctx.lineTo(SX1 - 10, 58);
  ctx.lineTo(px0, 58);
  ctx.closePath();
  ctx.fillStyle = rgba(C.mint, 0.12);
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = rgba(C.mint, 0.6);
  ctx.stroke();
  ctx.restore();
  b.liveDot = { x: px0 + 18, y: 46 };
  ctx.beginPath();
  ctx.arc(px0 + 18, 46, 3.5, 0, TAU);
  ctx.fillStyle = C.mint;
  ctx.fill();
  caps(ctx, px0 + 28, 46, "LIVE", 11, C.mint, "left", 2);
  if (dateText) {
    ctx.font = fname(12);
    ctx.fillStyle = C.dim;
    tracked(ctx, String(dateText).toUpperCase(), SX1, 78, 1.6, "right");
  }

  // the ticker tape's band, and its two fixed chips
  ctx.fillStyle = "rgba(3,8,18,0.86)";
  ctx.fillRect(0, TAPE_Y, DW, DH - TAPE_Y);
  ctx.fillStyle = lin(ctx, 0, 0, DW, 0, [[0, rgba(C.cyan, 0)], [0.2, rgba(C.cyan, 0.5)], [0.8, rgba(C.mint, 0.5)], [1, rgba(C.mint, 0)]]);
  ctx.fillRect(0, TAPE_Y, DW, 1);
  ctx.beginPath();
  ctx.moveTo(0, TAPE_Y);
  ctx.lineTo(TAPE_L, TAPE_Y);
  ctx.lineTo(TAPE_L - 22, DH);
  ctx.lineTo(0, DH);
  ctx.closePath();
  ctx.fillStyle = lin(ctx, 0, 0, TAPE_L, 0, [[0, C.mint], [1, C.cyan]]);
  ctx.fill();
  caps(ctx, 24, (TAPE_Y + DH) / 2, "24H GAINERS", 12, "#04121A", "left", 2);
  ctx.beginPath();
  ctx.moveTo(TAPE_R + 22, TAPE_Y);
  ctx.lineTo(DW, TAPE_Y);
  ctx.lineTo(DW, DH);
  ctx.lineTo(TAPE_R, DH);
  ctx.closePath();
  ctx.fillStyle = "#07111F";
  ctx.fill();
  drawBrandMark(ctx, TAPE_R + 36, (TAPE_Y + DH) / 2 - 12, 24);
  ctx.font = fx(15);
  ctx.fillStyle = C.ink;
  ctx.textAlign = "left";
  ctx.fillText("dexvra.io", TAPE_R + 68, (TAPE_Y + DH) / 2 + 1);
  return out;
}

/** The ticker tape's content, one period of it, as a strip. */
function tapeStrip(cv, b) {
  const items = b.coins.map((c) => {
    const v = pctOf(c);
    return { sym: tickerOf(c), fig: b.showPct && v !== null ? fmtPct(v) : pos(c.price) ? fmtPrice(c.price) : "", up: v === null || v >= 0 };
  });
  const m = cv.createCanvas(10, 10).getContext("2d");
  const widths = items.map((it) => {
    m.font = fx(17);
    const a = m.measureText(it.sym).width;
    m.font = fx(17);
    const f = it.fig ? m.measureText(it.fig).width + 12 : 0;
    return a + f + 54;
  });
  let segW = widths.reduce((a, v) => a + v, 0);
  const reps = Math.max(1, Math.ceil(620 / segW)); // a short board is repeated, or it races
  segW *= reps;
  const h = DH - TAPE_Y;
  const s = cv.createCanvas(Math.ceil(segW * K), Math.ceil(h * K));
  const x = s.getContext("2d");
  x.scale(K, K);
  x.textBaseline = "middle";
  let px = 0;
  for (let r = 0; r < reps; r++) {
    items.forEach((it, i) => {
      kit.drawGem(x, px + 6, h / 2 - 8, 16);
      x.font = fx(17);
      x.fillStyle = C.ink;
      x.fillText(it.sym, px + 30, h / 2 + 1);
      const a = x.measureText(it.sym).width;
      if (it.fig) {
        x.fillStyle = it.up ? C.mint : C.red;
        x.fillText(it.fig, px + 30 + a + 12, h / 2 + 1);
      }
      px += widths[i];
    });
  }
  return { canvas: s, segW };
}

/** Lay out the board once: the room, the chrome, every plate's sprite. */
function build(cv, n, coins, { dateText = "", showPct = true } = {}) {
  const b = new Board(cv, n, coins, { showPct });
  const room = facetRoom(cv);
  b.bg = room.base;
  b.edges = room.edges;
  b.chrome = chrome(cv, b, n, dateText);
  LAYOUTS[n](b, coins);
  b.tape = tapeStrip(cv, b);
  b.tmp = cv.createCanvas(b.edges.width, b.edges.height);
  b.shine = null;
  return b;
}

/** A plate at loop position u: its alpha, its vertical scale (a terminal
 *  switching it off and on), its decode progress, and the flash of the line. */
function itemState(it, u, nItems) {
  if (u < HOLD_END) return { a: 1, s: 1, p: 1, flash: 0 };
  if (u < ON0) {
    const step = Math.min(0.006, (OFF_END - HOLD_END - OFF_DUR) / Math.max(1, nItems - 1));
    const st = HOLD_END + (nItems - 1 - it.order) * step; // the last rank first, the leader last
    const q = clamp01((u - st) / OFF_DUR);
    if (q >= 1) return { a: 0, s: 0.02, p: 1, flash: 0 };
    return { a: 1, s: 1 - 0.98 * easeIn(q), p: 1, flash: q > 0 ? q : 0 };
  }
  const span = Math.max(0, 1 - ENTER_SLACK - ON0 - ON_DUR - COUNT_DELAY - COUNT_DUR);
  const step = Math.min(0.018, span / Math.max(1, nItems - 1));
  const st = ON0 + it.order * step;
  if (u < st) return { a: 0, s: 0.02, p: 0, flash: 0 };
  const q = clamp01((u - st) / ON_DUR);
  const p = clamp01((u - st - COUNT_DELAY) / COUNT_DUR);
  return { a: 1, s: 0.02 + 0.98 * easeOut(q), p, flash: 1 - q };
}

/** One frame at loop position u ∈ [0, 1). compose(b, ctx, 0) is the full board. */
function compose(b, ctx, u) {
  u = ((u % 1) + 1) % 1;
  const nItems = b.items.length;
  const salt = Math.floor(u * FRAMES * 0.5); // the decode noise changes every other frame
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";

  // the room, and the lights sliding over its facets
  ctx.drawImage(b.bg, 0, 0);
  // the facet edges, shown only where a light falls: the lights' union as a
  // mask, the edges drawn into it
  const tx = b.tmp.getContext("2d");
  tx.setTransform(1, 0, 0, 1, 0, 0);
  tx.globalCompositeOperation = "source-over";
  tx.clearRect(0, 0, b.tmp.width, b.tmp.height);
  tx.save();
  tx.scale(K / 2, K / 2);
  for (const l of LIGHTS) {
    const [lx, ly] = lightAt(l, u);
    const g = tx.createRadialGradient(lx, ly, 0, lx, ly, l.r);
    g.addColorStop(0, "rgba(255,255,255,1)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    tx.fillStyle = g;
    tx.fillRect(lx - l.r, ly - l.r, l.r * 2, l.r * 2);
  }
  tx.restore();
  tx.globalCompositeOperation = "source-in";
  tx.drawImage(b.edges, 0, 0);
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  ctx.globalAlpha = 0.55;
  ctx.drawImage(b.tmp, 0, 0, W, H);
  ctx.globalAlpha = 1;
  ctx.scale(K, K);
  for (const l of LIGHTS) {
    const [lx, ly] = lightAt(l, u);
    const g = ctx.createRadialGradient(lx, ly, 0, lx, ly, l.r);
    g.addColorStop(0, rgba(l.color, l.a));
    g.addColorStop(1, rgba(l.color, 0));
    ctx.fillStyle = g;
    ctx.fillRect(lx - l.r, ly - l.r, l.r * 2, l.r * 2);
  }
  ctx.restore();

  ctx.drawImage(b.chrome, 0, 0);

  // the tape scrolls one period per loop
  ctx.save();
  ctx.beginPath();
  ctx.rect(TAPE_L * K, TAPE_Y * K, (TAPE_R + 22 - TAPE_L) * K, (DH - TAPE_Y) * K);
  ctx.clip();
  const sw = b.tape.segW;
  let tx0 = TAPE_L - 20 - u * sw;
  while (tx0 < TAPE_R + 22) {
    ctx.drawImage(b.tape.canvas, tx0 * K, TAPE_Y * K);
    tx0 += sw;
  }
  ctx.restore();

  // the plates
  for (const it of b.items) {
    const st = itemState(it, u, nItems);
    if (st.a <= 0.004) continue;
    const cyPx = ((it.box[1] + it.box[3]) / 2) * K;
    ctx.save();
    if (st.s < 0.999) {
      ctx.translate(0, cyPx);
      ctx.scale(1, st.s);
      ctx.translate(0, -cyPx);
    }
    ctx.globalAlpha = st.a;
    if (st.p >= 0.999) {
      ctx.drawImage(it.final, it.x, it.y);
    } else {
      ctx.drawImage(it.body, it.x, it.y);
      ctx.save();
      ctx.translate(it.x, it.y);
      it.local(ctx);
      for (const lv of it.lives) lv(ctx, st.p, salt);
      ctx.restore();
    }
    ctx.restore();
    // the thin bright line a terminal draws as it switches a panel off and
    // on: only while the plate is nearly folded — a wash over a plate that
    // is still open reads as a white sheet, not a screen
    const line = clamp01(1.25 - st.s * 1.5);
    if (st.flash > 0.01 && line > 0.01) {
      const [x0, , x1] = it.box;
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      ctx.globalAlpha = line;
      ctx.fillStyle = lin(ctx, x0 * K, 0, x1 * K, 0, [[0, rgba(C.cyan, 0)], [0.2, rgba(C.cyan, 0.8)], [0.5, rgba("#FFFFFF", 1)], [0.8, rgba(C.cyan, 0.8)], [1, rgba(C.cyan, 0)]]);
      ctx.shadowColor = C.cyan;
      ctx.shadowBlur = 14 * K;
      ctx.fillRect(x0 * K, cyPx - 1.5 * K, (x1 - x0) * K, 3 * K);
      ctx.restore();
    }
  }

  ctx.save();
  ctx.scale(K, K);
  // a pulse runs down each LED bar, one after another (hold only)
  for (const bar of b.bars) {
    const s0 = 0.08 + bar.order * 0.035;
    if (!(u >= s0 && u < s0 + 0.14)) continue;
    const q = (u - s0) / 0.14;
    const idx = Math.floor(q * bar.lit);
    const gap = Math.max(1.5, bar.h * 0.35);
    const sw2 = (bar.x1 - bar.x0 - gap * (bar.segs - 1)) / bar.segs;
    const x = bar.x0 + idx * (sw2 + gap);
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    ctx.shadowColor = bar.up ? C.mint : C.red;
    ctx.shadowBlur = bar.h * 2.5 * K;
    ctx.fillRect(x, bar.y - bar.h / 2, sw2, bar.h);
    ctx.shadowBlur = 0;
  }
  // a glint crosses the leader's plate (hold only)
  const lead = b.items.find((it) => it.lead);
  if (lead && u >= 0.04 && u < 0.18) {
    const [x0, y0, x1, y1] = lead.box;
    const q = easeInOut((u - 0.04) / 0.14);
    const bw = Math.max(60, (x1 - x0) * 0.16);
    const sk = (y1 - y0) * 0.4;
    const bx = x0 - bw - sk + (x1 - x0 + bw + sk) * q;
    ctx.save();
    gemPath(ctx, lead.P, lead.deep);
    ctx.clip();
    ctx.beginPath();
    ctx.moveTo(bx + sk, y0);
    ctx.lineTo(bx + sk + bw, y0);
    ctx.lineTo(bx + bw, y1);
    ctx.lineTo(bx, y1);
    ctx.closePath();
    ctx.fillStyle = lin(ctx, bx, 0, bx + bw + sk, 0, [[0, "rgba(255,255,255,0)"], [0.5, "rgba(255,255,255,0.14)"], [1, "rgba(255,255,255,0)"]]);
    ctx.fill();
    ctx.restore();
  }
  // the LIVE dot breathes: three pulses per loop
  if (b.liveDot) {
    const ph = (u * 3) % 1;
    ctx.beginPath();
    ctx.arc(b.liveDot.x, b.liveDot.y, 3.5 + 8 * ph, 0, TAU);
    ctx.lineWidth = 0.9;
    ctx.strokeStyle = rgba(C.mint, 0.65 * (1 - ph));
    ctx.stroke();
  }
  ctx.restore();

  // the title shines once per loop
  if (b.title && u >= 0.28 && u < 0.42) {
    const t = b.title;
    if (!b.shine) b.shine = b.cv.createCanvas(t.canvas.width, t.canvas.height);
    const sx = b.shine.getContext("2d");
    sx.setTransform(1, 0, 0, 1, 0, 0);
    sx.globalCompositeOperation = "source-over";
    sx.clearRect(0, 0, b.shine.width, b.shine.height);
    const gp = easeInOut((u - 0.28) / 0.14);
    const bw = t.canvas.height * 1.1;
    const bx = -bw * 1.5 + (t.canvas.width + bw * 2) * gp;
    sx.beginPath();
    sx.moveTo(bx + bw * 0.6, 0);
    sx.lineTo(bx + bw * 1.2, 0);
    sx.lineTo(bx + bw * 0.6, t.canvas.height);
    sx.lineTo(bx, t.canvas.height);
    sx.closePath();
    sx.fillStyle = lin(sx, bx, 0, bx + bw * 1.2, 0, [[0, "rgba(255,255,255,0)"], [0.5, "rgba(255,255,255,0.8)"], [1, "rgba(255,255,255,0)"]]);
    sx.fill();
    sx.globalCompositeOperation = "destination-in";
    sx.drawImage(t.canvas, 0, 0);
    ctx.drawImage(b.shine, t.x, t.y);
  }
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
  _decode: decode,
  TMP_PREFIX,
};
