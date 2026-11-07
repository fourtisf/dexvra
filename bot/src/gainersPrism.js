"use strict";
/**
 * PRISM — the animated Top-Gainers set, 💠1 → 💠10 (2026-11).
 *
 * "buatkan gif top gainer … warnanya biru kaya brand dexvra" → four rounds of
 * renders judged by the operator, and this is the one approved ("thats good
 * buatkan dari top 1 sampai 10 premium visual dan annimasinya bagus"). Asked
 * to be ADDED to the panel ("Tambahan saja"): the still premium set stays the
 * front set and the 🎲 random default; Prism is its own row of ten buttons.
 *
 * What it looks like (the approved frame, 16:9):
 *   • a POSTER PANEL on the left — the Dexvra mark, a giant cut-crystal
 *     numeral (faceted sapphire gradient, bright rim, glow) between TOP and
 *     GAINERS, the date, a LIVE chip;
 *   • GEM-CUT cards on the right (top-left and bottom-right corners cut like
 *     the facets of the mark): the leader on a wide SPOTLIGHT card, the
 *     runners-up in one composition per count (COMPOSITIONS) — a bigger card
 *     for a higher rank whenever the rows differ;
 *   • glossy coins in a rank-tinted metal ring, silver tickers, ice-blue gains.
 *
 * How it moves (8 s loop, FRAME 0 IS THE FULL BOARD — Telegram's thumbnail,
 * the X still and the preview's first look are all the finished board):
 *   hold   0.00–0.62  a prism shine crosses the numeral, a sparkle flashes on
 *                     the leader's ring, a glint crosses each card in turn, a
 *                     light runs once round the spotlight card
 *   exit   0.62–0.69  the cards slide right and fade
 *   enter  0.69–0.97  they are dealt back in from BEHIND the panel one by one,
 *                     the gains counting up and the bars filling
 *   always            LIVE pulses in whole cycles, so t = 1 draws t = 0
 *
 * The bot's rules hold here as in gainersBanner.js:
 *   • render NEVER throws — any failure resolves null and the caller posts
 *     nothing;
 *   • no number is invented: a cell whose figure is missing is left out, the
 *     % is fmtPct (the caption's own formatter), a bar is pct / max(pct);
 *   • 📈 off removes every % AND every bar (a bar is the % drawn as length),
 *     🏦 / 💲 off remove the market cap / price — decided ONCE, on copies;
 *   • the layout is driven by the coins that exist, never the nominal size.
 *
 * Geometry is written in the approved renders' 1920×1080 design space and
 * drawn at OUT_W×OUT_H (the bot's 1600×900) through one scale, K.
 */
const fss = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const kit = require("./helpers/canvasKit");
const { toSendBuffer } = require("./helpers/encodeImage");
const { fmtCap, fmtPrice, fmtPct } = require("./helpers/format");
const log = require("./helpers/logger");

const { F, roundRect, drawBrandMark } = kit;

// ── geometry ────────────────────────────────────────────────────────────────
const DW = 1920;
const DH = 1080;
const OUT_W = 1600;
const OUT_H = 900;
const K = OUT_W / DW;
const PANEL = [72, 72, 600, 1008];
const STAGE = [636, 72, 1848, 1008];
const CUT = 26;
const CUT_PANEL = 44;
const GAP = 24;
const PAD = 70; // sprite margin round a card, for its shadow and glow

/** count → [spotlight height, runners-up per row]; null height = the leader alone. */
const COMPOSITIONS = {
  1: [null, []],
  2: [470, [1]],
  3: [456, [2]],
  4: [440, [3]],
  5: [400, [2, 2]],
  6: [380, [2, 3]],
  7: [360, [3, 3]],
  8: [316, [2, 2, 3]],
  9: [316, [2, 3, 3]],
  10: [316, [3, 3, 3]],
};
const NAMES = {
  1: "Solo", 2: "Duel", 3: "Trio", 4: "Quartet", 5: "Quad", 6: "Tiered 2+3",
  7: "Twin Rows", 8: "Tiered 2+2+3", 9: "Tiered 2+3+3", 10: "Nine Grid",
};
const IDS = Object.keys(NAMES).map((n) => `prism${n}`);
const TEMPLATES = Object.fromEntries(IDS.map((id, i) => [id, {
  id, n: i + 1, label: `💠 Prism ${NAMES[i + 1]}`, button: `💠${i + 1}`, prism: true,
}]));

// ── timeline (fractions of the loop) ────────────────────────────────────────
const FPS = 24;
const SECONDS = 8;
const FRAMES = FPS * SECONDS;
const HOLD_END = 0.62;
const EXIT_END = 0.69;
const ENTER_DUR = 0.1;
const SETTLED = 0.97;

// ── palette: Dexvra sapphire ────────────────────────────────────────────────
const ELECTRIC = "#2962FF";
const AZURE = "#4E9CFF";
const CYAN = "#22D3EE";
const ICE = "#C4E8FF";
const INK = "#F2F6FC";
const DIM = "#8C9CBA";
const FAINT = "#566482";
const SILVER = [[0, "#FFFFFF"], [0.55, "#E4ECF8"], [1, "#9CAECC"]];
const CRYSTAL = [[0, "#ECF8FF"], [0.3, "#96CEFF"], [0.52, "#3470FF"], [0.7, "#78D6FF"], [1, "#1C48D2"]];
const GAIN = [[0, "#E2F4FF"], [0.6, "#88C6FF"], [1, "#5296FF"]];
const LOSS = [[0, "#FFC4CE"], [1, "#FF607A"]];
const BAR = [[0, "#2962FF"], [0.7, "#5CA8FF"], [1, "#C4E8FF"]];
const RING = {
  1: [[0, "#D6F0FF"], [0.45, "#4E9CFF"], [1, "#1E4EDC"]],
  2: [[0, "#FAFCFF"], [0.5, "#A0AEC8"], [1, "#E2E8F4"]],
  3: [[0, "#C4DEFF"], [0.5, "#4678DC"], [1, "#A0C4FF"]],
};
const RING_REST = [[0, "#788CB0"], [1, "#344262"]];
const RANK_INK = { 1: ICE, 2: "#E2EAF8", 3: "#96C0FF" };
const rankInk = (r) => RANK_INK[r] || "#788CB0";

// ── small helpers ───────────────────────────────────────────────────────────
const clamp = (v, a = 0, b = 1) => (v < a ? a : v > b ? b : v);
const easeOut = (t) => 1 - Math.pow(1 - clamp(t), 3);
const easeIn = (t) => clamp(t) * clamp(t);
const easeIO = (t) => { const u = clamp(t); return u * u * (3 - 2 * u); };
const TAU = Math.PI * 2;

function lin(ctx, x0, y0, x1, y1, stops) {
  const g = ctx.createLinearGradient(x0, y0, x1, y1);
  for (const [o, c] of stops) g.addColorStop(o, c);
  return g;
}

/** A gem cut: top-left and bottom-right corners cut by c. */
function cutPts(x0, y0, x1, y1, c) {
  c = Math.max(0, Math.min(c, (x1 - x0) / 2, (y1 - y0) / 2));
  return [[x0 + c, y0], [x1, y0], [x1, y1 - c], [x1 - c, y1], [x0, y1], [x0, y0 + c]];
}
function polyPath(ctx, pts) {
  ctx.beginPath();
  pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.closePath();
}

const font = (px, fam) => `${Math.max(6, Math.round(px))}px ${fam}`;
/** Cap height of the current font, measured (a ticker of digits has none). */
const capOf = (ctx) => {
  const m = ctx.measureText("H");
  return m.actualBoundingBoxAscent || 0;
};

function trackedW(ctx, text, t) {
  const cs = [...String(text)];
  return cs.reduce((a, c) => a + ctx.measureText(c).width, 0) + t * Math.max(0, cs.length - 1);
}
/** Letter-spaced text; align l / c / r on x, baseline at y. Returns its width. */
function tracked(ctx, text, x, y, t, align = "l") {
  const w = trackedW(ctx, text, t);
  let cx = align === "c" ? x - w / 2 : align === "r" ? x - w : x;
  const prev = ctx.textAlign;
  ctx.textAlign = "left";
  for (const ch of [...String(text)]) {
    ctx.fillText(ch, cx, y);
    cx += ctx.measureText(ch).width + t;
  }
  ctx.textAlign = prev;
  return w;
}

/** Largest size ≤ px (down to min) whose text fits maxW, then an ellipsis. */
function fitFont(ctx, text, maxW, px, min, fam) {
  let s = Math.round(px);
  ctx.font = font(s, fam);
  while (s > min && ctx.measureText(text).width > maxW) ctx.font = font(--s, fam);
  if (ctx.measureText(text).width <= maxW) return { text, px: s };
  let out = String(text);
  while (out.length > 2 && ctx.measureText(out + "…").width > maxW) out = out.slice(0, -1);
  return { text: out + "…", px: s };
}

/** Text filled with a vertical gradient spanning its cap height. */
function gradText(ctx, text, x, y, stops, align = "left") {
  const cap = capOf(ctx) || 10;
  ctx.textAlign = align;
  ctx.fillStyle = lin(ctx, 0, y - cap, 0, y, stops);
  ctx.fillText(text, x, y);
  ctx.textAlign = "left";
}

/**
 * The price / market-cap line a card carries under its ticker — ONE owner for
 * every card, the leader's and the runners-up' alike. It used to be drawn on
 * the leader's card only, so with 🏦 MC on the board showed one market cap out
 * of ten ("mc sudah on tapi yang di show hanya top 1"). A figure that is
 * missing (or switched off — the copies in `prepare` carry null) is left out,
 * never drawn as $0. Two tones: the values bright enough to read at card size,
 * the "MC" label and the separator receding.
 */
const META_VAL = "#AFC0DE";
const META_DIM = "#5F7096";
const META_SEP = "  ·  ";
const metaParts = (c) => {
  const parts = [];
  if (c && c.price) parts.push(["", fmtPrice(c.price)]);
  if (c && c.mcap) parts.push(["MC ", fmtCap(c.mcap)]);
  return parts;
};
const hasMeta = (c) => metaParts(c).length > 0;
function drawMeta(ctx, c, x, y, maxW, px, min, align = "left") {
  const parts = metaParts(c);
  if (!parts.length || !(maxW > 0)) return false;
  const whole = parts.map(([l, v]) => l + v).join(META_SEP);
  const f = fitFont(ctx, whole, maxW, px, min, F.d6);
  ctx.font = font(f.px, F.d6);
  ctx.textAlign = "left";
  if (f.text !== whole) {
    // did not fit even at the floor: one tone, ellipsised, still inside the card
    const w = ctx.measureText(f.text).width;
    ctx.fillStyle = META_VAL;
    ctx.fillText(f.text, align === "center" ? x - w / 2 : align === "right" ? x - w : x, y);
    return true;
  }
  const w = ctx.measureText(whole).width;
  let cx = align === "center" ? x - w / 2 : align === "right" ? x - w : x;
  const run = (t, col) => { ctx.fillStyle = col; ctx.fillText(t, cx, y); cx += ctx.measureText(t).width; };
  parts.forEach(([l, v], i) => {
    if (i) run(META_SEP, META_DIM);
    if (l) run(l, META_DIM);
    run(v, META_VAL);
  });
  return true;
}

const tickerOf = (c) => `$${String((c && (c.symbol || c.name)) || "?").replace(/^\$+/, "").slice(0, 14)}`;
const nameOf = (c) => {
  const n = String((c && c.name) || "").trim();
  return n && n.toLowerCase().replace(/^\$/, "") !== tickerOf(c).slice(1).toLowerCase() ? n : "";
};
const hasPct = (c) => Boolean(c && c.pctLabel);
const pctNum = (c) => {
  const v = Number(c && c.pct);
  return Number.isFinite(v) ? v : null;
};

// ── the brand pieces ────────────────────────────────────────────────────────
function drawStar(ctx, x, y, r) {
  ctx.beginPath();
  for (let i = 0; i < 8; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 4;
    const rr = i % 2 ? r * 0.16 : r;
    ctx[i ? "lineTo" : "moveTo"](x + Math.cos(a) * rr, y + Math.sin(a) * rr);
  }
  ctx.closePath();
  ctx.fill();
}

function gemPts(cx, gy, s) {
  return [[15, 12], [33, 12], [39, 19], [24, 37], [9, 19]].map(([x, y]) => [cx + (x - 24) * s, gy + (y - 19) * s]);
}
function gemLines(cx, gy, s) {
  const f = ([x, y]) => [cx + (x - 24) * s, gy + (y - 19) * s];
  return [[[9, 19], [39, 19]], [[15, 12], [20, 19]], [[33, 12], [28, 19]], [[20, 19], [24, 37]], [[28, 19], [24, 37]]].map(([a, b]) => [f(a), f(b)]);
}
function gemWatermark(ctx, cx, gy, s, alpha) {
  ctx.save();
  ctx.strokeStyle = `rgba(120,180,255,${alpha})`;
  ctx.lineWidth = 2;
  ctx.lineJoin = "round";
  polyPath(ctx, gemPts(cx, gy, s));
  ctx.stroke();
  ctx.lineWidth = 1.4;
  ctx.strokeStyle = `rgba(120,180,255,${alpha * 0.6})`;
  for (const [[ax, ay], [bx, by]] of gemLines(cx, gy, s)) {
    ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
  }
  ctx.restore();
}

/** A token's coin: glossy logo in a rank-tinted metal ring, centred at (cx, cy). */
function drawCoin(ctx, c, cx, cy, d, rank, { ring = 3, glow = 0 } = {}) {
  const R = d / 2 + ring + 1.5;
  ctx.save();
  if (glow) {
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * 2);
    g.addColorStop(0, `rgba(41,98,255,${glow})`);
    g.addColorStop(1, "rgba(41,98,255,0)");
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(cx, cy, R * 2, 0, TAU); ctx.fill();
  }
  ctx.shadowColor = "rgba(0,0,0,0.55)";
  ctx.shadowBlur = Math.max(4, d * 0.08);
  ctx.shadowOffsetY = d * 0.03;
  ctx.fillStyle = lin(ctx, cx - R, cy - R, cx + R, cy + R, RING[rank] || RING_REST);
  ctx.beginPath(); ctx.arc(cx, cy, R, 0, TAU); ctx.fill();
  ctx.restore();

  ctx.save();
  ctx.beginPath(); ctx.arc(cx, cy, d / 2, 0, TAU); ctx.clip();
  if (c.img) {
    try {
      kit.drawLogoDisc(ctx, c.img, cx, cy, d / 2, { backdrop: "#0C1428" });
    } catch {
      c.img = null;
    }
  }
  if (!c.img) {
    ctx.fillStyle = lin(ctx, cx - d / 2, cy - d / 2, cx + d / 2, cy + d / 2, [[0, "#4682FF"], [0.5, "#1C40AA"], [1, "#0A1846"]]);
    ctx.fillRect(cx - d / 2, cy - d / 2, d, d);
    const mono = tickerOf(c).slice(1, 3).toUpperCase() || "?";
    ctx.font = font(d * 0.36, F.d7);
    ctx.fillStyle = INK;
    ctx.textAlign = "center";
    ctx.fillText(mono, cx, cy + capOf(ctx) / 2);
    ctx.textAlign = "left";
  }
  // gloss: a cap of light on the upper half, a little shade below
  const gl = ctx.createLinearGradient(0, cy - d / 2, 0, cy + d * 0.08);
  gl.addColorStop(0, "rgba(255,255,255,0.30)");
  gl.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = gl;
  ctx.beginPath(); ctx.ellipse(cx, cy - d * 0.2, d * 0.4, d * 0.28, 0, 0, TAU); ctx.fill();
  const sh = ctx.createLinearGradient(0, cy + d * 0.05, 0, cy + d / 2);
  sh.addColorStop(0, "rgba(0,6,24,0)");
  sh.addColorStop(1, "rgba(0,6,24,0.28)");
  ctx.fillStyle = sh;
  ctx.fillRect(cx - d / 2, cy, d, d / 2);
  ctx.restore();
}

// ── the board ───────────────────────────────────────────────────────────────
/** A canvas in OUTPUT pixels whose context draws in DESIGN units, offset so
 *  that design point (dx, dy) lands on its pixel (0, 0). */
function layer(cv, w, h, dx = 0, dy = 0) {
  const c = cv.createCanvas(Math.max(1, Math.ceil(w)), Math.max(1, Math.ceil(h)));
  const ctx = c.getContext("2d");
  ctx.setTransform(K, 0, 0, K, -dx * K, -dy * K);
  ctx.textBaseline = "alphabetic";
  return { c, ctx };
}

function backdrop(ctx) {
  ctx.fillStyle = lin(ctx, 0, 0, 0, DH, [[0, "#060B1C"], [0.5, "#040813"], [1, "#02040B"]]);
  ctx.fillRect(0, 0, DW, DH);
  const blob = (cx, cy, rw, rh, rgb, a) => {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(1, rh / rw);
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, rw);
    g.addColorStop(0, `rgba(${rgb},${a})`);
    g.addColorStop(0.55, `rgba(${rgb},${a * 0.32})`);
    g.addColorStop(1, `rgba(${rgb},0)`);
    ctx.fillStyle = g;
    ctx.fillRect(-rw, -rw, rw * 2, rw * 2);
    ctx.restore();
  };
  blob(330, 420, 900, 900, "34,82,210", 0.42);
  blob(1240, -80, 1200, 620, "26,66,180", 0.4);
  blob(1900, 900, 800, 600, "18,120,200", 0.16);
  blob(1240, 620, 1400, 800, "12,30,90", 0.3);
  // prism rays: light through the gem, falling from the panel across the stage
  ctx.save();
  ctx.filter = "blur(14px)";
  for (const [x0, w0, x1, w1, a] of [[420, 60, 1500, 260, 0.05], [560, 30, 1900, 180, 0.04], [300, 40, 1100, 220, 0.035]]) {
    ctx.fillStyle = lin(ctx, 0, 0, 0, DH, [[0, `rgba(150,200,255,${a})`], [1, "rgba(150,200,255,0)"]]);
    ctx.beginPath();
    ctx.moveTo(x0, 0); ctx.lineTo(x0 + w0, 0); ctx.lineTo(x1 + w1, DH); ctx.lineTo(x1, DH);
    ctx.closePath(); ctx.fill();
  }
  ctx.restore();
  // vignette
  ctx.save();
  ctx.translate(DW / 2, DH * 0.45);
  ctx.scale(1, DH / DW * 1.25);
  const v = ctx.createRadialGradient(0, 0, DW * 0.28, 0, 0, DW * 0.78);
  v.addColorStop(0, "rgba(0,0,0,0)");
  v.addColorStop(1, "rgba(0,0,0,0.7)");
  ctx.fillStyle = v;
  ctx.fillRect(-DW, -DW, DW * 2, DW * 2);
  ctx.restore();
}

/** The crystal numeral on its own canvas (+ an alpha mask for the shine). */
function numeral(cv, text, px) {
  const meas = layer(cv, 10, 10).ctx;
  meas.font = font(px, F.d7);
  const w = trackedW(meas, text, -8);
  const cap = capOf(meas) || px * 0.7;
  const pad = 60;
  const bw = w + pad * 2;
  const bh = cap + pad * 2;
  const L = layer(cv, bw * K, bh * K);
  const m = layer(cv, bw * K, bh * K);
  const base = pad + cap;
  for (const g of [L.ctx, m.ctx]) g.font = font(px, F.d7);
  // the body: a faceted sapphire gradient
  L.ctx.fillStyle = lin(L.ctx, pad, pad, pad + w * 0.45, base, CRYSTAL);
  tracked(L.ctx, text, pad, base, -8);
  m.ctx.fillStyle = "#fff";
  tracked(m.ctx, text, pad, base, -8);
  // facets: faint planes of light cut across the glyphs, inside them only
  L.ctx.save();
  L.ctx.globalCompositeOperation = "source-atop";
  for (let i = 0, xx = -bh; xx < bw + bh; xx += 55, i++) {
    if (i % 2) {
      L.ctx.fillStyle = "rgba(255,255,255,0.13)";
      L.ctx.beginPath();
      L.ctx.moveTo(xx, 0); L.ctx.lineTo(xx + 28, 0); L.ctx.lineTo(xx + 28 - bh * 0.6, bh); L.ctx.lineTo(xx - bh * 0.6, bh);
      L.ctx.closePath(); L.ctx.fill();
    }
  }
  L.ctx.strokeStyle = "rgba(255,255,255,0.32)";
  L.ctx.lineWidth = 1.5;
  for (let xx = -bh; xx < bw + bh; xx += 85) {
    L.ctx.beginPath(); L.ctx.moveTo(xx, 0); L.ctx.lineTo(xx + bh * 0.8, bh); L.ctx.stroke();
  }
  // the lower half cools
  L.ctx.fillStyle = lin(L.ctx, 0, base - cap * 0.45, 0, base, [[0, "rgba(20,50,170,0)"], [1, "rgba(20,50,170,0.35)"]]);
  L.ctx.fillRect(0, base - cap * 0.45, bw, cap * 0.45 + 4);
  L.ctx.restore();
  // a bright rim
  L.ctx.save();
  L.ctx.strokeStyle = "rgba(220,244,255,0.85)";
  L.ctx.lineWidth = 2.4;
  L.ctx.lineJoin = "round";
  let x = pad;
  for (const ch of [...text]) {
    L.ctx.strokeText(ch, x, base);
    x += L.ctx.measureText(ch).width - 8;
  }
  L.ctx.restore();
  return { c: L.c, mask: m.c, w, cap, pad, bw, bh };
}

function drawPanel(cv, ctx, { n, dateText }) {
  const [x0, y0, x1, y1] = PANEL;
  const w = x1 - x0;
  const cx = (x0 + x1) / 2;
  const pts = cutPts(x0, y0, x1, y1, CUT_PANEL);
  // glow + drop shadow
  ctx.save();
  ctx.shadowColor = "rgba(41,98,255,0.38)";
  ctx.shadowBlur = 70;
  ctx.fillStyle = "#08102A";
  polyPath(ctx, pts); ctx.fill();
  ctx.shadowColor = "rgba(0,0,0,0.55)";
  ctx.shadowBlur = 40; ctx.shadowOffsetY = 20;
  ctx.fill();
  ctx.restore();
  ctx.save();
  polyPath(ctx, pts);
  ctx.fillStyle = lin(ctx, 0, y0, 0, y1, [[0, "#0E1E4C"], [0.5, "#08102A"], [1, "#050A1A"]]);
  ctx.fill();
  ctx.clip();
  const g = ctx.createRadialGradient(cx, y0 + 300, 0, cx, y0 + 300, 520);
  g.addColorStop(0, "rgba(60,120,255,0.30)");
  g.addColorStop(1, "rgba(60,120,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(x0, y0, w, y1 - y0);
  ctx.restore();
  ctx.save();
  ctx.strokeStyle = lin(ctx, x0, y0, x1, y1, [[0, "#AAE1FF"], [0.4, "#3C78FF"], [1, "#183278"]]);
  ctx.globalAlpha = 0.9;
  ctx.lineWidth = 1.8;
  polyPath(ctx, cutPts(x0 + 0.9, y0 + 0.9, x1 - 0.9, y1 - 0.9, CUT_PANEL - 0.4));
  ctx.stroke();
  ctx.restore();

  // the lockup
  drawBrandMark(ctx, x0 + 44, y0 + 52, 54);
  ctx.fillStyle = INK;
  ctx.font = font(26, F.d7);
  tracked(ctx, "DEXVRA", x0 + 116, y0 + 76, 7);
  ctx.fillStyle = "#78C8FF";
  ctx.font = font(17, F.d5);
  tracked(ctx, "dexvra.io", x0 + 117, y0 + 102, 1.5);

  // TOP / the crystal numeral / GAINERS
  const label = (text, y, track) => {
    ctx.save();
    ctx.font = font(58, F.d7);
    ctx.shadowColor = "rgba(0,0,0,0.5)"; ctx.shadowBlur = 10; ctx.shadowOffsetY = 6;
    const cap = capOf(ctx);
    ctx.fillStyle = lin(ctx, 0, y - cap, 0, y, SILVER);
    tracked(ctx, text, cx, y, track, "c");
    ctx.restore();
  };
  label("TOP", y0 + 268, 22);
  const digits = String(n);
  const meas = layer(cv, 10, 10).ctx;
  let px = digits.length === 1 ? 400 : 330;
  meas.font = font(px, F.d7);
  while (trackedW(meas, digits, -8) > w - 70 && px > 160) { px -= 10; meas.font = font(px, F.d7); }
  const num = numeral(cv, digits, px);
  const base = y0 + 268 + 40 + num.cap;
  const nx = cx - num.w / 2 - num.pad;
  const ny = base - num.cap - num.pad;
  ctx.save();
  ctx.shadowColor = "rgba(41,98,255,0.85)"; ctx.shadowBlur = 60;
  ctx.drawImage(num.c, nx, ny, num.bw, num.bh);
  ctx.restore();
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.45)"; ctx.shadowBlur = 16; ctx.shadowOffsetY = 12;
  ctx.drawImage(num.c, nx, ny, num.bw, num.bh);
  ctx.restore();
  label("GAINERS", base + 104, 14);

  // the date, when the operator shows one ("" hides it)
  const parts = String(dateText || "").split("·").map((s) => s.trim()).filter(Boolean);
  if (parts.length) {
    const yd = y1 - 150;
    const day = parts.length >= 3 ? parts[0].toUpperCase() : "";
    const date = (parts.length >= 3 ? `${parts[1]}, ${parts[2]}` : parts.join(" ")).toUpperCase();
    for (const s of [-1, 1]) {
      const gx = s < 0 ? cx - 170 : cx + 20;
      ctx.fillStyle = lin(ctx, gx, 0, gx + 150, 0, s < 0 ? [[0, "rgba(78,156,255,0)"], [1, "rgba(78,156,255,0.6)"]] : [[0, "rgba(78,156,255,0.6)"], [1, "rgba(78,156,255,0)"]]);
      ctx.fillRect(gx, yd - 44, 150, 1);
    }
    ctx.fillStyle = "rgba(120,200,255,0.9)";
    ctx.beginPath(); ctx.moveTo(cx, yd - 51); ctx.lineTo(cx + 7, yd - 44); ctx.lineTo(cx, yd - 37); ctx.lineTo(cx - 7, yd - 44); ctx.closePath(); ctx.fill();
    if (day) {
      ctx.fillStyle = DIM;
      ctx.font = font(17, F.d6);
      tracked(ctx, day, cx, yd, 7, "c");
    }
    ctx.fillStyle = INK;
    const fit = fitFont(ctx, date, w - 80, 22, 13, F.d6);
    ctx.font = font(fit.px, F.d6);
    tracked(ctx, fit.text, cx, yd + 34, 4, "c");
  }

  // the LIVE chip
  ctx.font = font(16, F.d7);
  const chip = "LIVE  ·  24H";
  const tw = trackedW(ctx, chip, 4);
  const cw = tw + 70;
  const ch = 40;
  const chx = cx - cw / 2;
  const chy = y1 - 64;
  ctx.fillStyle = "rgba(14,30,76,0.95)";
  polyPath(ctx, cutPts(chx, chy, chx + cw, chy + ch, 10)); ctx.fill();
  ctx.strokeStyle = "rgba(110,190,255,0.6)";
  ctx.lineWidth = 1.3;
  polyPath(ctx, cutPts(chx + 0.6, chy + 0.6, chx + cw - 0.6, chy + ch - 0.6, 9.6)); ctx.stroke();
  ctx.fillStyle = ICE;
  tracked(ctx, chip, chx + 44, chy + ch / 2 + capOf(ctx) / 2, 4);
  return { num, numXY: [nx, ny], live: [chx + 24, chy + ch / 2] };
}

/** A gem-cut glass card on its own sprite. */
function card(cv, box, hero) {
  const [x0, y0, x1, y1] = box;
  const ox = Math.floor((x0 - PAD) * K);
  const oy = Math.floor((y0 - PAD) * K);
  const L = layer(cv, (x1 - x0 + 2 * PAD) * K + 2, (y1 - y0 + 2 * PAD) * K + 2, ox / K, oy / K);
  const ctx = L.ctx;
  const pts = cutPts(x0, y0, x1, y1, CUT);
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.65)"; ctx.shadowBlur = 40; ctx.shadowOffsetY = 18;
  ctx.fillStyle = hero ? "#0A1638" : "#0C1222";
  polyPath(ctx, pts); ctx.fill();
  if (hero) {
    ctx.shadowColor = "rgba(41,98,255,0.36)"; ctx.shadowBlur = 64; ctx.shadowOffsetY = 0;
    ctx.fill();
  }
  ctx.restore();
  ctx.save();
  polyPath(ctx, pts);
  ctx.fillStyle = lin(ctx, 0, y0, 0, y1, hero ? [[0, "#122456"], [1, "#070D20"]] : [[0, "#0F162A"], [1, "#080C19"]]);
  ctx.fill();
  ctx.clip();
  const kw = (x1 - x0) * 0.55;
  ctx.translate((x0 + x1) / 2, y0);
  ctx.scale(1, ((y1 - y0) * 0.6) / kw);
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, kw);
  g.addColorStop(0, hero ? "rgba(70,130,255,0.20)" : "rgba(90,120,190,0.10)");
  g.addColorStop(1, "rgba(70,130,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(-kw, -kw, kw * 2, kw * 2);
  ctx.restore();
  ctx.save();
  ctx.lineWidth = 1.6;
  ctx.lineJoin = "round";
  if (hero) {
    ctx.globalAlpha = 0.9;
    ctx.strokeStyle = lin(ctx, x0, y0, x1, y1, [[0, "#96D2FF"], [0.45, "#4682FF"], [1, "#1E3C8C"]]);
  } else {
    ctx.globalAlpha = 0.24;
    ctx.strokeStyle = lin(ctx, 0, y0, 0, y1, [[0, "#BED2F0"], [1, "#3C4C6E"]]);
  }
  polyPath(ctx, cutPts(x0 + 0.8, y0 + 0.8, x1 - 0.8, y1 - 0.8, CUT - 0.3));
  ctx.stroke();
  // a bright facet on the cut corner
  ctx.globalAlpha = hero ? 0.9 : 0.55;
  ctx.strokeStyle = "#C8EBFF";
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(x0, y0 + CUT); ctx.lineTo(x0 + CUT, y0); ctx.stroke();
  ctx.restore();
  return { c: L.c, ctx, ox, oy, pts };
}

// ── the board builder ───────────────────────────────────────────────────────
function build(cv, coins, { dateText = "", showPct = true }) {
  const n = coins.length;
  const top = Math.max(0, ...coins.map(pctNum).filter((v) => v != null && v > 0));
  const frac = (c) => { const v = pctNum(c); return v != null && v > 0 && top > 0 ? clamp(v / top) : 0; };

  const BG = layer(cv, OUT_W, OUT_H);
  backdrop(BG.ctx);
  const panel = drawPanel(cv, BG.ctx, { n, dateText });

  const items = [];
  let heroRing = null;
  // gain figure: drawn at (x, y) in design units onto any design-space context
  const gainFig = (c, x, y, px, align, glow) => {
    if (!showPct || !hasPct(c)) return null;
    const v = pctNum(c);
    const full = c.pctLabel;
    return (ctx, t, a) => {
      const label = t >= 1 || v == null ? full : fmtPct(v * easeOut(t)) || full;
      ctx.save();
      ctx.globalAlpha = a;
      ctx.font = font(px, F.d7);
      if (glow) { ctx.shadowColor = glow; ctx.shadowBlur = 22; }
      gradText(ctx, label, x, y, v != null && v < 0 ? LOSS : GAIN, align);
      ctx.restore();
    };
  };
  const barFig = (c, bx0, bx1, cy, h) => {
    const f = frac(c);
    if (!showPct || !(f > 0) || bx1 <= bx0) return null;
    const L = bx1 - bx0;
    return (ctx, t, a) => {
      if (!(t > 0)) return;
      const fl = Math.max(h, L * f * easeOut(t));
      ctx.save();
      ctx.globalAlpha = a;
      ctx.shadowColor = "rgba(78,156,255,0.5)"; ctx.shadowBlur = 10;
      ctx.fillStyle = lin(ctx, bx0, 0, bx0 + L, 0, BAR);
      roundRect(ctx, bx0, cy - h / 2, fl, h, h / 2); ctx.fill();
      ctx.restore();
    };
  };
  const track = (ctx, bx0, bx1, cy, h) => {
    if (!showPct) return;
    ctx.fillStyle = "rgba(255,255,255,0.07)";
    roundRect(ctx, bx0, cy - h / 2, bx1 - bx0, h, h / 2); ctx.fill();
  };

  function add(box, hero, content) {
    const s = card(cv, box, hero);
    const figs = content(s.ctx, box).filter(Boolean);
    const fin = cv.createCanvas(s.c.width, s.c.height);
    const fctx = fin.getContext("2d");
    fctx.drawImage(s.c, 0, 0);
    fctx.setTransform(K, 0, 0, K, -s.ox, -s.oy);
    for (const f of figs) f(fctx, 1, 1);
    items.push({ body: s.c, final: fin, ox: s.ox, oy: s.oy, figs, box, pts: s.pts, hero, order: items.length });
  }

  // the leader on the wide spotlight card
  function heroCard(ctx, box) {
    const c = coins[0];
    const [x0, y0, x1, y1] = box;
    const w = x1 - x0, h = y1 - y0;
    const k = Math.min(1.12, h / 400);
    const mid = y0 + h / 2;
    ctx.save();
    polyPath(ctx, cutPts(x0, y0, x1, y1, CUT)); ctx.clip();
    gemWatermark(ctx, x0 + w * 0.66, mid - 40 * k, 17 * k, 0.1);
    ctx.restore();
    const d = 200 * k;
    const cx = x0 + 64 * k + d / 2;
    drawCoin(ctx, c, cx, mid, d, 1, { ring: 4.5 * k, glow: 0.55 });
    heroRing = [cx, mid, d / 2 + 4.5 * k];
    const tx = cx + d / 2 + 52 * k;
    const right = x1 - 56 * k;
    const figs = [];
    let gainW = 0;
    if (showPct && hasPct(c)) {
      const f = fitFont(ctx, c.pctLabel, (right - tx) * 0.5, 128 * k, 56 * k, F.d7);
      ctx.font = font(f.px, F.d7);
      gainW = ctx.measureText(c.pctLabel).width;
      figs.push(gainFig(c, right, mid + 30 * k, f.px, "right", pctNum(c) < 0 ? "rgba(255,96,122,0.55)" : "rgba(41,98,255,0.6)"));
      ctx.fillStyle = FAINT;
      ctx.font = font(15 * k, F.d6);
      tracked(ctx, "24H CHANGE", right, mid + 78 * k, 5, "r");
    }
    const room = right - gainW - 50 * k - tx;
    ctx.font = font(17 * k, F.d7);
    ctx.fillStyle = ICE;
    tracked(ctx, "01", tx, mid - 78 * k, 3);
    ctx.font = font(17 * k, F.d6);
    ctx.fillStyle = DIM;
    tracked(ctx, "/   TOP GAINER", tx + 40 * k, mid - 78 * k, 5);
    const sym = fitFont(ctx, tickerOf(c), room, 88 * k, 38 * k, F.d7);
    ctx.save();
    ctx.font = font(sym.px, F.d7);
    ctx.shadowColor = "rgba(0,0,0,0.5)"; ctx.shadowBlur = 8; ctx.shadowOffsetY = 5;
    gradText(ctx, sym.text, tx, mid + 18 * k, SILVER);
    ctx.restore();
    let yNext = mid + 58 * k;
    const nm = nameOf(c);
    if (nm) {
      const f = fitFont(ctx, nm, room, 25 * k, 15 * k, F.d5);
      ctx.font = font(f.px, F.d5);
      ctx.fillStyle = DIM;
      ctx.fillText(f.text, tx, yNext);
      yNext += 36 * k;
    }
    drawMeta(ctx, c, tx, yNext, room, 22 * k, 12 * k);
    return figs;
  }

  // Top 1: the leader alone, centred like a trophy
  function soloCard(ctx, box) {
    const c = coins[0];
    const [x0, y0, x1] = box;
    const w = x1 - x0;
    const cx = x0 + w / 2;
    ctx.save();
    polyPath(ctx, cutPts(...box, CUT)); ctx.clip();
    gemWatermark(ctx, cx, y0 + 300, 30, 0.12);
    ctx.restore();
    ctx.font = font(19, F.d6);
    ctx.fillStyle = ICE;
    tracked(ctx, "01   /   TOP GAINER", cx, y0 + 70, 6, "c");
    const d = 270;
    drawCoin(ctx, c, cx, y0 + 248, d, 1, { ring: 5, glow: 0.7 });
    heroRing = [cx, y0 + 248, d / 2 + 5];
    const sym = fitFont(ctx, tickerOf(c), w - 140, 104, 48, F.d7);
    ctx.save();
    ctx.font = font(sym.px, F.d7);
    ctx.shadowColor = "rgba(0,0,0,0.5)"; ctx.shadowBlur = 10; ctx.shadowOffsetY = 6;
    gradText(ctx, sym.text, cx, y0 + 528, SILVER, "center");
    ctx.restore();
    const nm = nameOf(c);
    if (nm) {
      const f = fitFont(ctx, nm, w - 160, 30, 16, F.d5);
      ctx.font = font(f.px, F.d5);
      ctx.fillStyle = DIM;
      ctx.textAlign = "center"; ctx.fillText(f.text, cx, y0 + 574); ctx.textAlign = "left";
    }
    const figs = [];
    if (showPct && hasPct(c)) {
      const f = fitFont(ctx, c.pctLabel, w - 160, 168, 64, F.d7);
      figs.push(gainFig(c, cx, y0 + 752, f.px, "center", pctNum(c) < 0 ? "rgba(255,96,122,0.6)" : "rgba(41,98,255,0.6)"));
    }
    drawMeta(ctx, c, cx, box[3] - 70, w - 160, 26, 14, "center");
    return figs;
  }

  // tall runner-up: rank top-left, coin centred, symbol, name, gain, bar
  function portraitCard(ctx, box, c, rank) {
    const [x0, y0, x1, y1] = box;
    const w = x1 - x0, h = y1 - y0;
    const cx = x0 + w / 2;
    ctx.font = font(19, F.d7);
    ctx.fillStyle = rankInk(rank);
    tracked(ctx, String(rank).padStart(2, "0"), x0 + 34, y0 + 52, 3);
    const meta = hasMeta(c);
    const d = Math.min(w * 0.36, h * (meta ? 0.3 : 0.34), 168);
    drawCoin(ctx, c, cx, y0 + h * (meta ? 0.29 : 0.33), d, rank, { ring: 3.5 });
    const symY = y0 + h * (meta ? 0.585 : 0.645);
    const sym = fitFont(ctx, tickerOf(c), w - 60, Math.min(54, w * 0.115), 22, F.d7);
    ctx.save();
    ctx.font = font(sym.px, F.d7);
    ctx.shadowColor = "rgba(0,0,0,0.45)"; ctx.shadowBlur = 6; ctx.shadowOffsetY = 4;
    gradText(ctx, sym.text, cx, symY, SILVER, "center");
    ctx.restore();
    let yNext = symY;
    const nm = nameOf(c);
    if (nm) {
      const f = fitFont(ctx, nm, w - 70, Math.min(22, w * 0.05), 13, F.d5);
      ctx.font = font(f.px, F.d5);
      ctx.fillStyle = DIM;
      yNext += 32;
      ctx.textAlign = "center"; ctx.fillText(f.text, cx, yNext); ctx.textAlign = "left";
    }
    if (meta) drawMeta(ctx, c, cx, yNext + 32, w - 60, Math.min(20, w * 0.048), 11, "center");
    const bx0 = x0 + 40, bx1 = x1 - 40, by = y1 - 30;
    track(ctx, bx0, bx1, by, 5);
    return [gainFig(c, cx, y0 + h * (meta ? 0.875 : 0.86), Math.min(62, w * 0.13), "center"), barFig(c, bx0, bx1, by, 5)];
  }

  // narrow, tallish runner-up (Top 6 / 7): big coin left, rank / symbol / gain stacked
  function stackedCard(ctx, box, c, rank) {
    const [x0, y0, x1, y1] = box;
    const w = x1 - x0, h = y1 - y0;
    const s = clamp(Math.min(h / 250, w / 400), 0.6, 1.3);
    const pad = 30 * s;
    const meta = hasMeta(c);
    const gain = showPct && hasPct(c);
    const cy = y0 + h / 2 - (showPct ? 12 * s : 0) - (meta ? (gain ? 16 : 12) * s : 0);
    const d = Math.min(h * 0.46, 126 * s);
    const cx = x0 + pad + d / 2;
    drawCoin(ctx, c, cx, cy, d, rank, { ring: 3 * s });
    const tx = cx + d / 2 + 24 * s;
    const room = x1 - pad - tx;
    ctx.font = font(16 * s, F.d7);
    ctx.fillStyle = rankInk(rank);
    tracked(ctx, String(rank).padStart(2, "0"), tx, cy - 50 * s + capOf(ctx) / 2, 3);
    const sym = fitFont(ctx, tickerOf(c), room, 40 * s, 16, F.d7);
    ctx.save();
    ctx.font = font(sym.px, F.d7);
    ctx.shadowColor = "rgba(0,0,0,0.4)"; ctx.shadowBlur = 6; ctx.shadowOffsetY = 4;
    gradText(ctx, sym.text, tx, cy + 6 * s, SILVER);
    ctx.restore();
    const fp = hasPct(c) ? fitFont(ctx, c.pctLabel, room, 46 * s, 18, F.d7).px : 18;
    if (meta) drawMeta(ctx, c, tx, cy + (gain ? 90 : 40) * s, room, Math.max(15, 20 * s), 11);
    const by = y1 - 28 * s;
    track(ctx, x0 + pad, x1 - pad, by, 5);
    return [gainFig(c, tx, cy + 58 * s, fp, "left"), barFig(c, x0 + pad, x1 - pad, by, 5)];
  }

  // landscape runner-up: coin left; rank, symbol, name; gain right; bar under
  function rowCard(ctx, box, c, rank) {
    const [x0, y0, x1, y1] = box;
    const w = x1 - x0, h = y1 - y0;
    if (h / w > 0.5) return stackedCard(ctx, box, c, rank);
    const s = clamp(Math.min(h / 240, w / 560), 0.55, 1.5);
    const meta = hasMeta(c);
    const cy = y0 + h / 2 - (showPct ? 8 : 0) - (meta ? 12 * s : 0);
    const d = Math.max(44, Math.min(h * 0.5, 118 * s));
    const pad = Math.max(22, 36 * s);
    const cx = x0 + pad + d / 2;
    drawCoin(ctx, c, cx, cy, d, rank, { ring: Math.max(2, 3 * s) });
    const tx = cx + d / 2 + Math.max(16, 26 * s);
    const right = x1 - pad;
    const fpx = Math.max(24, 46 * s);
    ctx.font = font(fpx, F.d7);
    const gw = showPct && hasPct(c) ? ctx.measureText(c.pctLabel).width : 0;
    const room = right - gw - Math.max(28, 44 * s) - tx;
    ctx.font = font(Math.max(12, 16 * s), F.d7);
    ctx.fillStyle = rankInk(rank);
    tracked(ctx, String(rank).padStart(2, "0"), tx, cy - Math.max(26, 50 * s) + capOf(ctx) / 2, 3);
    const nm = nameOf(c);
    const showName = Boolean(nm) && s > 0.7;
    const sym = fitFont(ctx, tickerOf(c), room, Math.max(22, 44 * s), 16, F.d7);
    ctx.save();
    ctx.font = font(sym.px, F.d7);
    const cap = capOf(ctx);
    const sy = cy + (showName ? cap * 0.35 : cap / 2);
    ctx.shadowColor = "rgba(0,0,0,0.4)"; ctx.shadowBlur = 6; ctx.shadowOffsetY = 4;
    gradText(ctx, sym.text, tx, sy, SILVER);
    ctx.restore();
    let yNext = sy;
    if (showName) {
      const f = fitFont(ctx, nm, room, 19 * s, 12, F.d5);
      ctx.font = font(f.px, F.d5);
      ctx.fillStyle = DIM;
      yNext += 30 * s;
      ctx.fillText(f.text, tx, yNext);
    }
    if (meta) drawMeta(ctx, c, tx, yNext + Math.max(28, 32 * s), right - tx, clamp(22 * s, 16, 24), 11);
    ctx.font = font(fpx, F.d7);
    const gy = cy + capOf(ctx) / 2;
    const by = y1 - Math.max(22, 34 * s);
    track(ctx, tx, right, by, 5);
    return [gainFig(c, right, gy, fpx, "right"), barFig(c, tx, right, by, 5)];
  }

  const [sx0, sy0, sx1, sy1] = STAGE;
  const [heroH, rows] = COMPOSITIONS[n] || COMPOSITIONS[10];
  if (heroH == null) {
    add([sx0, sy0, sx1, sy1], true, soloCard);
  } else {
    add([sx0, sy0, sx1, sy0 + heroH], true, heroCard);
    const topY = sy0 + heroH + GAP;
    const rh = (sy1 - topY - GAP * (rows.length - 1)) / rows.length;
    let i = 1;
    rows.forEach((cols, r) => {
      const w = (sx1 - sx0 - GAP * (cols - 1)) / cols;
      const y = topY + r * (rh + GAP);
      for (let col = 0; col < cols; col++, i++) {
        const c = coins[i];
        const rank = i + 1;
        const box = [sx0 + col * (w + GAP), y, sx0 + col * (w + GAP) + w, y + rh];
        const draw = w / rh < 1.45 ? portraitCard : rowCard;
        add(box, false, (ctx, b) => draw(ctx, b, c, rank));
      }
    });
  }

  // the resting stage: backdrop + every card with its figures, cards clipped
  // at the panel's edge (they are dealt out from under it)
  const STAGE_C = cv.createCanvas(OUT_W, OUT_H);
  const sctx = STAGE_C.getContext("2d");
  sctx.drawImage(BG.c, 0, 0);
  sctx.save();
  sctx.beginPath(); sctx.rect(Math.ceil((PANEL[2] + 2) * K), 0, OUT_W, OUT_H); sctx.clip();
  for (const it of items) sctx.drawImage(it.final, it.ox, it.oy);
  sctx.restore();

  // the light path round the spotlight card
  const hp = items[0] ? cutPts(items[0].box[0] + 1, items[0].box[1] + 1, items[0].box[2] - 1, items[0].box[3] - 1, CUT - 0.5) : [];
  const segs = [];
  let total = 0;
  hp.forEach((a, j) => {
    const b = hp[(j + 1) % hp.length];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    segs.push([a, b, total, L]);
    total += L;
  });

  const m = Math.max(1, items.length);
  return {
    bg: BG.c, stage: STAGE_C, items, panel, heroRing, segs, pathLen: total,
    stagger: m > 1 ? Math.min(0.045, (SETTLED - EXIT_END - ENTER_DUR * 1.5) / (m - 1)) : 0,
    glintStep: m > 1 ? (HOLD_END - 0.08 - 0.1 - 0.16) / (m - 1) : 0,
  };
}

// ── motion ──────────────────────────────────────────────────────────────────
function stateOf(B, it, u) {
  if (u < HOLD_END) return [1, 0, 1];
  if (u < EXIT_END) { const t = easeIn((u - HOLD_END) / (EXIT_END - HOLD_END)); return [1 - t, 46 * t, 1]; }
  const start = EXIT_END + it.order * B.stagger;
  const t = (u - start) / ENTER_DUR;
  if (t <= 0) return [0, 0, 0];
  const ft = Math.min(1, (u - start) / (ENTER_DUR * 1.5)); // figures land a beat after the card
  if (t >= 1) return [1, 0, ft];
  const e = easeOut(t);
  return [e, -110 * (1 - e), ft]; // dealt in from the panel side
}
const resting = (u) => u < HOLD_END || u >= SETTLED;

function pointAt(B, s) {
  s = ((s % B.pathLen) + B.pathLen) % B.pathLen;
  for (const [a, b, s0, L] of B.segs) {
    if (s <= s0 + L) { const t = (s - s0) / (L || 1); return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]; }
  }
  return B.segs[B.segs.length - 1][1];
}

/** Draw loop position u ∈ [0,1) of board B onto ctx (OUTPUT pixels). */
function compose(cv, ctx, B, u, scratch) {
  u = ((u % 1) + 1) % 1;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
  if (resting(u)) {
    ctx.drawImage(B.stage, 0, 0);
  } else {
    ctx.drawImage(B.bg, 0, 0);
    ctx.save();
    ctx.beginPath(); ctx.rect(Math.ceil((PANEL[2] + 2) * K), 0, OUT_W, OUT_H); ctx.clip();
    for (const it of B.items) {
      const [a, dx, ft] = stateOf(B, it, u);
      if (a <= 0.003) continue;
      const px = Math.round(dx * K);
      if (a >= 0.999 && px === 0 && ft >= 1) { ctx.drawImage(it.final, it.ox, it.oy); continue; }
      ctx.globalAlpha = a;
      ctx.drawImage(it.body, it.ox + px, it.oy);
      ctx.globalAlpha = 1;
      ctx.setTransform(K, 0, 0, K, px, 0);
      for (const f of it.figs) f(ctx, ft, a);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    }
    ctx.restore();
  }
  ctx.setTransform(K, 0, 0, K, 0, 0);
  numeralShine(ctx, B, u, scratch);
  if (u < HOLD_END) { glints(ctx, B, u); sparkleAt(ctx, B, u); }
  if (resting(u)) lightRun(ctx, B, u);
  livePulse(ctx, B, u);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

function numeralShine(ctx, B, u, scratch) {
  const { num, numXY } = B.panel;
  for (const s0 of [0.04, 0.7]) {
    if (!(u >= s0 && u < s0 + 0.14)) continue;
    const t = (u - s0) / 0.14;
    const sx = scratch.getContext("2d");
    sx.setTransform(1, 0, 0, 1, 0, 0);
    sx.globalCompositeOperation = "source-over";
    sx.clearRect(0, 0, scratch.width, scratch.height);
    sx.setTransform(K, 0, 0, K, 0, 0);
    const bx = -140 + (num.bw + 280) * easeIO(t);
    const g = sx.createLinearGradient(bx - 60, 0, bx + 60, num.bh * 0.3);
    g.addColorStop(0, "rgba(255,255,255,0)");
    g.addColorStop(0.5, `rgba(255,255,255,${0.75 * Math.sin(Math.PI * t)})`);
    g.addColorStop(1, "rgba(255,255,255,0)");
    sx.fillStyle = g;
    sx.fillRect(0, 0, num.bw, num.bh);
    sx.setTransform(1, 0, 0, 1, 0, 0);
    sx.globalCompositeOperation = "destination-in";
    sx.drawImage(num.mask, 0, 0);
    sx.globalCompositeOperation = "source-over";
    ctx.drawImage(scratch, 0, 0, num.mask.width, num.mask.height, numXY[0], numXY[1], num.bw, num.bh);
  }
}

function glints(ctx, B, u) {
  for (const it of B.items) {
    const s0 = 0.1 + it.order * B.glintStep;
    if (!(u >= s0 && u < s0 + 0.16)) continue;
    const t = (u - s0) / 0.16;
    const [x0, y0, x1, y1] = it.box;
    const h = y1 - y0;
    const bx = x0 - h * 0.5 - 140 + (x1 - x0 + h * 0.5 + 280) * easeIO(t);
    ctx.save();
    polyPath(ctx, it.pts); ctx.clip();
    const g = ctx.createLinearGradient(bx, y0, bx + 120 + h * 0.3, y1);
    const a = (it.hero ? 0.1 : 0.08) * Math.sin(Math.PI * t);
    g.addColorStop(0, "rgba(220,236,255,0)");
    g.addColorStop(0.5, `rgba(220,236,255,${a})`);
    g.addColorStop(1, "rgba(220,236,255,0)");
    ctx.fillStyle = g;
    ctx.fillRect(x0, y0, x1 - x0, h);
    ctx.restore();
  }
}

function sparkleAt(ctx, B, u) {
  if (!B.heroRing) return;
  const [cx, cy, r] = B.heroRing;
  const sx = cx + r * Math.cos(-48 * Math.PI / 180);
  const sy = cy + r * Math.sin(-48 * Math.PI / 180);
  for (const c0 of [0.22, 0.46]) {
    if (!(u >= c0 && u < c0 + 0.08)) continue;
    const k = Math.sin((Math.PI * (u - c0)) / 0.08);
    const size = 56 * (0.4 + 0.6 * k);
    ctx.save();
    const g = ctx.createRadialGradient(sx, sy, 0, sx, sy, size);
    g.addColorStop(0, `rgba(78,156,255,${0.6 * k})`);
    g.addColorStop(1, "rgba(78,156,255,0)");
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(sx, sy, size, 0, TAU); ctx.fill();
    ctx.fillStyle = `rgba(255,255,255,${k})`;
    drawStar(ctx, sx, sy, size / 2);
    ctx.restore();
  }
}

function lightRun(ctx, B, u) {
  if (!B.pathLen) return;
  const head = u * B.pathLen;
  const tail = 420;
  const steps = 30;
  ctx.save();
  ctx.lineCap = "round";
  ctx.shadowColor = "rgba(78,156,255,0.9)";
  ctx.shadowBlur = 14;
  let prev = pointAt(B, head - tail);
  for (let i = 1; i <= steps; i++) {
    const p = pointAt(B, head - tail + (tail * i) / steps);
    ctx.strokeStyle = `rgba(214,236,255,${0.85 * Math.pow(i / steps, 2)})`;
    ctx.lineWidth = 2.6;
    ctx.beginPath(); ctx.moveTo(prev[0], prev[1]); ctx.lineTo(p[0], p[1]); ctx.stroke();
    prev = p;
  }
  ctx.restore();
}

function livePulse(ctx, B, u) {
  const [cx, cy] = B.panel.live;
  const ph = (u * 4) % 1;
  ctx.save();
  ctx.strokeStyle = `rgba(120,220,255,${0.75 * Math.pow(1 - ph, 1.5)})`;
  ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.arc(cx, cy, 5 + 11 * ph, 0, TAU); ctx.stroke();
  ctx.fillStyle = "#78DCFF";
  ctx.beginPath(); ctx.arc(cx, cy, 5, 0, TAU); ctx.fill();
  ctx.restore();
}

// ── public API ──────────────────────────────────────────────────────────────
const isTemplate = (id) => Object.prototype.hasOwnProperty.call(TEMPLATES, id);
const countOf = (id) => (TEMPLATES[id] ? TEMPLATES[id].n : 0);
const labelOf = (id) => (TEMPLATES[id] ? TEMPLATES[id].label : String(id));
const buttonOf = (id) => (TEMPLATES[id] ? TEMPLATES[id].button : String(id));

/** The coins this render may draw: COPIES, the hidden figures removed, the %
 *  label made once (the caption's own formatter). */
function prepare(coins, n, { showPct, showMcap, showPrice }) {
  return (coins || []).filter(Boolean).slice(0, n).map((c) => ({
    ...c,
    ...(showMcap === false ? { mcap: null } : {}),
    ...(showPrice === false ? { price: null } : {}),
    pctLabel: showPct === false ? "" : fmtPct(c.pct),
  }));
}

async function decodeLogos(cv, list) {
  await Promise.all(list.map(async (c) => {
    c.img = null;
    if (!c.logo) return;
    try { c.img = await cv.loadImage(c.logo); } catch { c.img = null; }
  }));
}

/** Build the board for a template, or null when there is nothing to draw. */
async function board({ template, coins, dateText = "", showPct = true, showMcap = true, showPrice = true }) {
  const cv = kit.canvasLib();
  if (!cv || !isTemplate(template)) return null;
  const list = prepare(coins, countOf(template), { showPct, showMcap, showPrice });
  if (!list.length) return null;
  await decodeLogos(cv, list);
  return { cv, B: build(cv, list, { dateText, showPct: showPct !== false }), n: list.length };
}

/** The still (= frame 0). PNG Buffer, or null. Never throws. */
async function still(o) {
  try {
    const b = await board(o);
    if (!b) return null;
    const out = b.cv.createCanvas(OUT_W, OUT_H);
    compose(b.cv, out.getContext("2d"), b.B, 0, b.cv.createCanvas(4, 4));
    return toSendBuffer(out);
  } catch (e) {
    log.warn(`[prism] ${o && o.template} still failed: ${e.message}`);
    return null;
  }
}

/** Frames as RGBA buffers — the test seam (`us` = loop positions). */
async function frames(o, us) {
  const b = await board(o);
  if (!b) return null;
  const out = b.cv.createCanvas(OUT_W, OUT_H);
  const ctx = out.getContext("2d");
  const scratch = b.cv.createCanvas(Math.ceil(b.B.panel.num.bw * K) + 2, Math.ceil(b.B.panel.num.bh * K) + 2);
  const list = [];
  for (const u of us) {
    compose(b.cv, ctx, b.B, u, scratch);
    list.push(Buffer.from(out.data()));
  }
  return list;
}

function ffmpegPath() {
  try {
    return require("@ffmpeg-installer/ffmpeg").path;
  } catch {
    return null;
  }
}

/** An ffmpeg turning piped RGBA frames into a silent, looping-friendly MP4. */
function encoder(outPath, fps) {
  const bin = ffmpegPath();
  if (!bin) throw new Error("ffmpeg unavailable");
  const p = spawn(bin, [
    "-y", "-loglevel", "error",
    "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${OUT_W}x${OUT_H}`, "-r", String(fps), "-i", "pipe:0",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
    "-movflags", "+faststart", "-an", outPath,
  ], { stdio: ["pipe", "ignore", "pipe"] });
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

const TMP_PREFIX = "dexvra-prism-";

/**
 * Render a Prism board for posting.
 *
 * @returns {Promise<null | {media: Buffer, mediaType: "animation", ext: "mp4", still: Buffer}>}
 *   `still` is frame 0 as a PNG — the X tweet and anything that needs a
 *   picture read it. null on ANY failure (no canvas, no ffmpeg, no coins).
 */
async function render(o = {}) {
  const t0 = Date.now();
  let file = null;
  try {
    const b = await board(o);
    if (!b) return null;
    const { cv, B } = b;
    const out = cv.createCanvas(OUT_W, OUT_H);
    const ctx = out.getContext("2d");
    const scratch = cv.createCanvas(Math.ceil(B.panel.num.bw * K) + 2, Math.ceil(B.panel.num.bh * K) + 2);
    compose(cv, ctx, B, 0, scratch);
    const stillPng = toSendBuffer(out);
    const fps = Number(o.fps) > 0 ? Number(o.fps) : FPS;
    const count = Number(o.frames) > 0 ? Math.round(Number(o.frames)) : Math.round(fps * SECONDS);
    file = path.join(os.tmpdir(), `${TMP_PREFIX}${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}.mp4`);
    const enc = encoder(file, fps);
    try {
      for (let f = 0; f < count; f++) {
        compose(cv, ctx, B, f / count, scratch);
        // canvas.data() is a LIVE view: the write must land before the next frame
        await enc.write(out.data());
        await new Promise((r) => setImmediate(r)); // let the bot answer between frames
      }
    } catch (e) {
      enc.kill();
      throw e;
    }
    await enc.end();
    const media = fss.readFileSync(file);
    log.info(`[prism] ${o.template} rendered in ${Date.now() - t0}ms (${b.n} coins, ${Math.round(media.length / 1024)} KB)`);
    return { media, mediaType: "animation", ext: "mp4", still: stillPng };
  } catch (e) {
    log.warn(`[prism] ${o && o.template} render failed after ${Date.now() - t0}ms: ${e.message}`);
    return null;
  } finally {
    if (file) fss.promises.unlink(file).catch(() => {});
  }
}

module.exports = {
  IDS,
  TEMPLATES,
  COMPOSITIONS,
  NAMES,
  OUT_W,
  OUT_H,
  FPS,
  SECONDS,
  FRAMES,
  isTemplate,
  countOf,
  labelOf,
  buttonOf,
  still,
  render,
  available: () => Boolean(kit.canvasLib() && ffmpegPath()),
  // exposed for tests / the preview script
  _internals: { frames, board, prepare, PANEL, STAGE, COMPOSITIONS },
};
