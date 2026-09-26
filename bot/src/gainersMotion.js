"use strict";
// Top-Gainers MOTION banners — the same live board as gainersBanner.js, drawn
// as a short looping MP4 that Telegram plays as a GIF.
//
// "saya igin versi gif atau vidio bukan gambar lgi … top 1 sampai top 10 dengan
// style ui ux berbeda". Ten layouts, one per board size, and each one moves in
// its own way — a spotlight, a face-off, a podium that rises, cards that flip,
// a bar race, an orbit, a sliding stack, a neon grid, a split-flap departure
// board and a bubble chart. They are not ten recolours of one card: a channel
// posting a different one each day should read as a different post each day.
//
// Rules this file shares with the still banners, and why:
//   · every figure is the live one the coin carries — a count-up ANIMATES to
//     the real number and never lands anywhere else;
//   · `showPct:false` removes the figure AND every drawing of it (the bar
//     race's bar is the percentage drawn as length, the bubble size is the
//     percentage drawn as area) — a hidden number must not be published by
//     another route;
//   · every token draws its real logo, or its jewel monogram when none could be
//     fetched — never an empty disc;
//   · no chain text on the artwork (the caption names the chain);
//   · render() never throws: a banner that cannot be drawn returns null and the
//     caller says so, rather than a crash taking the admin panel down with it.
//
// Frames are drawn with @napi-rs/canvas and piped to ffmpeg as raw RGBA. The
// loop is seamless: the backdrop's motion is periodic in the clip length, and
// the content fades out at the end back to the empty backdrop it builds up
// from on frame 0 — so Telegram's autoplay loop has no visible seam.
const fss = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const kit = require("./helpers/canvasKit");
const { F, SITE, drawBrandMark, roundRect, hexA, fitText } = kit;
const { fmtPct, fmtCap, fmtPrice } = require("./helpers/format");
const log = require("./helpers/logger");

const W = 1280;
const H = 720;
const num = (v, d, lo, hi) => {
  // Blank is ABSENT, never 0 — Number('') is 0, and 0 fps is no clip at all.
  if (v === undefined || v === null || String(v).trim() === "") return d;
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d;
};
const FPS = num(process.env.GAINERS_MOTION_FPS, 30, 12, 60);
const SECONDS = num(process.env.GAINERS_MOTION_SECONDS, 6, 3, 12);
const ENCODE_TIMEOUT_MS = 120_000;

// Dexvra's live brand ("Privé", src/app/globals.css): graphite-navy ground,
// the cyan accent for chrome, MINT reserved for gains and the LIVE mark.
const ACC = "#26C6F5";
const ACC_DEEP = "#0E9BD8";
const ACC_HI = "#8FE4FF";
const MINT = SITE.mint;
const GOLD = "#F5C451";
const SILVER = "#C9D3E0";
const BRONZE = "#D9955B";
const INK = "#F1F5FB";
const MUTED = "#9AA6BC";
const FAINT = "#66738C";
const metalOf = (rank) => (rank === 1 ? GOLD : rank === 2 ? SILVER : rank === 3 ? BRONZE : ACC);

// ── easing ──────────────────────────────────────────────────────────────────
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const prog = (t, a, d) => clamp01((t - a) / d);
const outCubic = (p) => 1 - Math.pow(1 - p, 3);
const outExpo = (p) => (p >= 1 ? 1 : 1 - Math.pow(2, -10 * p));
const outBack = (p) => {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2);
};
const inOut = (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);
const lerp = (a, b, p) => a + (b - a) * p;
const TAU = Math.PI * 2;

// ── templates ───────────────────────────────────────────────────────────────
const TEMPLATES = [
  { id: "v1", n: 1, label: "🎬 Spotlight", blurb: "One token under a rotating ring, the gain counting up", layout: "spotlight", bg: "rings" },
  { id: "v2", n: 2, label: "🎬 Face-off", blurb: "Two panels slam in from the sides, VS on the seam", layout: "faceoff", bg: "diag" },
  { id: "v3", n: 3, label: "🎬 Podium Rise", blurb: "Plinths rise, the top three land on them", layout: "podium", bg: "rays" },
  { id: "v4", n: 4, label: "🎬 Card Flip", blurb: "Four cards flip face-up one by one", layout: "cards", bg: "grid" },
  { id: "v5", n: 5, label: "🎬 Bar Race", blurb: "Bars race out to each token's real gain", layout: "bars", bg: "scan" },
  { id: "v6", n: 6, label: "🎬 Orbit", blurb: "The leader in the centre, the rest in orbit", layout: "orbit", bg: "stars" },
  { id: "v7", n: 7, label: "🎬 Stack", blurb: "Rows slide in beside a giant TOP 7", layout: "stack", bg: "dots" },
  { id: "v8", n: 8, label: "🎬 Neon Grid", blurb: "Eight tiles pop in, light tracing their edges", layout: "neon", bg: "horizon" },
  { id: "v9", n: 9, label: "🎬 Split-Flap", blurb: "A departure board flipping into the ranking", layout: "flap", bg: "blueprint" },
  { id: "v10", n: 10, label: "🎬 Bubbles", blurb: "Ten bubbles sized by their gain, floating", layout: "bubbles", bg: "waves" },
];
const TEMPLATE_IDS = TEMPLATES.map((t) => t.id);
const specOf = (id) => TEMPLATES.find((t) => t.id === id) || null;
const isTemplate = (id) => Boolean(specOf(id));
const countOf = (id) => (specOf(id) ? specOf(id).n : 0);
const labelOf = (id) => (specOf(id) ? specOf(id).label : String(id));

/** Resolve "random" (from `pool`, or every motion layout) to a concrete id. */
function pickTemplate(id, { pool = [], rng = Math.random } = {}) {
  if (isTemplate(id)) return id;
  const from = (Array.isArray(pool) ? pool : []).filter(isTemplate);
  const list = from.length ? from : TEMPLATE_IDS;
  return list[Math.floor(rng() * list.length) % list.length];
}

// ── shared drawing ──────────────────────────────────────────────────────────
function drawCover(ctx, img, x, y, w, h) {
  const s = Math.max(w / img.width, h / img.height);
  ctx.drawImage(img, x + (w - img.width * s) / 2, y + (h - img.height * s) / 2, img.width * s, img.height * s);
}

/** The token's logo in a circle, or its jewel monogram — never an empty disc. */
function avatar(ctx, c, cx, cy, d, { ring = null, ringW = 3, glow = 0 } = {}) {
  const r = d / 2;
  if (glow > 0) {
    ctx.save();
    ctx.shadowColor = hexA(ring || ACC, 0.6 * glow);
    ctx.shadowBlur = d * 0.35;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, TAU);
    ctx.fillStyle = "#0A0E16";
    ctx.fill();
    ctx.restore();
  }
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, TAU);
  ctx.clip();
  ctx.fillStyle = "#0A0E16";
  ctx.fillRect(cx - r, cy - r, d, d);
  if (c.img) {
    drawCover(ctx, c.img, cx - r, cy - r, d, d);
  } else {
    const { jewelFor, monogramOf } = require("./gainersBanner")._internals;
    const [, c1, c2] = jewelFor(c.symbol);
    const g = ctx.createLinearGradient(cx, cy - r, cx, cy + r);
    g.addColorStop(0, c1);
    g.addColorStop(1, c2);
    ctx.fillStyle = g;
    ctx.fillRect(cx - r, cy - r, d, d);
    ctx.fillStyle = "rgba(241,245,251,.95)";
    ctx.font = `700 ${Math.round(d * 0.36)}px ${F.d7}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(monogramOf(c.symbol), cx, cy + d * 0.02);
  }
  ctx.restore();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, TAU);
  ctx.lineWidth = ring ? ringW : Math.max(1.5, d / 60);
  ctx.strokeStyle = ring || "rgba(255,255,255,.16)";
  ctx.stroke();
}

function text(ctx, s, x, y, { font, color = INK, align = "left", baseline = "alphabetic" } = {}) {
  if (font) ctx.font = font;
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.textBaseline = baseline;
  ctx.fillText(s, x, y);
}

/** Uppercase mono micro-label with tracking — the site's `.nav-label` voice. */
function micro(ctx, s, x, y, { size = 13, color = FAINT, align = "left", track = 0.2, weight = 700 } = {}) {
  ctx.save();
  ctx.font = `${weight} ${size}px ${weight >= 800 ? F.m8 : F.m7}`;
  ctx.fillStyle = color;
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";
  const chars = [...String(s).toUpperCase()];
  const sp = size * track;
  const widths = chars.map((ch) => ctx.measureText(ch).width);
  const total = widths.reduce((a, b) => a + b, 0) + sp * Math.max(0, chars.length - 1);
  let px = align === "center" ? x - total / 2 : align === "right" ? x - total : x;
  chars.forEach((ch, i) => {
    ctx.fillText(ch, px, y);
    px += widths[i] + sp;
  });
  ctx.restore();
  return total;
}

const tickerOf = (c) => `$${String(c.symbol || "").replace(/^\$+/, "")}`;
/** The live gain, animated towards itself. `p` is the count-up progress: at 1
 *  the label is EXACTLY fmtPct(c.pct) — a count-up that lands elsewhere is a
 *  number nobody measured. */
function pctOf(o, c, p = 1) {
  if (!o.showPct) return "";
  // Absence before the parse: Number(null) is 0, and 0 is finite — an
  // unreadable change would count up to a confident "0.0%".
  if (c.pct === null || c.pct === undefined || c.pct === "") return "";
  const v = Number(c.pct);
  if (!Number.isFinite(v)) return "";
  // Nothing before the count starts: a "0.0%" frame is a figure nobody measured.
  if (p <= 0) return "";
  return p >= 1 ? fmtPct(v) : fmtPct(v * outExpo(clamp01(p)));
}

function panel(ctx, x, y, w, h, r, { fill = "rgba(16,22,36,.82)", stroke = "rgba(255,255,255,.08)", lw = 1 } = {}) {
  roundRect(ctx, x, y, w, h, r);
  ctx.fillStyle = fill;
  ctx.fill();
  if (stroke) {
    ctx.lineWidth = lw;
    ctx.strokeStyle = stroke;
    ctx.stroke();
  }
}

function chip(ctx, x, y, label, value, { color = INK } = {}) {
  ctx.font = `700 18px ${F.m7}`;
  const vw = ctx.measureText(value).width;
  ctx.font = `700 11px ${F.m7}`;
  const lw = ctx.measureText(label).width + label.length * 2.2;
  const w = 28 + lw + 10 + vw;
  panel(ctx, x, y, w, 40, 20, { fill: "rgba(255,255,255,.04)", stroke: "rgba(255,255,255,.10)" });
  micro(ctx, label, x + 14, y + 25, { size: 11, color: FAINT, track: 0.2 });
  text(ctx, value, x + 14 + lw + 10, y + 27, { font: `700 18px ${F.m7}`, color });
  return w;
}

/** "TOP n" + an accent "GAINERS" word, revealed left to right. */
function title(ctx, t, x, y, n, { size = 46, align = "left", start = 0.1 } = {}) {
  const p = outCubic(prog(t, start, 0.7));
  if (p <= 0) return;
  ctx.save();
  ctx.globalAlpha *= p;
  ctx.font = `800 ${size}px ${F.x}`;
  const a = `TOP ${n} `;
  const b = "GAINERS";
  const wa = ctx.measureText(a).width;
  const wb = ctx.measureText(b).width;
  const x0 = align === "center" ? x - (wa + wb) / 2 : x;
  const dy = (1 - p) * 18;
  text(ctx, a, x0, y + dy, { color: INK });
  const g = ctx.createLinearGradient(x0 + wa, 0, x0 + wa + wb, 0);
  g.addColorStop(0, ACC_HI);
  g.addColorStop(0.5, ACC);
  g.addColorStop(1, ACC_DEEP);
  text(ctx, b, x0 + wa, y + dy, { color: g });
  ctx.restore();
}

// ── backdrop ────────────────────────────────────────────────────────────────
// Geometry, not blobs: the soft-orb look is what got the first promo video
// called "udh kaya ai". One restrained glow at most, the rest is line work at a
// few percent alpha. Every motion here is periodic in the clip length (`ph`
// runs 0→1 over the clip) so the loop has no seam.
function backdrop(ctx, style, ph, bgImg) {
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, "#0B1120");
  g.addColorStop(1, "#06090F");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  if (bgImg) {
    drawCover(ctx, bgImg, 0, 0, W, H);
    ctx.fillStyle = "rgba(7,10,16,.74)";
    ctx.fillRect(0, 0, W, H);
  }
  ctx.save();
  ctx.lineWidth = 1;
  switch (style) {
    case "grid": {
      const s = 64;
      const off = ph * s;
      ctx.strokeStyle = "rgba(255,255,255,.035)";
      for (let x = -s + (off % s); x < W + s; x += s) line(ctx, x, 0, x, H);
      for (let y = -s + (off % s); y < H + s; y += s) line(ctx, 0, y, W, y);
      break;
    }
    case "dots": {
      const s = 28;
      const sweep = ph * (W + 400) - 200;
      for (let y = 14; y < H; y += s) {
        for (let x = 14; x < W; x += s) {
          const k = Math.max(0, 1 - Math.abs(x - sweep) / 220);
          ctx.fillStyle = `rgba(143,228,255,${0.05 + 0.13 * k})`;
          ctx.fillRect(x - 1, y - 1, 2, 2);
        }
      }
      break;
    }
    case "rays": {
      const n = 16;
      ctx.translate(W / 2, -120);
      ctx.rotate(ph * (TAU / n));
      for (let i = 0; i < n; i++) {
        ctx.rotate(TAU / n);
        const gr = ctx.createLinearGradient(0, 0, 0, H + 200);
        gr.addColorStop(0, "rgba(38,198,245,.10)");
        gr.addColorStop(1, "rgba(38,198,245,0)");
        ctx.fillStyle = gr;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(-40, H + 300);
        ctx.lineTo(40, H + 300);
        ctx.closePath();
        ctx.fill();
      }
      break;
    }
    case "rings": {
      const s = 70;
      const cx = 380;
      const cy = 390;
      for (let i = 0; i < 16; i++) {
        const r = i * s + ph * s;
        ctx.strokeStyle = `rgba(143,228,255,${0.07 * Math.max(0, 1 - r / 1000)})`;
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, TAU);
        ctx.stroke();
      }
      break;
    }
    case "scan": {
      ctx.fillStyle = "rgba(255,255,255,.018)";
      for (let y = 0; y < H; y += 4) ctx.fillRect(0, y, W, 1);
      const by = ph * (H + 200) - 100;
      const gr = ctx.createLinearGradient(0, by - 90, 0, by + 90);
      gr.addColorStop(0, "rgba(38,198,245,0)");
      gr.addColorStop(0.5, "rgba(38,198,245,.06)");
      gr.addColorStop(1, "rgba(38,198,245,0)");
      ctx.fillStyle = gr;
      ctx.fillRect(0, by - 90, W, 180);
      break;
    }
    case "diag": {
      const s = 44;
      const off = ph * s * 2;
      ctx.strokeStyle = "rgba(255,255,255,.03)";
      ctx.lineWidth = 14;
      for (let x = -H - s * 2 + (off % (s * 2)); x < W + s; x += s * 2) line(ctx, x, H, x + H, 0);
      break;
    }
    case "stars": {
      for (let i = 0; i < 120; i++) {
        const x = (i * 97.13) % W;
        const y = (i * 57.71 + (i % 7) * 13) % H;
        const tw = 0.5 + 0.5 * Math.sin(TAU * (ph * 2 + i * 0.137));
        ctx.fillStyle = `rgba(220,236,255,${0.05 + 0.2 * tw * ((i % 3) / 2)})`;
        ctx.fillRect(x, y, i % 5 === 0 ? 2 : 1.3, i % 5 === 0 ? 2 : 1.3);
      }
      break;
    }
    case "horizon": {
      const hy = 360;
      ctx.strokeStyle = "rgba(38,198,245,.07)";
      for (let i = -12; i <= 12; i++) line(ctx, W / 2 + i * 30, hy, W / 2 + i * 260, H);
      for (let k = 0; k < 10; k++) {
        const f = (k + ph) / 10;
        const y = hy + (H - hy) * f * f;
        ctx.strokeStyle = `rgba(38,198,245,${0.02 + 0.08 * f})`;
        line(ctx, 0, y, W, y);
      }
      break;
    }
    case "blueprint": {
      ctx.strokeStyle = "rgba(255,255,255,.022)";
      for (let x = 0; x < W; x += 20) line(ctx, x, 0, x, H);
      for (let y = 0; y < H; y += 20) line(ctx, 0, y, W, y);
      ctx.strokeStyle = "rgba(143,228,255,.05)";
      for (let x = 0; x < W; x += 100) line(ctx, x, 0, x, H);
      for (let y = 0; y < H; y += 100) line(ctx, 0, y, W, y);
      break;
    }
    case "waves": {
      for (let k = 0; k < 7; k++) {
        ctx.strokeStyle = `rgba(38,198,245,${0.035 + k * 0.006})`;
        ctx.beginPath();
        for (let x = 0; x <= W; x += 16) {
          const y = 470 + k * 34 + Math.sin(x / 150 + TAU * ph + k * 0.7) * (16 + k * 3);
          if (x === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
      break;
    }
    default:
      break;
  }
  ctx.restore();
  // one restrained glow, top-right, and a vignette to sink the edges
  const rg = ctx.createRadialGradient(W * 0.82, 40, 0, W * 0.82, 40, 520);
  rg.addColorStop(0, "rgba(38,198,245,.10)");
  rg.addColorStop(1, "rgba(38,198,245,0)");
  ctx.fillStyle = rg;
  ctx.fillRect(0, 0, W, H);
  const vg = ctx.createRadialGradient(W / 2, H / 2, H * 0.35, W / 2, H / 2, W * 0.75);
  vg.addColorStop(0, "rgba(0,0,0,0)");
  vg.addColorStop(1, "rgba(0,0,0,.45)");
  ctx.fillStyle = vg;
  ctx.fillRect(0, 0, W, H);
}

function line(ctx, x1, y1, x2, y2) {
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
}

function header(ctx, ph, n, dateText) {
  drawBrandMark(ctx, 40, 26, 40);
  text(ctx, "DEXVRA", 92, 55, { font: `800 24px ${F.x}` });
  ctx.fillStyle = "rgba(255,255,255,.14)";
  ctx.fillRect(210, 30, 1, 30);
  micro(ctx, n === 1 ? "Top Gainer · 24h" : `Top ${n} Gainers · 24h`, 228, 51, { size: 13, color: ACC_HI, track: 0.24 });
  // LIVE pill — the dot pulses four times per loop, so the loop has no seam
  const right = W - 40;
  const dw = dateText ? micro(ctx, dateText, right, 51, { size: 13, color: MUTED, align: "right", track: 0.16 }) + 22 : 0;
  const px = right - dw - 92;
  panel(ctx, px, 27, 84, 32, 16, { fill: "rgba(61,245,159,.08)", stroke: "rgba(61,245,159,.35)" });
  const pulse = 0.5 + 0.5 * Math.sin(TAU * ph * 4);
  ctx.beginPath();
  ctx.arc(px + 20, 43, 9 + pulse * 5, 0, TAU);
  ctx.fillStyle = `rgba(61,245,159,${0.18 * (1 - pulse)})`;
  ctx.fill();
  ctx.beginPath();
  ctx.arc(px + 20, 43, 5, 0, TAU);
  ctx.fillStyle = MINT;
  ctx.fill();
  micro(ctx, "Live", px + 34, 49, { size: 13, color: MINT, track: 0.2, weight: 800 });
  ctx.fillStyle = "rgba(255,255,255,.07)";
  ctx.fillRect(40, 84, W - 80, 1);
}

function footer(ctx) {
  const { BOT_USERNAME } = require("./config/constants");
  ctx.fillStyle = "rgba(255,255,255,.07)";
  ctx.fillRect(40, 668, W - 80, 1);
  text(ctx, "dexvra.io", 40, 700, { font: `700 18px ${F.b}` });
  micro(ctx, "Ranked by 24h change · live data", 140, 699, { size: 12, color: FAINT, track: 0.18 });
  micro(ctx, `List your token → @${BOT_USERNAME}`, W - 40, 699, { size: 12, color: ACC_HI, align: "right", track: 0.18 });
}

// ── layouts ─────────────────────────────────────────────────────────────────
// Each takes (ctx, t, coins, o) with `t` in seconds and `o` = {showPct, dur}.
// Every one adapts to FEWER coins than its size (a quiet day), and the
// multi-token shapes delegate to the layout designed for that count rather
// than stretching one lonely row across a board.

function spotlight(ctx, t, coins, o) {
  const c = coins[0];
  const cx = 360;
  const cy = 388;
  const d = 270;
  const pIn = outBack(prog(t, 0.15, 0.9));
  const ring = prog(t, 0.35, 0.7);
  ctx.save();
  ctx.globalAlpha *= ring;
  const rot = (t / o.dur) * TAU;
  for (const [rad, dir, w, seg] of [
    [168, 1, 5, 3],
    [192, -1, 2, 5],
  ]) {
    for (let k = 0; k < seg; k++) {
      const a0 = dir * rot + (k * TAU) / seg;
      const gr = ctx.createLinearGradient(cx - rad, cy, cx + rad, cy);
      gr.addColorStop(0, ACC);
      gr.addColorStop(1, MINT);
      ctx.strokeStyle = gr;
      ctx.lineWidth = w;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.arc(cx, cy, rad, a0, a0 + (TAU / seg) * 0.55);
      ctx.stroke();
    }
  }
  ctx.restore();
  ctx.save();
  ctx.globalAlpha *= prog(t, 0.15, 0.35);
  ctx.translate(cx, cy);
  ctx.scale(lerp(0.6, 1, pIn), lerp(0.6, 1, pIn));
  avatar(ctx, c, 0, 0, d, { ring: "rgba(255,255,255,.22)", ringW: 2, glow: 0.8 });
  ctx.restore();
  // #1 badge
  const bp = outBack(prog(t, 0.8, 0.5));
  if (bp > 0) {
    ctx.save();
    ctx.translate(cx + 100, cy - 104);
    ctx.scale(bp, bp);
    ctx.beginPath();
    ctx.arc(0, 0, 30, 0, TAU);
    ctx.fillStyle = GOLD;
    ctx.fill();
    text(ctx, "#1", 0, 2, { font: `800 22px ${F.x}`, color: "#2A1C02", align: "center", baseline: "middle" });
    ctx.restore();
  }
  const X = 640;
  const rev = (start, dy = 24) => {
    const p = outCubic(prog(t, start, 0.55));
    ctx.globalAlpha = p;
    return (1 - p) * dy;
  };
  ctx.save();
  let dy = rev(0.5);
  micro(ctx, "Today's top gainer · 24h", X, 236 + dy, { size: 15, color: MINT, track: 0.26 });
  dy = rev(0.65);
  const tk = fitText(ctx, tickerOf(c), 590, { weight: 800, size: 96, min: 40, family: F.x });
  text(ctx, tk, X - 4, 330 + dy, { color: INK });
  dy = rev(0.78);
  const nm = fitText(ctx, c.name || "", 580, { weight: 600, size: 26, min: 16, family: F.s });
  text(ctx, nm, X, 374 + dy, { color: MUTED });
  dy = rev(0.9);
  if (o.showPct) {
    const s = pctOf(o, c, prog(t, 0.9, 1.4));
    const g = ctx.createLinearGradient(X, 420, X, 520);
    g.addColorStop(0, "#7DFFC4");
    g.addColorStop(1, MINT);
    const f = fitText(ctx, fmtPct(c.pct), 590, { weight: 800, size: 124, min: 60, family: F.x });
    text(ctx, f.endsWith("…") ? f : s, X - 4, 520 + dy, { color: g });
  } else {
    text(ctx, "Leading today's board", X, 488 + dy, { font: `700 40px ${F.b}`, color: INK });
  }
  let cxp = X;
  const stats = [
    ["Price", c.price ? fmtPrice(c.price) : null],
    ["MCap", c.mcap ? fmtCap(c.mcap) : null],
    ["Liq", c.liq ? fmtCap(c.liq) : null],
  ].filter(([, v]) => v);
  stats.forEach(([l, v], i) => {
    rev(1.4 + i * 0.12, 16);
    cxp += chip(ctx, cxp, 568, l.toUpperCase(), v) + 12;
  });
  ctx.restore();
}

function faceoff(ctx, t, coins, o) {
  if (coins.length < 2) return spotlight(ctx, t, coins, o);
  const top = 118;
  const bot = 646;
  const sides = [
    { c: coins[0], rank: 1, cx: 330, poly: [[40, top], [668, top], [612, bot], [40, bot]], from: -760, start: 0.1 },
    { c: coins[1], rank: 2, cx: 950, poly: [[692, top], [1240, top], [1240, bot], [636, bot]], from: 760, start: 0.25 },
  ];
  for (const s of sides) {
    const p = outCubic(prog(t, s.start, 0.75));
    if (p <= 0) continue;
    ctx.save();
    ctx.translate((1 - p) * s.from, 0);
    ctx.beginPath();
    s.poly.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
    const g = ctx.createLinearGradient(0, top, 0, bot);
    g.addColorStop(0, s.rank === 1 ? "rgba(245,196,81,.10)" : "rgba(38,198,245,.07)");
    g.addColorStop(1, "rgba(13,17,25,.92)");
    ctx.fillStyle = g;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = s.rank === 1 ? hexA(GOLD, 0.55) : "rgba(255,255,255,.10)";
    ctx.stroke();
    ctx.save();
    ctx.clip();
    const m = metalOf(s.rank);
    micro(ctx, s.rank === 1 ? "#1 · Leader" : "#2 · Challenger", s.cx, 170, { size: 14, color: m, align: "center", track: 0.26 });
    avatar(ctx, s.c, s.cx, 305, 186, { ring: m, ringW: 4, glow: s.rank === 1 ? 0.7 : 0.3 });
    const tk = fitText(ctx, tickerOf(s.c), 440, { weight: 800, size: 58, min: 26, family: F.x });
    text(ctx, tk, s.cx, 462, { color: INK, align: "center" });
    const nm = fitText(ctx, s.c.name || "", 420, { weight: 600, size: 22, min: 14, family: F.s });
    text(ctx, nm, s.cx, 496, { color: MUTED, align: "center" });
    if (o.showPct) {
      text(ctx, pctOf(o, s.c, prog(t, s.start + 0.6, 1.2)), s.cx, 590, { font: `800 76px ${F.x}`, color: MINT, align: "center" });
    } else if (s.c.mcap) {
      micro(ctx, `MCap ${fmtCap(s.c.mcap)}`, s.cx, 580, { size: 22, color: INK, align: "center", track: 0.12 });
    }
    ctx.restore();
    ctx.restore();
  }
  const vp = outBack(prog(t, 0.95, 0.5));
  if (vp > 0) {
    ctx.save();
    ctx.translate(640, 382);
    ctx.scale(vp, vp);
    ctx.rotate(Math.sin(TAU * (t / o.dur) * 2) * 0.06);
    ctx.shadowColor = "rgba(38,198,245,.6)";
    ctx.shadowBlur = 30;
    ctx.beginPath();
    ctx.arc(0, 0, 56, 0, TAU);
    ctx.fillStyle = "#0B1120";
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.lineWidth = 3;
    ctx.strokeStyle = ACC;
    ctx.stroke();
    text(ctx, "VS", 0, 3, { font: `800 38px ${F.x}`, color: INK, align: "center", baseline: "middle" });
    ctx.restore();
  }
}

function crown(ctx, cx, cy, s) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(s, s);
  ctx.beginPath();
  ctx.moveTo(-26, 12);
  ctx.lineTo(-30, -14);
  ctx.lineTo(-13, -1);
  ctx.lineTo(0, -20);
  ctx.lineTo(13, -1);
  ctx.lineTo(30, -14);
  ctx.lineTo(26, 12);
  ctx.closePath();
  const g = ctx.createLinearGradient(0, -20, 0, 12);
  g.addColorStop(0, "#FFE7A3");
  g.addColorStop(1, GOLD);
  ctx.fillStyle = g;
  ctx.fill();
  ctx.restore();
}

function podium(ctx, t, coins, o) {
  if (coins.length < 3) return faceoff(ctx, t, coins, o);
  title(ctx, t, 44, 146, 3, { size: 40 });
  const base = 650;
  const slots = [
    { i: 1, x: 340, h: 180, start: 0.3 },
    { i: 0, x: 640, h: 246, start: 0.45 },
    { i: 2, x: 940, h: 136, start: 0.15 },
  ];
  const pw = 250;
  for (const s of slots) {
    const c = coins[s.i];
    const rank = s.i + 1;
    const m = metalOf(rank);
    const hp = outCubic(prog(t, s.start, 0.7));
    const h = s.h * hp;
    if (h <= 0) continue;
    const x = s.x - pw / 2;
    const y = base - h;
    const g = ctx.createLinearGradient(0, y, 0, base);
    g.addColorStop(0, hexA(m, 0.26));
    g.addColorStop(1, "rgba(13,17,25,.95)");
    ctx.fillStyle = g;
    ctx.fillRect(x, y, pw, h);
    ctx.fillStyle = m;
    ctx.fillRect(x, y, pw, 3);
    ctx.fillStyle = "rgba(255,255,255,.06)";
    ctx.fillRect(x, y, 1, h);
    ctx.fillRect(x + pw - 1, y, 1, h);
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, pw, h);
    ctx.clip();
    const ng = ctx.createLinearGradient(0, y + 20, 0, y + 120);
    ng.addColorStop(0, hexA(m, 0.9));
    ng.addColorStop(1, hexA(m, 0.25));
    text(ctx, String(rank), s.x, y + 18, { font: `800 104px ${F.x}`, color: ng, align: "center", baseline: "top" });
    ctx.restore();
    // the token lands on its plinth once the plinth is up
    const lp = outBack(prog(t, s.start + 0.55, 0.6));
    if (lp <= 0) continue;
    const d = rank === 1 ? 150 : 116;
    const acy = y - d / 2 - 8;
    const drop = (1 - lp) * -220;
    ctx.save();
    ctx.globalAlpha *= prog(t, s.start + 0.55, 0.2);
    avatar(ctx, c, s.x, acy + drop, d, { ring: m, ringW: 4, glow: rank === 1 ? 0.8 : 0.35 });
    const lt = outCubic(prog(t, s.start + 0.85, 0.5));
    ctx.globalAlpha *= lt;
    const ly = acy - d / 2 - 14 + (1 - lt) * 12;
    if (o.showPct) {
      text(ctx, pctOf(o, c, prog(t, s.start + 0.85, 1.1)), s.x, ly, { font: `800 ${rank === 1 ? 40 : 32}px ${F.x}`, color: MINT, align: "center" });
    }
    const tk = fitText(ctx, tickerOf(c), pw - 10, { weight: 700, size: rank === 1 ? 30 : 26, min: 14, family: F.b });
    text(ctx, tk, s.x, ly - (o.showPct ? (rank === 1 ? 44 : 36) : 0), { color: INK, align: "center" });
    if (rank === 1) crown(ctx, s.x, ly - (o.showPct ? 44 : 0) - 58 + Math.sin(TAU * (t / o.dur) * 2) * 4, 1);
    ctx.restore();
  }
}

function cards(ctx, t, coins, o) {
  const k = Math.min(4, coins.length);
  title(ctx, t, W / 2, 146, k, { size: 40, align: "center" });
  const cw = 262;
  const ch = 420;
  const gap = 26;
  const x0 = (W - (k * cw + (k - 1) * gap)) / 2;
  const y0 = 196;
  for (let i = 0; i < k; i++) {
    const c = coins[i];
    const rank = i + 1;
    const start = 0.25 + i * 0.22;
    const fp = inOut(prog(t, start, 0.7));
    const sx = Math.abs(Math.cos(fp * Math.PI));
    const front = fp >= 0.5;
    const settled = prog(t, start + 0.7, 0.01) >= 1;
    const bob = settled ? Math.sin(TAU * (t / o.dur) * 2 + i * 0.6) * 3 : 0;
    const cx = x0 + i * (cw + gap) + cw / 2;
    const cy = y0 + ch / 2 + bob;
    ctx.save();
    ctx.globalAlpha *= prog(t, start - 0.2, 0.25);
    ctx.translate(cx, cy);
    ctx.scale(Math.max(0.001, sx), 1);
    const x = -cw / 2;
    const y = -ch / 2;
    if (!front) {
      const g = ctx.createLinearGradient(0, y, 0, y + ch);
      g.addColorStop(0, ACC_DEEP);
      g.addColorStop(1, "#0B1120");
      panel(ctx, x, y, cw, ch, 22, { fill: g, stroke: hexA(ACC, 0.6), lw: 2 });
      drawBrandMark(ctx, -45, -70, 90);
      micro(ctx, "Dexvra", 0, 70, { size: 16, color: INK, align: "center", track: 0.4 });
    } else {
      const m = metalOf(rank);
      const g = ctx.createLinearGradient(0, y, 0, y + ch);
      g.addColorStop(0, "rgba(22,30,48,.96)");
      g.addColorStop(1, "rgba(12,16,26,.96)");
      panel(ctx, x, y, cw, ch, 22, { fill: g, stroke: rank === 1 ? hexA(GOLD, 0.6) : "rgba(255,255,255,.10)", lw: rank === 1 ? 2 : 1 });
      ctx.fillStyle = m;
      ctx.fillRect(x + 24, y, cw - 48, 3);
      micro(ctx, `#${rank}`, x + 22, y + 38, { size: 16, color: m, track: 0.14, weight: 800 });
      micro(ctx, "24h", x + cw - 22, y + 38, { size: 12, color: FAINT, align: "right" });
      avatar(ctx, c, 0, y + 124, 120, { ring: rank <= 3 ? m : null, ringW: 3, glow: rank === 1 ? 0.5 : 0 });
      const tk = fitText(ctx, tickerOf(c), cw - 36, { weight: 800, size: 36, min: 16, family: F.x });
      text(ctx, tk, 0, y + 236, { color: INK, align: "center" });
      const nm = fitText(ctx, c.name || "", cw - 40, { weight: 600, size: 16, min: 11, family: F.s });
      text(ctx, nm, 0, y + 264, { color: MUTED, align: "center" });
      ctx.fillStyle = "rgba(255,255,255,.07)";
      ctx.fillRect(x + 24, y + 290, cw - 48, 1);
      if (o.showPct) text(ctx, pctOf(o, c, prog(t, start + 0.5, 1.1)), 0, y + 350, { font: `800 46px ${F.x}`, color: MINT, align: "center" });
      if (c.mcap) micro(ctx, `MCap ${fmtCap(c.mcap)}`, 0, y + (o.showPct ? 392 : 360), { size: 14, color: MUTED, align: "center", track: 0.14 });
    }
    ctx.restore();
  }
}

function bars(ctx, t, coins, o) {
  const k = Math.min(5, coins.length);
  title(ctx, t, 44, 146, k, { size: 40 });
  const max = Math.max(...coins.slice(0, k).map((c) => Math.max(0, Number(c.pct) || 0)), 1e-9);
  const rowH = 86;
  const y0 = 186;
  const bx = 430;
  const bw = 640;
  for (let i = 0; i < k; i++) {
    const c = coins[i];
    const rank = i + 1;
    const rp = outCubic(prog(t, 0.2 + i * 0.1, 0.5));
    if (rp <= 0) continue;
    const y = y0 + i * rowH;
    ctx.save();
    ctx.globalAlpha *= rp;
    ctx.translate((1 - rp) * -60, 0);
    panel(ctx, 40, y, W - 80, rowH - 12, 16, {
      fill: rank === 1 ? "rgba(245,196,81,.06)" : "rgba(255,255,255,.025)",
      stroke: rank === 1 ? hexA(GOLD, 0.45) : "rgba(255,255,255,.06)",
    });
    const my = y + (rowH - 12) / 2;
    text(ctx, String(rank).padStart(2, "0"), 70, my, { font: `800 26px ${F.m8}`, color: metalOf(rank), baseline: "middle" });
    avatar(ctx, c, 146, my, 54, { ring: rank <= 3 ? metalOf(rank) : null, ringW: 2.5 });
    const tk = fitText(ctx, tickerOf(c), 230, { weight: 700, size: 26, min: 14, family: F.b });
    text(ctx, tk, 186, my - 4, { color: INK });
    const nm = fitText(ctx, c.name || "", 230, { weight: 500, size: 15, min: 11, family: F.m });
    text(ctx, nm, 186, my + 20, { color: MUTED });
    if (o.showPct) {
      const bp = outCubic(prog(t, 0.55 + i * 0.12, 1.2));
      const len = Math.max(20, (bw * Math.max(0, Number(c.pct) || 0)) / max) * bp;
      panel(ctx, bx, my - 16, bw, 32, 16, { fill: "rgba(255,255,255,.04)", stroke: null });
      if (len > 1) {
        const g = ctx.createLinearGradient(bx, 0, bx + bw, 0);
        g.addColorStop(0, ACC_DEEP);
        g.addColorStop(0.6, ACC);
        g.addColorStop(1, MINT);
        roundRect(ctx, bx, my - 16, len, 32, 16);
        ctx.fillStyle = g;
        ctx.fill();
      }
      text(ctx, pctOf(o, c, bp), W - 64, my + 2, { font: `800 30px ${F.m8}`, color: MINT, align: "right", baseline: "middle" });
    } else {
      if (c.mcap) micro(ctx, `MCap ${fmtCap(c.mcap)}`, bx, my + 7, { size: 18, color: INK, track: 0.1 });
      if (c.price) micro(ctx, `Price ${fmtPrice(c.price)}`, W - 64, my + 7, { size: 18, color: MUTED, align: "right", track: 0.1 });
    }
    ctx.restore();
  }
}

function orbit(ctx, t, coins, o) {
  if (coins.length < 2) return spotlight(ctx, t, coins, o);
  title(ctx, t, 44, 146, Math.min(6, coins.length), { size: 40 });
  const cx = 640;
  const cy = 392;
  const rx = 450;
  const ry = 200;
  const ring = prog(t, 0.2, 0.6);
  ctx.save();
  ctx.globalAlpha *= ring;
  ctx.setLineDash([4, 10]);
  ctx.strokeStyle = "rgba(143,228,255,.22)";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.ellipse(cx, cy, rx, ry, 0, 0, TAU);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.strokeStyle = "rgba(143,228,255,.08)";
  ctx.beginPath();
  ctx.ellipse(cx, cy, rx + 40, ry + 22, 0, 0, TAU);
  ctx.stroke();
  ctx.restore();
  const others = coins.slice(1, 6);
  const m = others.length;
  // one slot of rotation per loop, so the loop is seamless (positions permute)
  const rot = (t / o.dur) * (TAU / m) - Math.PI / 2;
  const pts = others.map((c, i) => {
    const a = rot + (i * TAU) / m;
    const rp = outCubic(prog(t, 0.45 + i * 0.1, 0.9));
    return { c, rank: i + 2, x: cx + Math.cos(a) * rx * rp, y: cy + Math.sin(a) * ry * rp, depth: Math.sin(a), rp, i };
  });
  const drawOne = (p) => {
    if (p.rp <= 0) return;
    const s = 0.84 + 0.2 * ((p.depth + 1) / 2);
    const d = 80 * s;
    ctx.save();
    ctx.globalAlpha *= Math.min(1, p.rp * 1.4) * (0.7 + 0.3 * ((p.depth + 1) / 2));
    avatar(ctx, p.c, p.x, p.y, d, { ring: p.rank <= 3 ? metalOf(p.rank) : "rgba(143,228,255,.5)", ringW: 2.5 });
    const lx = p.x + d / 2 + 10;
    micro(ctx, `#${p.rank}`, lx, p.y - 16, { size: 11, color: metalOf(p.rank), track: 0.12, weight: 800 });
    const tk = fitText(ctx, tickerOf(p.c), 170, { weight: 700, size: 20, min: 12, family: F.b });
    text(ctx, tk, lx, p.y + 6, { color: INK });
    if (o.showPct) text(ctx, pctOf(o, p.c, prog(t, 0.9 + p.i * 0.1, 1)), lx, p.y + 30, { font: `800 20px ${F.m8}`, color: MINT });
    ctx.restore();
  };
  pts.filter((p) => p.depth < 0).forEach(drawOne);
  // the leader
  const c = coins[0];
  const lp = outBack(prog(t, 0.1, 0.8));
  ctx.save();
  ctx.globalAlpha *= prog(t, 0.1, 0.3);
  ctx.translate(cx, cy - 20);
  ctx.scale(lerp(0.5, 1, lp), lerp(0.5, 1, lp));
  ctx.save();
  ctx.rotate((t / o.dur) * TAU);
  ctx.setLineDash([18, 10]);
  ctx.lineWidth = 3;
  ctx.strokeStyle = hexA(GOLD, 0.8);
  ctx.beginPath();
  ctx.arc(0, 0, 104, 0, TAU);
  ctx.stroke();
  ctx.restore();
  avatar(ctx, c, 0, 0, 172, { ring: GOLD, ringW: 4, glow: 0.9 });
  ctx.restore();
  const tp = outCubic(prog(t, 0.6, 0.5));
  ctx.save();
  ctx.globalAlpha *= tp;
  const tk = fitText(ctx, tickerOf(c), 300, { weight: 800, size: 32, min: 16, family: F.x });
  text(ctx, tk, cx, cy + 108, { color: INK, align: "center" });
  if (o.showPct) text(ctx, pctOf(o, c, prog(t, 0.6, 1.2)), cx, cy + 146, { font: `800 34px ${F.x}`, color: MINT, align: "center" });
  ctx.restore();
  pts.filter((p) => p.depth >= 0).forEach(drawOne);
}

function stack(ctx, t, coins, o) {
  const k = Math.min(7, coins.length);
  // the giant title column
  const p = outCubic(prog(t, 0.1, 0.8));
  ctx.save();
  ctx.globalAlpha *= p;
  micro(ctx, "Live · 24h change", 48, 180 - (1 - p) * 20, { size: 14, color: MINT, track: 0.3 });
  text(ctx, "TOP", 44, 290 - (1 - p) * 20, { font: `800 104px ${F.x}`, color: INK });
  const g = ctx.createLinearGradient(0, 300, 0, 520);
  g.addColorStop(0, ACC_HI);
  g.addColorStop(1, ACC_DEEP);
  text(ctx, String(k), 36, 530 - (1 - p) * 20, { font: `800 250px ${F.x}`, color: g });
  text(ctx, "GAINERS", 48, 600 - (1 - p) * 20, { font: `800 44px ${F.x}`, color: INK });
  ctx.restore();
  const x = 420;
  const w = W - 40 - x;
  const rowH = 78;
  const gap = 0;
  const y0 = 106;
  const hRow = rowH - 8;
  for (let i = 0; i < k; i++) {
    const c = coins[i];
    const rank = i + 1;
    const rp = outCubic(prog(t, 0.2 + i * 0.1, 0.55));
    if (rp <= 0) continue;
    const y = y0 + i * (rowH + gap);
    ctx.save();
    ctx.globalAlpha *= rp;
    ctx.translate((1 - rp) * 140, 0);
    panel(ctx, x, y, w, hRow, 14, {
      fill: rank === 1 ? "rgba(38,198,245,.08)" : "rgba(16,22,36,.78)",
      stroke: rank === 1 ? hexA(ACC, 0.5) : "rgba(255,255,255,.07)",
    });
    if (rank === 1) {
      // a light band sweeps the leader's row three times per loop
      const sp = ((t / o.dur) * 3) % 1;
      ctx.save();
      roundRect(ctx, x, y, w, hRow, 14);
      ctx.clip();
      const sx = x - 200 + sp * (w + 400);
      const sg = ctx.createLinearGradient(sx - 90, 0, sx + 90, 0);
      sg.addColorStop(0, "rgba(255,255,255,0)");
      sg.addColorStop(0.5, "rgba(255,255,255,.07)");
      sg.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = sg;
      ctx.fillRect(sx - 90, y, 180, hRow);
      ctx.restore();
    }
    const my = y + hRow / 2;
    text(ctx, String(rank).padStart(2, "0"), x + 22, my, { font: `800 22px ${F.m8}`, color: metalOf(rank), baseline: "middle" });
    avatar(ctx, c, x + 98, my, 48, { ring: rank <= 3 ? metalOf(rank) : null, ringW: 2.5 });
    const tk = fitText(ctx, tickerOf(c), 300, { weight: 700, size: 24, min: 13, family: F.b });
    text(ctx, tk, x + 134, my - 3, { color: INK });
    const nm = fitText(ctx, c.name || "", 300, { weight: 500, size: 14, min: 10, family: F.m });
    text(ctx, nm, x + 134, my + 19, { color: MUTED });
    if (c.mcap) micro(ctx, `MCap ${fmtCap(c.mcap)}`, x + w - (o.showPct ? 210 : 24), my + 6, { size: 14, color: MUTED, align: "right", track: 0.1 });
    if (o.showPct) text(ctx, pctOf(o, c, prog(t, 0.5 + i * 0.1, 1)), x + w - 22, my + 1, { font: `800 26px ${F.m8}`, color: MINT, align: "right", baseline: "middle" });
    ctx.restore();
  }
}

function neon(ctx, t, coins, o) {
  const k = Math.min(8, coins.length);
  const cols = k <= 4 ? k : 4;
  const rows = Math.ceil(k / cols);
  const tw = 272;
  const th = rows === 1 ? 300 : 244;
  const gap = 22;
  const y0 = rows === 1 ? 210 : 116;
  for (let i = 0; i < k; i++) {
    const c = coins[i];
    const rank = i + 1;
    const r = Math.floor(i / cols);
    const inRow = r === rows - 1 ? k - r * cols : cols;
    const colI = i - r * cols;
    const x0 = (W - (inRow * tw + (inRow - 1) * gap)) / 2;
    const x = x0 + colI * (tw + gap);
    const y = y0 + r * (th + gap);
    const pp = outBack(prog(t, 0.15 + i * 0.09, 0.6));
    if (pp <= 0) continue;
    ctx.save();
    ctx.globalAlpha *= prog(t, 0.15 + i * 0.09, 0.25);
    ctx.translate(x + tw / 2, y + th / 2);
    ctx.scale(lerp(0.85, 1, pp), lerp(0.85, 1, pp));
    ctx.translate(-tw / 2, -th / 2);
    const neonC = rank === 1 ? GOLD : i % 2 ? MINT : ACC;
    panel(ctx, 0, 0, tw, th, 18, { fill: "rgba(10,14,24,.92)", stroke: "rgba(255,255,255,.07)" });
    // the light running along the edge — twice around per loop
    const perim = 2 * (tw + th);
    ctx.save();
    ctx.shadowColor = neonC;
    ctx.shadowBlur = 14;
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = neonC;
    ctx.setLineDash([perim * 0.22, perim * 0.78]);
    ctx.lineDashOffset = -perim * ((t / o.dur) * 2 + i * 0.13);
    roundRect(ctx, 1, 1, tw - 2, th - 2, 18);
    ctx.stroke();
    ctx.restore();
    micro(ctx, `#${rank}`, 18, 32, { size: 15, color: metalOf(rank), weight: 800, track: 0.12 });
    const ay = th === 300 ? 104 : 86;
    avatar(ctx, c, tw / 2, ay, th === 300 ? 116 : 92, { ring: hexA(neonC, 0.7), ringW: 2.5 });
    const tk = fitText(ctx, tickerOf(c), tw - 30, { weight: 800, size: 28, min: 14, family: F.x });
    text(ctx, tk, tw / 2, ay + (th === 300 ? 106 : 84), { color: INK, align: "center" });
    if (o.showPct) {
      text(ctx, pctOf(o, c, prog(t, 0.4 + i * 0.09, 1)), tw / 2, ay + (th === 300 ? 156 : 124), { font: `800 30px ${F.m8}`, color: MINT, align: "center" });
    } else if (c.mcap) {
      micro(ctx, `MCap ${fmtCap(c.mcap)}`, tw / 2, ay + (th === 300 ? 150 : 120), { size: 15, color: MUTED, align: "center", track: 0.1 });
    }
    ctx.restore();
  }
}

// deterministic "random" glyph for the split-flap spin
const FLAP = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789$%+.";
const flapChar = (seed) => FLAP[Math.abs(Math.floor(Math.sin(seed * 12.9898) * 43758.5453)) % FLAP.length];

function flap(ctx, t, coins, o) {
  const k = Math.min(9, coins.length);
  const bp = prog(t, 0, 0.35);
  ctx.save();
  ctx.globalAlpha *= bp;
  panel(ctx, 40, 102, W - 80, 556, 18, { fill: "rgba(8,11,18,.92)", stroke: "rgba(255,255,255,.08)" });
  micro(ctx, "#", 72, 134, { size: 12, color: FAINT });
  micro(ctx, "Token", 196, 134, { size: 12, color: FAINT });
  micro(ctx, "Market cap", 538, 134, { size: 12, color: FAINT });
  if (o.showPct) micro(ctx, "24h change", 842, 134, { size: 12, color: FAINT });
  micro(ctx, "Departures · to the moon", W - 64, 134, { size: 12, color: ACC_HI, align: "right" });
  ctx.restore();
  const cellW = 30;
  const pitch = 33;
  const cellH = 40;
  const rowH = 55;
  const y0 = 150;
  const fields = [
    { x: 64, len: 2, get: (c, i) => String(i + 1).padStart(2, "0"), color: (i) => metalOf(i + 1) },
    { x: 196, len: 9, get: (c) => String(c.symbol || "").replace(/^\$+/, "").toUpperCase().slice(0, 9).padEnd(9), color: () => INK },
    { x: 538, len: 8, get: (c) => (c.mcap ? fmtCap(c.mcap) : "—").slice(0, 8).padStart(8), color: () => MUTED },
  ];
  if (o.showPct) fields.push({ x: 842, len: 9, get: (c) => fmtPct(c.pct).slice(0, 9).padStart(9), color: () => MINT });
  const frame = Math.floor(t * 15);
  for (let i = 0; i < k; i++) {
    const c = coins[i];
    const y = y0 + i * rowH;
    const rowStart = 0.3 + i * 0.13;
    const ap = outBack(prog(t, rowStart, 0.4));
    if (ap > 0) avatar(ctx, c, 150, y + cellH / 2, 38 * Math.min(1, ap), { ring: i < 3 ? metalOf(i + 1) : null, ringW: 2 });
    let col = 0;
    for (const f of fields) {
      const s = f.get(c, i);
      for (let j = 0; j < f.len; j++, col++) {
        const x = f.x + j * pitch;
        const settle = rowStart + 0.25 + col * 0.03;
        roundRect(ctx, x, y, cellW, cellH, 4);
        ctx.fillStyle = "#121826";
        ctx.fill();
        ctx.fillStyle = "rgba(0,0,0,.55)";
        ctx.fillRect(x, y + cellH / 2 - 0.5, cellW, 1);
        let ch;
        let color = f.color(i);
        let sy = 1;
        if (t < rowStart) ch = "";
        else if (t < settle) {
          ch = flapChar(frame * 31 + i * 7 + col * 13);
          color = "rgba(241,245,251,.55)";
        } else {
          ch = s[j] || " ";
          sy = 1 - 0.6 * (1 - prog(t, settle, 0.08));
        }
        if (ch && ch !== " ") {
          ctx.save();
          ctx.translate(x + cellW / 2, y + cellH / 2);
          ctx.scale(1, sy);
          text(ctx, ch, 0, 2, { font: `800 24px ${F.m8}`, color, align: "center", baseline: "middle" });
          ctx.restore();
        }
      }
    }
  }
}

/** Deterministic circle packing: biggest first, spiral out from the centre. */
function packBubbles(radii, box) {
  const cx = (box.x0 + box.x1) / 2;
  const cy = (box.y0 + box.y1) / 2;
  for (let shrink = 1, tries = 0; tries < 10; tries++, shrink *= 0.9) {
    const rs = radii.map((r) => r * shrink);
    const order = rs.map((r, i) => i).sort((a, b) => rs[b] - rs[a]);
    const placed = new Array(rs.length);
    let ok = true;
    for (const i of order) {
      const r = rs[i];
      let found = null;
      for (let step = 0; step < 4000 && !found; step++) {
        const a = step * 0.35;
        const d = 3.2 * a;
        const x = cx + Math.cos(a) * d * 1.6;
        const y = cy + Math.sin(a) * d;
        if (x - r < box.x0 || x + r > box.x1 || y - r < box.y0 || y + r > box.y1) continue;
        const clash = placed.some((p) => p && Math.hypot(p.x - x, p.y - y) < p.r + r + 14);
        if (!clash) found = { x, y, r };
      }
      if (!found) {
        ok = false;
        break;
      }
      placed[i] = found;
    }
    if (ok) return placed;
  }
  return radii.map((r, i) => ({ x: box.x0 + 80 + (i % 5) * 230, y: box.y0 + 110 + Math.floor(i / 5) * 230, r: 70 }));
}

const _packCache = new Map();
function bubbles(ctx, t, coins, o) {
  const k = Math.min(10, coins.length);
  const list = coins.slice(0, k);
  // SIZE IS THE FIGURE when the gain is shown (sqrt → area ∝ gain); when it is
  // hidden the size follows the RANK only, so the area cannot leak the number.
  const max = Math.max(...list.map((c) => Math.max(0, Number(c.pct) || 0)), 1e-9);
  const radii = list.map((c, i) =>
    o.showPct ? 64 + 86 * Math.sqrt(Math.max(0, Number(c.pct) || 0) / max) : 150 - i * 9,
  );
  const key = radii.map((r) => r.toFixed(1)).join(",");
  let placed = _packCache.get(key);
  if (!placed) {
    placed = packBubbles(radii, { x0: 40, x1: W - 40, y0: 104, y1: 656 });
    if (_packCache.size > 50) _packCache.clear();
    _packCache.set(key, placed);
  }
  const drawOrder = list.map((c, i) => i).reverse();
  for (const i of drawOrder) {
    const c = list[i];
    const rank = i + 1;
    const p = placed[i];
    const ep = outBack(prog(t, 0.15 + (k - 1 - i) * 0.08, 0.7));
    if (ep <= 0) continue;
    const bob = Math.sin(TAU * ((t / o.dur) * 2) + i * 1.3) * 5;
    const r = p.r * Math.max(0, ep);
    const x = p.x;
    const y = p.y + bob + (1 - clamp01(ep)) * 80;
    ctx.save();
    ctx.globalAlpha *= prog(t, 0.15 + (k - 1 - i) * 0.08, 0.2);
    const g = ctx.createRadialGradient(x - r * 0.3, y - r * 0.4, r * 0.1, x, y, r);
    g.addColorStop(0, "rgba(38,58,92,.95)");
    g.addColorStop(1, "rgba(10,14,24,.95)");
    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    ctx.fillStyle = g;
    ctx.fill();
    ctx.lineWidth = rank === 1 ? 4 : 2;
    ctx.strokeStyle = rank <= 3 ? metalOf(rank) : hexA(ACC, 0.55);
    ctx.stroke();
    if (r > 20) {
      avatar(ctx, c, x, y - r * 0.22, r * 0.62, {});
      const tk = fitText(ctx, tickerOf(c), r * 1.5, { weight: 700, size: Math.max(12, r * 0.22), min: 10, family: F.b });
      text(ctx, tk, x, y + r * 0.34, { color: INK, align: "center" });
      if (o.showPct) text(ctx, pctOf(o, c, prog(t, 0.6 + (k - 1 - i) * 0.08, 1)), x, y + r * 0.62, { font: `800 ${Math.max(11, Math.round(r * 0.2))}px ${F.m8}`, color: MINT, align: "center" });
      if (r >= 80) micro(ctx, `#${rank}`, x, y - r * 0.66, { size: Math.round(r * 0.1), color: metalOf(rank), align: "center", weight: 800, track: 0.1 });
    }
    ctx.restore();
  }
}

const LAYOUTS = { spotlight, faceoff, podium, cards, bars, orbit, stack, neon, flap, bubbles };

// ── frame + encode ──────────────────────────────────────────────────────────
function drawFrame(ctx, t, { spec, coins, dateText, showPct, bgImg, dur }) {
  const ph = (t / dur) % 1;
  backdrop(ctx, spec.bg, ph, bgImg);
  header(ctx, ph, Math.min(spec.n, coins.length), dateText);
  footer(ctx);
  // content fades back to the empty backdrop at the end — frame 0 builds up
  // from exactly that, so the autoplay loop has no seam
  ctx.save();
  ctx.globalAlpha = 1 - outCubic(prog(t, dur - 0.55, 0.55));
  LAYOUTS[spec.layout](ctx, t, coins, { showPct, dur });
  ctx.restore();
}

const even = (v) => Math.max(2, Math.round(v / 2) * 2);

/** Copy the coins (never mutate the caller's sample) and decode each logo once. */
async function prepare(cv, coins, spec) {
  const list = (coins || []).slice(0, spec.n).map((c) => ({ ...c }));
  for (const c of list) {
    c.img = null;
    if (c.logo) {
      try {
        c.img = await cv.loadImage(c.logo);
      } catch {
        c.img = null;
      }
    }
    kit.warnBoxes("gainers motion", c);
  }
  return list;
}

async function loadBg(cv, bgPath) {
  if (!bgPath) return null;
  try {
    if (!fss.existsSync(bgPath)) return null;
    return await cv.loadImage(fss.readFileSync(bgPath));
  } catch {
    return null;
  }
}

function ffmpegPath() {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  return require("@ffmpeg-installer/ffmpeg").path;
}

/**
 * Render a motion banner to an MP4 (H.264, no audio — Telegram plays it as a
 * looping GIF via sendAnimation).
 * @returns {Promise<Buffer|null>} null when it could not be drawn or encoded.
 */
async function render({ template, coins, dateText = "", showPct = true, bgPath = null, seconds = SECONDS, fps = FPS, scale = 1 } = {}) {
  const cv = kit.canvasLib();
  const spec = specOf(template);
  if (!cv || !spec || !Array.isArray(coins) || !coins.length) return null;
  const t0 = Date.now();
  const tmp = path.join(os.tmpdir(), `gainers-motion-${process.pid}-${t0}-${Math.random().toString(36).slice(2, 7)}.mp4`);
  let ff = null;
  try {
    const list = await prepare(cv, coins, spec);
    const bgImg = await loadBg(cv, bgPath);
    const w = even(W * scale);
    const h = even(H * scale);
    const canvas = cv.createCanvas(w, h);
    const ctx = canvas.getContext("2d");
    const frames = Math.max(1, Math.round(seconds * fps));
    ff = spawn(ffmpegPath(), [
      "-y", "-loglevel", "error",
      "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${w}x${h}`, "-r", String(fps), "-i", "-",
      "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
      "-pix_fmt", "yuv420p", "-profile:v", "high", "-movflags", "+faststart",
      tmp,
    ], { stdio: ["pipe", "ignore", "pipe"] });
    let errText = "";
    ff.stderr.on("data", (d) => {
      if (errText.length < 2000) errText += d.toString();
    });
    const done = new Promise((resolve, reject) => {
      ff.on("error", reject);
      ff.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${errText.trim().slice(0, 300)}`))));
    });
    done.catch(() => {}); // observed below; never an unhandled rejection
    const killer = setTimeout(() => ff && ff.kill("SIGKILL"), ENCODE_TIMEOUT_MS);
    try {
      const opts = { spec, coins: list, dateText, showPct, bgImg, dur: seconds };
      for (let f = 0; f < frames; f++) {
        ctx.setTransform(scale, 0, 0, scale, 0, 0);
        drawFrame(ctx, f / fps, opts);
        const img = ctx.getImageData(0, 0, w, h);
        const buf = Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength);
        if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once("drain", r));
      }
      ff.stdin.end();
      await done;
    } finally {
      clearTimeout(killer);
    }
    const out = fss.readFileSync(tmp);
    log.info(`[gainers] motion ${spec.id} rendered: ${frames} frames, ${(out.length / 1024).toFixed(0)}KB in ${Date.now() - t0}ms`);
    return out.length ? out : null;
  } catch (e) {
    log.warn(`[gainers] motion ${template} failed: ${e.message}`);
    if (ff && !ff.killed) ff.kill("SIGKILL");
    return null;
  } finally {
    fss.promises.unlink(tmp).catch(() => {});
  }
}

/**
 * The same banner as a still PNG — the frame where every figure has landed.
 * The tweet uses it: X takes a still with the board text, and a still is what
 * a link preview shows.
 */
async function renderStill({ template, coins, dateText = "", showPct = true, bgPath = null, seconds = SECONDS, scale = 1 } = {}) {
  const cv = kit.canvasLib();
  const spec = specOf(template);
  if (!cv || !spec || !Array.isArray(coins) || !coins.length) return null;
  try {
    const list = await prepare(cv, coins, spec);
    const bgImg = await loadBg(cv, bgPath);
    const canvas = cv.createCanvas(even(W * scale), even(H * scale));
    const ctx = canvas.getContext("2d");
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    drawFrame(ctx, seconds - 0.8, { spec, coins: list, dateText, showPct, bgImg, dur: seconds });
    return canvas.toBuffer("image/png");
  } catch (e) {
    log.warn(`[gainers] motion still ${template} failed: ${e.message}`);
    return null;
  }
}

module.exports = {
  TEMPLATES,
  TEMPLATE_IDS,
  W,
  H,
  FPS,
  SECONDS,
  specOf,
  isTemplate,
  countOf,
  labelOf,
  pickTemplate,
  render,
  renderStill,
  available: () => Boolean(kit.canvasLib()),
  _internals: { LAYOUTS, drawFrame, packBubbles, pctOf, flapChar },
};
