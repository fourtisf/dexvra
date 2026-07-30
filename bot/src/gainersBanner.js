// Top-Gainers banners — six layouts drawn in the dexvra.io design language.
//
// The operator picks a layout in @dexvraadminbot, the live top movers
// (gainers.js) are burned into it, and the finished PNG goes to a channel.
// Everything is procedural (@napi-rs/canvas), so a layout works the moment the
// code ships and adapts to however many real gainers exist right now.
//
// DESIGN. The reference is the product, not a poster: the site's surfaces
// (#090C12 page under mint+violet blooms, #101624 panels, hairline borders),
// its typefaces (Space Grotesk display / JetBrains Mono for every number and
// wide-tracked micro-label), the real logo mark, the board's `.chg.up` change
// pill, its `.btn-primary` gradient CTA, and — ported line-for-line from
// src/lib/visual.ts — the SAME deterministic sparkline and jewel-tone monogram
// gradients the site renders for a token. The table layouts are ONE panel with
// hairline-separated rows and a `.row.head` column strip, because that is what
// the Dexvra board actually looks like; a film-grain pass keeps the big dark
// fields from banding. No glowing titles, no medallions, no sparkles.
//
// THE CONTRACT (same shape as the per-token cards in bannerRender.js):
//   • render() NEVER throws and never rejects — any failure resolves null, and
//     null means the caller posts nothing rather than posting something wrong.
//   • The layout is driven by coins.length, never by the template's nominal
//     size. Three live gainers on the "Top 5" layout draws three rows, titled
//     "Top 3 Gainers" — never two empty slots.
//   • No number is invented here. A coin with no market cap simply doesn't get
//     that cell; the % comes from gainers.js, which drops unpriced tokens. The
//     sparkline is the site's own synthetic trend (decorative, deterministic
//     per symbol, direction taken from the REAL 24h change) — identical to the
//     curve dexvra.io draws for the same token.
//
// Coordinates are written in a 1600×900 reference space and multiplied by S, so
// a template can change output size without a re-layout.
const fss = require("node:fs");
const { toSendBuffer } = require("./helpers/encodeImage");
const {
  canvasLib,
  F,
  SITE,
  rankColor,
  hexA,
  radial,
  roundRect,
  drawBrandMark,
  fitText,
} = require("./helpers/canvasKit");
const { fmtCap, fmtPrice, fmtPct } = require("./helpers/format");
const { chainOf } = require("./config/chains");
const log = require("./helpers/logger");

const REF_W = 1600;
const REF_H = 900;
// One margin everywhere; content band shared by every layout so the six banners
// keep one horizon line.
const PAD = 72;
const BAND_TOP = 276;
const BAND_BOTTOM = 794;
const BAND_H = BAND_BOTTOM - BAND_TOP;

// ── Templates ───────────────────────────────────────────────────────────────
const TEMPLATES = {
  hero1: {
    id: "hero1",
    label: "👑 #1 Spotlight",
    blurb: "One hero card for the single biggest 24h mover.",
    n: 1,
    layout: "hero",
    accent: SITE.mint,
    title: () => "Top Gainer",
  },
  podium: {
    id: "podium",
    label: "🏆 Top 3 Podium",
    blurb: "Three tall cards, the winner raised — the classic winners' shot.",
    n: 3,
    layout: "podium",
    accent: SITE.gold,
    title: (n) => (n >= 3 ? "Top 3 Gainers" : `Top ${n} Gainer${n > 1 ? "s" : ""}`),
  },
  cards4: {
    id: "cards4",
    label: "🃏 Top 4 Cards",
    blurb: "Four product cards, 2×2 — the move as each card's headline.",
    n: 4,
    layout: "cards",
    accent: SITE.cyan,
    title: (n) => `Top ${n} Gainers`,
  },
  list5: {
    id: "list5",
    label: "📋 Top 5 List",
    blurb: "The Dexvra board itself — one panel, real columns, sparklines.",
    n: 5,
    layout: "list",
    accent: SITE.mint,
    title: (n) => `Top ${n} Gainers`,
  },
  rail8: {
    id: "rail8",
    label: "🎞 Top 8 Rail",
    blurb: "Two board panels of four — the Top-8 shape, Dexvra styling.",
    n: 8,
    layout: "rail",
    accent: SITE.cyan,
    title: (n) => `Top ${n} Gainers`,
  },
  grid10: {
    id: "grid10",
    label: "🔟 Top 10 Grid",
    blurb: "The full top ten, two compact board panels of five.",
    n: 10,
    layout: "grid",
    accent: SITE.violet,
    title: (n) => `Top ${n} Gainers`,
  },
};
const TEMPLATE_IDS = Object.keys(TEMPLATES);
const DEFAULT_TEMPLATE = "list5";

const specOf = (id) => TEMPLATES[id] || TEMPLATES[DEFAULT_TEMPLATE];
const countOf = (id) => specOf(id).n;
const labelOf = (id) => specOf(id).label;
const isTemplate = (id) => Object.prototype.hasOwnProperty.call(TEMPLATES, id);
const templateList = () => TEMPLATE_IDS.map((id) => ({ ...TEMPLATES[id] }));

/** Resolve a template choice. `"random"` (or anything unknown) picks from
 *  `pool` — the admin's rotation, or every template when that is empty. */
function pickTemplate(id, { pool = [], rng = Math.random } = {}) {
  if (isTemplate(id)) return id;
  const from = (pool || []).filter(isTemplate);
  const list = from.length ? from : TEMPLATE_IDS;
  return list[Math.floor(rng() * list.length) % list.length];
}

// ── the site's own token visuals, ported from src/lib/visual.ts ─────────────
// Same hash, same gradients, same trend construction — so a token's monogram
// colour and sparkline on the banner match what dexvra.io shows for it.
function hashStr(s) {
  let h = 0;
  for (const c of String(s || "")) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h;
}
const JEWEL_GRADIENTS = [
  ["#8FD3FF", "#4C82F7", "#1E3A8A"], // sapphire
  ["#7BE8C2", "#22C39A", "#0B6E52"], // emerald (brand)
  ["#C4A6FF", "#8B5CF6", "#5B21B6"], // amethyst
  ["#7FE3F0", "#22D3EE", "#0E7490"], // cyan (brand)
  ["#A7F3D0", "#34D399", "#065F46"], // jade
  ["#BAE6FD", "#38BDF8", "#075985"], // sky
  ["#FBC79E", "#F59E4B", "#B45309"], // amber (rare)
  ["#F5A8C7", "#EC6AA0", "#9D2A63"], // rose (rare)
  ["#9DB4FF", "#6172F3", "#312E81"], // indigo
  ["#8AE7D0", "#2DD4BF", "#0F766E"], // teal
];
const jewelFor = (sym) => JEWEL_GRADIENTS[(hashStr(sym) >>> 4) % JEWEL_GRADIENTS.length];
/** "$RISE" → "RI" — the site's monogram rule (2 chars, not 3). */
function monogramOf(sym) {
  const s = String(sym || "").replace(/^\$+/, "").replace(/[^A-Za-z0-9]/g, "");
  return s ? s.slice(0, 2).toUpperCase() : "•";
}
/** The site's synthetic sparkline: deterministic per symbol, drift from the
 *  REAL 24h sign, last point pinned to the high on a gainer. */
function syntheticTrend(sym, chg24h) {
  const i = hashStr(sym) % 23;
  const pts = [];
  let v = 50;
  const drift = (Number(chg24h) || 0) >= 0 ? 0.9 : -0.9;
  for (let k = 0; k < 26; k++) {
    v += drift + Math.sin(i * 3.7 + k * 1.3) * 4 + (((k * i) % 5) - 2);
    v = Math.max(8, Math.min(92, v));
    pts.push(v);
  }
  if ((Number(chg24h) || 0) >= 0) pts[pts.length - 1] = Math.max(...pts);
  return pts;
}

/** The banner's variant of the same construction, with the drift turned up so
 *  the REAL direction dominates the per-symbol wobble. Needed because scale
 *  changes the reading: at the site's 60px a sparkline is texture, but on a
 *  banner it is a hero element — and a "Top Gainers" board whose #1 carries a
 *  visibly descending curve looks broken, even when the wobble is decorative.
 *  Still deterministic per symbol, still direction-true, same clamp/pin. */
function bannerTrend(sym, chg24h) {
  const i = hashStr(sym) % 23;
  const pts = [];
  let v = 50;
  const up = (Number(chg24h) || 0) >= 0;
  // Slope tracks the SIZE of the real move (log-scaled) and the wobble varies
  // per symbol — five rows of one cloned waveform is placeholder art, and a
  // +204% should visibly out-climb a +27%.
  const a = Math.abs(Number(chg24h) || 0);
  const slope = 0.8 + Math.min(2.4, Math.log10(1 + a) * 1.05);
  const drift = (up ? 1 : -1) * slope;
  // Wobble varies per symbol but is CAPPED against the slope — a seed whose
  // amplitude out-muscles the drift renders a sideways heart-monitor line, and
  // one flat row in a column of risers reads as broken data.
  const amp = Math.min(2.0 + (i % 5) * 0.55, slope * 1.1);
  const jag = Math.min(0.5 + ((i >> 2) % 3) * 0.35, slope * 0.4);
  for (let k = 0; k < 26; k++) {
    v += drift + Math.sin(i * 3.7 + k * (1.05 + (i % 4) * 0.16)) * amp + (((k * i) % 5) - 2) * jag;
    v = Math.max(6, Math.min(94, v));
    pts.push(v);
  }
  if (up) pts[pts.length - 1] = Math.max(...pts);
  return pts;
}

// ── primitives ──────────────────────────────────────────────────────────────
/** Cover-fit an image into a box (the CSS `object-fit: cover` maths). */
function drawCover(ctx, img, x, y, w, h) {
  const s = Math.max(w / img.width, h / img.height);
  const iw = img.width * s;
  const ih = img.height * s;
  ctx.drawImage(img, x + (w - iw) / 2, y + (h - ih) / 2, iw, ih);
}

/** Uppercase micro-label: JetBrains Mono, wide tracking — the site's
 *  `.nav-label` / `.row.head` / `.fld label` voice. */
function microLabel(ctx, x, y, text, { size = 11, color = SITE.faint, track = 0.22, align = "left", weight = 700 } = {}) {
  ctx.save();
  ctx.font = `${weight} ${size}px ${weight >= 800 ? F.m8 : weight >= 700 ? F.m7 : F.m6}`;
  ctx.fillStyle = color;
  ctx.textBaseline = "alphabetic";
  const t = String(text).toUpperCase();
  const spacing = size * track;
  const chars = [...t];
  const total = chars.reduce((a, c) => a + ctx.measureText(c).width, 0) + spacing * Math.max(0, chars.length - 1);
  let cx = align === "right" ? x - total : align === "center" ? x - total / 2 : x;
  ctx.textAlign = "left";
  for (const c of chars) {
    ctx.fillText(c, cx, y);
    cx += ctx.measureText(c).width + spacing;
  }
  ctx.restore();
  return total;
}

/** Display text in Space Grotesk with the slight negative tracking every
 *  startup wordmark carries at large sizes. */
function displayText(ctx, x, y, text, size, { weight = 700, color = SITE.text, align = "left" } = {}) {
  ctx.save();
  ctx.font = `${weight} ${size}px ${weight >= 700 ? F.d7 : weight >= 600 ? F.d6 : F.d5}`;
  if (size >= 30) ctx.letterSpacing = `${(-0.018 * size).toFixed(1)}px`;
  ctx.fillStyle = color;
  ctx.textAlign = align === "center" ? "center" : align === "right" ? "right" : "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillText(text, x, y);
  const w = ctx.measureText(text).width;
  ctx.letterSpacing = "0px";
  ctx.restore();
  return w;
}

/** A surface: the site's `--card` fill, hairline border, soft shadow, and a
 *  1px top light — the "lit from above" edge every polished dark UI has. */
function surface(ctx, x, y, w, h, r, { accent = null, S = 1, lift = 1, fill = SITE.card } = {}) {
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,.5)";
  ctx.shadowBlur = 36 * S * lift;
  ctx.shadowOffsetY = 14 * S * lift;
  roundRect(ctx, x, y, w, h, r);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.restore();
  if (accent) {
    ctx.save();
    roundRect(ctx, x, y, w, h, r);
    ctx.clip();
    const g = ctx.createLinearGradient(x, y, x + w * 0.9, y + h);
    g.addColorStop(0, hexA(accent, 0.1));
    g.addColorStop(0.55, hexA(accent, 0.02));
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g;
    ctx.fillRect(x, y, w, h);
    ctx.restore();
  }
  // border: slightly brighter on top, dimmer at the bottom (top-lit)
  ctx.save();
  roundRect(ctx, x, y, w, h, r);
  const b = ctx.createLinearGradient(0, y, 0, y + h);
  b.addColorStop(0, accent ? hexA(accent, 0.38) : "rgba(255,255,255,.17)");
  b.addColorStop(1, accent ? hexA(accent, 0.12) : "rgba(255,255,255,.06)");
  ctx.lineWidth = Math.max(1, 1.2 * S);
  ctx.strokeStyle = b;
  ctx.stroke();
  // inner top light
  roundRect(ctx, x, y, w, h, r);
  ctx.clip();
  ctx.fillStyle = "rgba(255,255,255,.06)";
  ctx.fillRect(x + r * 0.5, y + 1, w - r, Math.max(1, 1.1 * S));
  ctx.restore();
}

/** The board's 24h change pill — `.chg.up` / `.chg.dn` from globals.css, with a
 *  drawn direction triangle. Dark ink on the bright gain gradient. */
function pctChip(ctx, x, y, text, size, S, { align = "c" } = {}) {
  if (!text) return 0;
  const up = !String(text).startsWith("-");
  const t = String(text).replace(/^[+-]/, "");
  ctx.save();
  ctx.font = `800 ${size}px ${F.m8}`;
  const tw = ctx.measureText(t).width;
  const tri = size * 0.5;
  const gap = size * 0.32;
  const padX = size * 0.66;
  const padY = size * 0.5;
  const w = padX * 2 + tri + gap + tw;
  const h = size + padY * 2;
  const left = align === "l" ? x : align === "r" ? x - w : x - w / 2;
  const top = y - h / 2;
  roundRect(ctx, left, top, w, h, h * 0.36);
  const g = ctx.createLinearGradient(left, top + h, left + w, top);
  g.addColorStop(0, up ? SITE.upTo : SITE.downTo);
  g.addColorStop(1, up ? SITE.upFrom : SITE.downFrom);
  ctx.shadowColor = hexA(up ? SITE.mint : SITE.red, 0.3);
  ctx.shadowBlur = 16 * S;
  ctx.shadowOffsetY = 4 * S;
  ctx.fillStyle = g;
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;
  const ink = up ? SITE.upInk : SITE.downInk;
  // direction triangle
  const tx = left + padX;
  const ty = y + size * 0.04;
  ctx.fillStyle = ink;
  ctx.beginPath();
  if (up) {
    ctx.moveTo(tx + tri / 2, ty - tri * 0.62);
    ctx.lineTo(tx + tri, ty + tri * 0.38);
    ctx.lineTo(tx, ty + tri * 0.38);
  } else {
    ctx.moveTo(tx + tri / 2, ty + tri * 0.62);
    ctx.lineTo(tx + tri, ty - tri * 0.38);
    ctx.lineTo(tx, ty - tri * 0.38);
  }
  ctx.closePath();
  ctx.fill();
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(t, tx + tri + gap, ty);
  ctx.restore();
  return w;
}

/** The move as TYPE — a large gradient mono figure with a direction triangle.
 *  Used where the % is a card's headline rather than a table cell. */
function bigPct(ctx, x, y, text, size, S, { align = "left" } = {}) {
  if (!text) return 0;
  const up = !String(text).startsWith("-");
  const t = String(text).replace(/^[+-]/, "");
  ctx.save();
  ctx.font = `800 ${size}px ${F.m8}`;
  ctx.letterSpacing = `${(-0.02 * size).toFixed(1)}px`;
  const tw = ctx.measureText(t).width;
  const tri = size * 0.44;
  const gap = size * 0.2;
  const total = tri + gap + tw;
  const left = align === "center" ? x - total / 2 : align === "right" ? x - total : x;
  const g = ctx.createLinearGradient(0, y - size * 0.9, 0, y + size * 0.1);
  g.addColorStop(0, up ? SITE.upFrom : SITE.downFrom);
  g.addColorStop(1, up ? SITE.mintDeep : SITE.downTo);
  ctx.fillStyle = g;
  ctx.shadowColor = hexA(up ? SITE.mint : SITE.red, 0.25);
  ctx.shadowBlur = 24 * S;
  ctx.beginPath();
  const tcy = y - size * 0.32;
  if (up) {
    ctx.moveTo(left + tri / 2, tcy - tri * 0.55);
    ctx.lineTo(left + tri, tcy + tri * 0.45);
    ctx.lineTo(left, tcy + tri * 0.45);
  } else {
    ctx.moveTo(left + tri / 2, tcy + tri * 0.55);
    ctx.lineTo(left + tri, tcy - tri * 0.45);
    ctx.lineTo(left, tcy - tri * 0.45);
  }
  ctx.closePath();
  ctx.fill();
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillText(t, left + tri + gap, y);
  ctx.letterSpacing = "0px";
  ctx.restore();
  return total;
}

/** A bordered mono chip — the site's `.ichip` / `.age-chip`. */
function chip(ctx, x, y, text, size, S, { color = SITE.muted, border = SITE.line2, bg = "rgba(255,255,255,.03)", align = "left", track = 0.12 } = {}) {
  ctx.save();
  ctx.font = `700 ${size}px ${F.m7}`;
  const t = String(text).toUpperCase();
  const spacing = size * track;
  const tw = [...t].reduce((a, c) => a + ctx.measureText(c).width, 0) + spacing * Math.max(0, t.length - 1);
  const padX = size * 0.85;
  const padY = size * 0.58;
  const w = tw + padX * 2;
  const h = size + padY * 2;
  const left = align === "right" ? x - w : align === "center" ? x - w / 2 : x;
  roundRect(ctx, left, y - h / 2, w, h, h * 0.34);
  ctx.fillStyle = bg;
  ctx.fill();
  ctx.lineWidth = Math.max(1, 1.1 * S);
  ctx.strokeStyle = border;
  ctx.stroke();
  ctx.restore();
  microLabel(ctx, left + padX, y + size * 0.36, t, { size, color, track, weight: 700 });
  return w;
}

/** Token avatar: circle-clipped logo, or the site's jewel-gradient monogram
 *  (visual.ts) when no logo decoded — never an empty disc. Neutral rim for
 *  everyone; rank is carried by the number, not a coloured ring. */
function avatar(ctx, img, cx, cy, d, symbol, S) {
  const r = d / 2;
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.clip();
  ctx.fillStyle = "#0A0E16";
  ctx.fillRect(cx - r, cy - r, d, d);
  if (img) {
    drawCover(ctx, img, cx - r, cy - r, d, d);
  } else {
    // FLAT disc — a soft vertical ramp within the jewel's mid/deep tones and a
    // white monogram. The radial-with-hotspot version read as a glossy Web-2.0
    // orb against the flat panels, which is exactly the "programmer art" tell.
    const [, c1, c2] = jewelFor(symbol);
    const g = ctx.createLinearGradient(cx, cy - r, cx, cy + r);
    g.addColorStop(0, c1);
    g.addColorStop(1, c2);
    ctx.fillStyle = g;
    ctx.fillRect(cx - r, cy - r, d, d);
    ctx.fillStyle = "rgba(241,245,251,.95)";
    ctx.font = `700 ${Math.round(d * 0.36)}px ${F.d7}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(monogramOf(symbol), cx, cy + d * 0.02);
  }
  ctx.restore();
  // ambient seat for the big feature avatars so the disc sits IN the card
  if (d >= 100 * S) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.shadowColor = "rgba(0,0,0,.45)";
    ctx.shadowBlur = 30 * S;
    ctx.shadowOffsetY = 10 * S;
    ctx.strokeStyle = "rgba(0,0,0,.01)";
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();
  }
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.lineWidth = Math.max(1.5, 2 * S);
  ctx.strokeStyle = "rgba(255,255,255,.14)";
  ctx.stroke();
}

/** Rank as an editorial two-digit numeral — "01", faint, mono. */
function rankNum(ctx, x, y, rank, size, { align = "right", pad = true } = {}) {
  ctx.save();
  ctx.font = `700 ${size}px ${F.m7}`;
  ctx.fillStyle = rank <= 3 ? rankColor(rank) : SITE.faint;
  ctx.textAlign = align;
  ctx.textBaseline = "middle";
  ctx.fillText(pad ? String(rank).padStart(2, "0") : String(rank), x, y);
  ctx.restore();
}

/** The site's sparkline for a token: smooth area chart, mint on gains, red on
 *  losses, with a lit end-point. Pure decoration at low weight — no axes. */
function sparkline(ctx, x, y, w, h, sym, pct, S, { alpha = 1 } = {}) {
  const pts = bannerTrend(sym, pct);
  const up = (Number(pct) || 0) >= 0;
  const col = up ? SITE.mint : SITE.red;
  const min = Math.min(...pts);
  const max = Math.max(...pts);
  const span = Math.max(1, max - min);
  const px = (k) => x + (k / (pts.length - 1)) * w;
  const py = (v) => y + h - ((v - min) / span) * h;
  ctx.save();
  ctx.globalAlpha = alpha;
  // Area fill on an OFFSCREEN tile so its trailing edge can be faded out with
  // destination-out — closed in place, the fill ended in a hard vertical wall
  // under the endpoint ("flag pole"), the tell of an unclipped polygon.
  try {
    const kit = require("./helpers/canvasKit");
    const cv2 = kit.canvasLib();
    const off = cv2.createCanvas(Math.max(2, Math.ceil(w + 2)), Math.max(2, Math.ceil(h + 2)));
    const o = off.getContext("2d");
    const opx = (k) => (k / (pts.length - 1)) * w;
    const opy = (v) => h - ((v - min) / span) * h;
    o.beginPath();
    o.moveTo(opx(0), h);
    o.lineTo(opx(0), opy(pts[0]));
    for (let k = 0; k < pts.length - 1; k++) {
      const mx = (opx(k) + opx(k + 1)) / 2;
      const my = (opy(pts[k]) + opy(pts[k + 1])) / 2;
      o.quadraticCurveTo(opx(k), opy(pts[k]), mx, my);
    }
    o.lineTo(opx(pts.length - 1), opy(pts[pts.length - 1]));
    o.lineTo(opx(pts.length - 1), h);
    o.closePath();
    const fg = o.createLinearGradient(0, 0, 0, h);
    fg.addColorStop(0, hexA(col, 0.2));
    fg.addColorStop(1, hexA(col, 0));
    o.fillStyle = fg;
    o.fill();
    o.globalCompositeOperation = "destination-out";
    const fade = o.createLinearGradient(Math.max(0, w - 40), 0, w, 0);
    fade.addColorStop(0, "rgba(0,0,0,0)");
    fade.addColorStop(1, "rgba(0,0,0,1)");
    o.fillStyle = fade;
    o.fillRect(Math.max(0, w - 40), 0, 42, h + 2);
    ctx.drawImage(off, x, y);
  } catch {
    /* fill is a finish, never a failure — the stroke below still draws */
  }
  // line
  ctx.beginPath();
  ctx.moveTo(px(0), py(pts[0]));
  for (let k = 0; k < pts.length - 1; k++) {
    const mx = (px(k) + px(k + 1)) / 2;
    const my = (py(pts[k]) + py(pts[k + 1])) / 2;
    ctx.quadraticCurveTo(px(k), py(pts[k]), mx, my);
  }
  ctx.lineTo(px(pts.length - 1), py(pts[pts.length - 1]));
  ctx.lineWidth = Math.max(1.5, 2 * S);
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.strokeStyle = hexA(col, 0.85);
  ctx.stroke();
  // end dot
  const ex = px(pts.length - 1);
  const ey = py(pts[pts.length - 1]);
  radial(ctx, ex, ey, 9 * S, col, 0.5);
  ctx.beginPath();
  ctx.arc(ex, ey, 2.6 * S, 0, Math.PI * 2);
  ctx.fillStyle = col;
  ctx.fill();
  ctx.restore();
}

const chainName = (id) => String(chainOf(id) ? chainOf(id).label : id || "").toUpperCase();
const CHAIN_TICKER = { solana: "SOL", ethereum: "ETH", bsc: "BSC", base: "BASE", robinhood: "HOOD", tron: "TRON", ton: "TON", sui: "SUI", plasma: "XPL", polygon: "POL", arbitrum: "ARB", optimism: "OP", avalanche: "AVAX", berachain: "BERA", sonic: "S", hyperevm: "HYPE", abstract: "ABS", apechain: "APE", blast: "BLAST", sei: "SEI", aptos: "APT", unichain: "UNI" };
const chainShort = (id) => CHAIN_TICKER[id] || chainName(id).slice(0, 5);

// ── page chrome ─────────────────────────────────────────────────────────────
/** Deterministic film grain, tiled — keeps the near-black gradients from
 *  banding and gives the dark field the "printed" finish flat canvas lacks. */
function grain(cv, ctx, W, H, S) {
  try {
    const t = 128;
    const tile = cv.createCanvas(t, t);
    const tctx = tile.getContext("2d");
    const img = tctx.createImageData(t, t);
    let seed = 0x9e3779b9;
    const rnd = () => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      seed >>>= 0;
      return seed / 0xffffffff;
    };
    for (let i = 0; i < img.data.length; i += 4) {
      const v = rnd() < 0.5 ? 255 : 0;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      img.data[i + 3] = Math.floor(rnd() * 11); // ≤ 4% alpha
    }
    tctx.putImageData(img, 0, 0);
    const pat = ctx.createPattern(tile, "repeat");
    if (pat) {
      ctx.save();
      ctx.fillStyle = pat;
      ctx.fillRect(0, 0, W, H);
      ctx.restore();
    }
  } catch {
    /* grain is a finish, never a failure */
  }
}

/** The site's page: #090C12 under a mint bloom top-right and a violet bloom
 *  left (the two radial-gradients on `body`), a whisper grid, film grain, and
 *  a mint→cyan keyline across the very top. */
function backdrop(cv, ctx, S, spec, bg) {
  const W = REF_W * S;
  const H = REF_H * S;
  if (bg) {
    drawCover(ctx, bg, 0, 0, W, H);
    const scrim = ctx.createLinearGradient(0, 0, 0, H);
    scrim.addColorStop(0, "rgba(9,12,18,.82)");
    scrim.addColorStop(0.5, "rgba(9,12,18,.68)");
    scrim.addColorStop(1, "rgba(9,12,18,.88)");
    ctx.fillStyle = scrim;
    ctx.fillRect(0, 0, W, H);
  } else {
    ctx.fillStyle = SITE.bg;
    ctx.fillRect(0, 0, W, H);
    radial(ctx, W * 0.8, -H * 0.18, W * 0.6, SITE.mint, 0.13);
    radial(ctx, -W * 0.06, H * 0.16, W * 0.5, SITE.violetDeep, 0.14);
    radial(ctx, W * 0.55, H * 1.08, W * 0.55, SITE.cyan, 0.06);
  }
  // whisper grid
  ctx.save();
  ctx.strokeStyle = "rgba(255,255,255,.016)";
  ctx.lineWidth = 1;
  for (let x = PAD * S; x <= W - PAD * S + 1; x += 64 * S) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, H);
    ctx.stroke();
  }
  ctx.restore();
  grain(cv, ctx, W, H, S);
  // vignette so the corners fall away
  const vg = ctx.createRadialGradient(W / 2, H * 0.44, H * 0.5, W / 2, H / 2, H * 1.12);
  vg.addColorStop(0, "rgba(0,0,0,0)");
  vg.addColorStop(1, "rgba(0,0,0,.42)");
  ctx.fillStyle = vg;
  ctx.fillRect(0, 0, W, H);
  // mint→cyan keyline across the very top
  const kl = ctx.createLinearGradient(0, 0, W, 0);
  kl.addColorStop(0, "rgba(61,245,159,0)");
  kl.addColorStop(0.2, hexA(SITE.mint, 0.85));
  kl.addColorStop(0.6, hexA(SITE.cyan, 0.85));
  kl.addColorStop(1, "rgba(34,211,238,0)");
  ctx.fillStyle = kl;
  ctx.fillRect(0, 0, W, Math.max(2, 3 * S));
}

/** Brand lockup + date/live chips + kicker + title. */
function header(ctx, S, spec, { n, dateText }) {
  const W = REF_W * S;
  const x = PAD * S;
  const right = W - PAD * S;

  // brand lockup
  drawBrandMark(ctx, x, 46 * S, 56 * S);
  displayText(ctx, x + 72 * S, 82 * S, "Dexvra", 32 * S, { weight: 700 });
  microLabel(ctx, x + 74 * S, 104 * S, "Discovery", { size: 10.5 * S, color: SITE.mint, track: 0.3 });

  // top-right: LIVE pill + date chip on one row
  let rx = right;
  if (dateText) rx -= chip(ctx, rx, 74 * S, dateText, 12.5 * S, S, { align: "right", color: SITE.muted }) + 14 * S;
  // Leading spaces reserve the dot's slot INSIDE the pill — a dot floating in
  // the gap outside the border read as a stray artifact, not a live indicator.
  const liveW = chip(ctx, rx, 74 * S, "   Live · 24H", 12.5 * S, S, {
    align: "right",
    color: SITE.mint,
    border: hexA(SITE.mint, 0.35),
    bg: hexA(SITE.mint, 0.08),
  });
  const dotX = rx - liveW + 17 * S;
  radial(ctx, dotX, 71.5 * S, 12 * S, SITE.mint, 0.55);
  ctx.beginPath();
  ctx.arc(dotX, 71.5 * S, 3.4 * S, 0, Math.PI * 2);
  ctx.fillStyle = SITE.mint;
  ctx.fill();

  // kicker + title
  microLabel(ctx, x + 2 * S, 164 * S, "Ranked by 24h change · live from dexvra.io", { size: 12 * S, color: SITE.mint, track: 0.24 });
  const title = String(spec.title(n) || "");
  let size = 62 * S;
  ctx.font = `700 ${size}px ${F.d7}`;
  while (size > 36 * S && ctx.measureText(title).width > W - 2 * PAD * S - 120 * S) {
    size -= 2 * S;
    ctx.font = `700 ${size}px ${F.d7}`;
  }
  const tw = displayText(ctx, x, 232 * S, title, size, { weight: 700 });
  const ug = ctx.createLinearGradient(x, 0, x + tw, 0);
  ug.addColorStop(0, hexA(spec.accent, 0.9));
  ug.addColorStop(1, hexA(spec.accent, 0));
  ctx.fillStyle = ug;
  // Full rendered width: a rule that terminates inside a glyph group reads as
  // arbitrary; spanning the whole title (with the gradient fade) reads designed.
  roundRect(ctx, x + 2 * S, 248 * S, tw, Math.max(2, 3 * S), 2 * S);
  ctx.fill();
}

/** Footer: tagline left, the site's `.btn-primary` gradient CTA right. */
function footer(ctx, S) {
  const W = REF_W * S;
  const x = PAD * S;
  const y = 820 * S;
  ctx.fillStyle = SITE.line;
  ctx.fillRect(x, y, W - 2 * PAD * S, 1);

  const bw0 = microLabel(ctx, x, y + 40 * S, "Dexvra · Discovery", { size: 12 * S, color: SITE.faint, track: 0.2 });
  ctx.save();
  ctx.font = `500 ${16 * S}px ${F.d5}`;
  ctx.fillStyle = SITE.muted;
  ctx.textBaseline = "alphabetic";
  // Tied to the brand cluster (fixed 24px gap) so the footer reads as one
  // left group + the CTA, not two strays and a hole.
  ctx.fillText("Find the next Moonshot", x + bw0 + 24 * S, y + 40 * S);
  ctx.restore();

  // CTA — the site's primary button: mint→cyan gradient, dark ink, top inset light
  const label = "dexvra.io";
  ctx.save();
  ctx.font = `700 ${17 * S}px ${F.d7}`;
  const tw = ctx.measureText(label).width;
  const bh = 46 * S;
  const bw = tw + 56 * S;
  const bx = W - PAD * S - bw;
  const by = y + 16 * S;
  roundRect(ctx, bx, by, bw, bh, bh / 2);
  const g = ctx.createLinearGradient(bx, by, bx + bw, by + bh);
  g.addColorStop(0, SITE.mint);
  g.addColorStop(1, SITE.cyan);
  ctx.shadowColor = "rgba(61,245,159,.32)";
  ctx.shadowBlur = 24 * S;
  ctx.shadowOffsetY = 8 * S;
  ctx.fillStyle = g;
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;
  // inset top light
  ctx.save();
  roundRect(ctx, bx, by, bw, bh, bh / 2);
  ctx.clip();
  ctx.fillStyle = "rgba(255,255,255,.5)";
  ctx.fillRect(bx + bh / 3, by + 1, bw - bh / 1.5, Math.max(1, 1.4 * S));
  ctx.restore();
  ctx.fillStyle = "#03150B";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(label, bx + bw / 2, by + bh / 2 + 1 * S);
  ctx.restore();
}

// ── board panels (list / rail / grid) ───────────────────────────────────────
/** One board panel: surface + the `.row.head` strip. Returns the rows' geometry
 *  and clips to the panel while `draw` runs, so row washes/accents stay inside
 *  the rounded corners. */
function boardPanel(ctx, S, { x, y, w, h, head, accent }, draw) {
  surface(ctx, x, y, w, h, 22 * S, { S, accent: null });
  const headH = 46 * S;
  ctx.save();
  roundRect(ctx, x, y, w, h, 22 * S);
  ctx.clip();
  // header strip — rgba(255,255,255,.03) with a hairline under it
  ctx.fillStyle = "rgba(255,255,255,.03)";
  ctx.fillRect(x, y, w, headH);
  ctx.fillStyle = SITE.line;
  ctx.fillRect(x, y + headH, w, 1);
  for (const c of head) microLabel(ctx, c.x, y + headH / 2 + 4 * S, c.label, { size: 10.5 * S, track: 0.16, align: c.align || "left" });
  draw({ top: y + headH + 1, height: h - headH - 1 });
  ctx.restore();
  void accent;
}

/** A row's furniture: hairline above (not the first), and the site's row-hover
 *  treatment on the leader — mint wash + 3px left accent bar. */
function rowBase(ctx, S, { x, w, y, h, first, leader, accent }) {
  if (!first) {
    ctx.fillStyle = SITE.line;
    ctx.fillRect(x, y, w, 1);
  }
  if (leader) {
    const g = ctx.createLinearGradient(x, 0, x + w * 0.75, 0);
    g.addColorStop(0, hexA(accent, 0.1));
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g;
    ctx.fillRect(x, y + 1, w, h - 1);
    ctx.fillStyle = accent;
    ctx.fillRect(x, y + 1, 3 * S, h - 1);
  }
}

/** list5 — the Dexvra board: one panel, real columns, sparklines. */
function layoutList(ctx, S, spec, coins) {
  const x = PAD * S;
  const w = (REF_W - 2 * PAD) * S;
  const n = coins.length;
  // column x-positions (right edges for numeric columns)
  // Even rhythm across the data half: TREND / PRICE / MCAP / 24H roughly
  // equidistant, so the table has no hollow band between the token cluster and
  // the first data column.
  const cChg = x + w - 28 * S;
  const cMcap = x + w - 268 * S;
  const cPrice = x + w - 490 * S;
  const sparkR = x + w - 700 * S;
  const sparkW = 190 * S;
  boardPanel(
    ctx,
    S,
    {
      x,
      y: BAND_TOP * S,
      w,
      h: BAND_H * S,
      accent: spec.accent,
      head: [
        { x: x + 52 * S, label: "#", align: "right" },
        { x: x + 78 * S, label: "Token" },
        { x: sparkR - sparkW / 2, label: "Trend", align: "center" },
        { x: cPrice, label: "Price", align: "right" },
        { x: cMcap, label: "Market cap", align: "right" },
        { x: cChg, label: "24h", align: "right" },
      ],
    },
    ({ top, height }) => {
      const rowH = height / n;
      coins.forEach((c, i) => {
        const rank = i + 1;
        const y = top + i * rowH;
        const cy = y + rowH / 2;
        rowBase(ctx, S, { x, w, y, h: rowH, first: i === 0, leader: rank === 1, accent: spec.accent });

        rankNum(ctx, x + 52 * S, cy, rank, 17 * S);
        const d = Math.min(54 * S, rowH * 0.62);
        avatar(ctx, c.img, x + 78 * S + d / 2, cy, d, c.symbol, S);

        const tx = x + 78 * S + d + 20 * S;
        const tw = sparkR - sparkW - 40 * S - tx;
        ctx.save();
        ctx.textBaseline = "alphabetic";
        ctx.fillStyle = SITE.text;
        const sym = fitText(ctx, `$${c.symbol}`, tw - 70 * S, { weight: 700, size: 25 * S, min: 15 * S, family: F.d7 });
        ctx.fillText(sym, tx, cy - 3 * S);
        const symW = ctx.measureText(sym).width;
        ctx.fillStyle = SITE.muted;
        ctx.fillText(fitText(ctx, c.name || "", tw, { weight: 500, size: 14.5 * S, min: 11 * S, family: F.d5 }), tx, cy + 22 * S);
        ctx.restore();
        // chain chip beside the ticker, like the site's tier tag
        chip(ctx, tx + symW + 12 * S, cy - 9 * S, chainShort(c.chain), 10 * S, S, { color: SITE.cyan, border: hexA(SITE.cyan, 0.3), bg: hexA(SITE.cyan, 0.07) });

        sparkline(ctx, sparkR - sparkW, cy - 17 * S, sparkW, 34 * S, c.symbol, c.pct, S, { alpha: 0.95 });

        const mono = (val, cx, color, size = 19 * S) => {
          ctx.save();
          ctx.font = `700 ${size}px ${F.m7}`;
          ctx.fillStyle = color;
          ctx.textAlign = "right";
          ctx.textBaseline = "middle";
          ctx.fillText(val, cx, cy + 1 * S);
          ctx.restore();
        };
        mono(c.price ? fmtPrice(c.price) : "—", cPrice, c.price ? SITE.muted : SITE.faint);
        mono(c.mcap ? fmtCap(c.mcap) : "—", cMcap, c.mcap ? SITE.text : SITE.faint);
        pctChip(ctx, cChg, cy, c.pctLabel, 20 * S, S, { align: "r" });
      });
    },
  );
}

/** rail8 / grid10 — two board panels side by side, rank order DOWN each panel. */
function layoutColumns(ctx, S, spec, coins, { rowsPerCol, big }) {
  const n = coins.length;
  const twoCol = n > rowsPerCol;
  const gapX = 24 * S;
  const panelW = twoCol ? ((REF_W - 2 * PAD) * S - gapX) / 2 : (REF_W - 2 * PAD) * S;
  const panels = twoCol ? 2 : 1;
  const perPanel = Math.ceil(n / panels);

  for (let p = 0; p < panels; p++) {
    const px = PAD * S + p * (panelW + gapX);
    const slice = coins.slice(p * perPanel, (p + 1) * perPanel);
    if (!slice.length) continue;
    const cChg = px + panelW - 22 * S;
    const cMcap = px + panelW - (big ? 168 : 152) * S;
    // rail8's tall rows earn a trend column; grid10's compact rows don't have
    // the height for one to read cleanly.
    const sparkW = big ? 104 * S : 0;
    const sparkR = big ? cMcap - 96 * S : 0;
    boardPanel(
      ctx,
      S,
      {
        x: px,
        y: BAND_TOP * S,
        w: panelW,
        h: BAND_H * S,
        accent: spec.accent,
        head: [
          { x: px + 46 * S, label: "#", align: "right" },
          { x: px + 70 * S, label: "Token" },
          ...(big ? [{ x: sparkR - sparkW / 2, label: "Trend", align: "center" }] : []),
          { x: cMcap, label: "MCap", align: "right" },
          { x: cChg, label: "24h", align: "right" },
        ],
      },
      ({ top, height }) => {
        const rowH = height / slice.length;
        slice.forEach((c, i) => {
          const rank = p * perPanel + i + 1;
          const y = top + i * rowH;
          const cy = y + rowH / 2;
          rowBase(ctx, S, { x: px, w: panelW, y, h: rowH, first: i === 0, leader: rank === 1, accent: spec.accent });

          rankNum(ctx, px + 46 * S, cy, rank, (big ? 16 : 15) * S);
          const d = Math.min((big ? 52 : 44) * S, rowH * 0.6);
          avatar(ctx, c.img, px + 70 * S + d / 2, cy, d, c.symbol, S);

          // Same information architecture as list5 — ticker + chain pill on the
          // first line, project name muted underneath — so the three table
          // layouts read as one system rather than three.
          const tx = px + 70 * S + d + 16 * S;
          const tw = (big ? sparkR - sparkW - 24 * S : cMcap - 84 * S) - tx;
          const tickY = big ? cy - 2 * S : cy - 3 * S;
          ctx.save();
          ctx.textBaseline = "alphabetic";
          ctx.fillStyle = SITE.text;
          const symTxt = fitText(ctx, `$${c.symbol}`, tw - 58 * S, { weight: 700, size: (big ? 22 : 20) * S, min: 13 * S, family: F.d7 });
          ctx.fillText(symTxt, tx, tickY);
          const symW = ctx.measureText(symTxt).width;
          ctx.fillStyle = SITE.muted;
          ctx.fillText(fitText(ctx, c.name || "", tw, { weight: 500, size: (big ? 13.5 : 12.5) * S, min: 10 * S, family: F.d5 }), tx, cy + 20 * S);
          ctx.restore();
          chip(ctx, tx + symW + 10 * S, tickY - 6 * S, chainShort(c.chain), (big ? 9.5 : 9) * S, S, { color: SITE.cyan, border: hexA(SITE.cyan, 0.3), bg: hexA(SITE.cyan, 0.07) });

          if (big) sparkline(ctx, sparkR - sparkW, cy - 15 * S, sparkW, 30 * S, c.symbol, c.pct, S, { alpha: 0.95 });
          if (c.mcap) {
            ctx.save();
            ctx.font = `700 ${(big ? 16 : 15) * S}px ${F.m7}`;
            ctx.fillStyle = SITE.muted;
            ctx.textAlign = "right";
            ctx.textBaseline = "middle";
            ctx.fillText(fmtCap(c.mcap), cMcap, cy + 1 * S);
            ctx.restore();
          }
          pctChip(ctx, cChg, cy, c.pctLabel, (big ? 17 : 16) * S, S, { align: "r" });
        });
      },
    );
  }
}

/** cards4 — four product cards; each card's headline is the MOVE, with the
 *  site's sparkline under it and an editorial faint rank numeral. */
function layoutCards(ctx, S, spec, coins) {
  const n = coins.length;
  const cols = n <= 2 ? n : 2;
  const rows = Math.ceil(n / cols);
  const gap = 24 * S;
  const cardW = ((REF_W - 2 * PAD) * S - gap * (cols - 1)) / cols;
  const cardH = Math.min(250 * S, (BAND_H * S - gap * (rows - 1)) / rows);
  const x0 = PAD * S;
  const y0 = BAND_TOP * S + (BAND_H * S - (cardH * rows + gap * (rows - 1))) / 2;

  coins.forEach((c, i) => {
    const rank = i + 1;
    const x = x0 + (i % cols) * (cardW + gap);
    const y = y0 + Math.floor(i / cols) * (cardH + gap);
    surface(ctx, x, y, cardW, cardH, 22 * S, { S, accent: rank === 1 ? spec.accent : null });

    // faint editorial rank numeral, top-right
    // Ghost numeral: gold for the winner ONLY, one neutral tone for the rest.
    // Tinting #3 orange made the eye pair 01+03 as "the special cards" and
    // rank 02 as an also-ran — a medal scale has to read 1 > 2 > 3 or not at all.
    ctx.save();
    ctx.font = `800 ${84 * S}px ${F.m8}`;
    ctx.fillStyle = rank === 1 ? hexA(rankColor(1), 0.16) : "rgba(255,255,255,.09)";
    ctx.textAlign = "right";
    ctx.textBaseline = "alphabetic";
    ctx.fillText(String(rank).padStart(2, "0"), x + cardW - 24 * S, y + 92 * S);
    ctx.restore();

    const padL = x + 30 * S;
    const d = 58 * S;
    avatar(ctx, c.img, padL + d / 2, y + 32 * S + d / 2, d, c.symbol, S);
    const tx = padL + d + 18 * S;
    const tw = cardW - 220 * S - (tx - x);
    ctx.save();
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = SITE.text;
    ctx.fillText(fitText(ctx, `$${c.symbol}`, tw, { weight: 700, size: 27 * S, min: 16 * S, family: F.d7 }), tx, y + 58 * S);
    ctx.fillStyle = SITE.muted;
    ctx.fillText(fitText(ctx, c.name || "", tw, { weight: 500, size: 14.5 * S, min: 11 * S, family: F.d5 }), tx, y + 82 * S);
    ctx.restore();

    // the move — the card's headline — with the trend under it
    bigPct(ctx, padL, y + cardH - 68 * S, c.pctLabel, 46 * S, S);
    sparkline(ctx, x + cardW - 210 * S, y + cardH - 106 * S, 176 * S, 52 * S, c.symbol, c.pct, S, { alpha: 0.9 });

    // footer micro-stats
    const fy = y + cardH - 26 * S;
    // muted, not faint: this line carries DATA, and at social-feed scale the
    // faint tone fell below comfortable legibility.
    microLabel(ctx, padL, fy, `${chainShort(c.chain)}${c.price ? `  ·  ${fmtPrice(c.price)}` : ""}${c.mcap ? `  ·  MC ${fmtCap(c.mcap)}` : ""}`, {
      size: 11.5 * S,
      track: 0.14,
      color: SITE.muted,
    });
  });
}

/** podium — three tall cards, winner raised; the % is each card's hero figure,
 *  a low-alpha trend area breathes across the card's lower half. */
function layoutPodium(ctx, S, spec, coins) {
  const n = coins.length;
  const order = n >= 3 ? [1, 0, 2] : n === 2 ? [1, 0] : [0];
  const slots = order.filter((i) => coins[i]);
  const gapX = 24 * S;
  const colW = ((REF_W - 2 * PAD) * S - gapX * (slots.length - 1)) / slots.length;
  const bottom = BAND_BOTTOM * S;

  slots.forEach((idx, col) => {
    const c = coins[idx];
    const rank = idx + 1;
    const rc = rankColor(rank);
    const winner = rank === 1;
    const h = winner ? BAND_H * S : (BAND_H - 40) * S;
    const x = PAD * S + col * (colW + gapX);
    const y = bottom - h;
    const cx = x + colW / 2;
    surface(ctx, x, y, colW, h, 24 * S, { S, accent: rc, lift: winner ? 1.5 : 1 });

    chip(ctx, cx, y + 42 * S, winner ? "#1 · Top gainer" : `#${rank}`, 12.5 * S, S, {
      align: "center",
      color: rc,
      border: hexA(rc, 0.4),
      bg: hexA(rc, 0.1),
    });

    const d = (winner ? 108 : 96) * S;
    const lcy = y + h * 0.3;
    if (winner) radial(ctx, cx, lcy, d * 1.35, SITE.mint, 0.14);
    avatar(ctx, c.img, cx, lcy, d, c.symbol, S);

    // Winner's type must OUTRANK the sides (≥1.4× on the figure), or the three
    // metric blocks read as equals and the podium is carried only by elevation.
    const tickSize = winner ? 44 : 31;
    const pctSize = winner ? 68 : 44;
    ctx.save();
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = SITE.text;
    ctx.font = `700 ${tickSize * S}px ${F.d7}`;
    ctx.letterSpacing = `${(-0.02 * tickSize * S).toFixed(1)}px`;
    const tickerY = lcy + d / 2 + 42 * S;
    ctx.fillText(fitText(ctx, `$${c.symbol}`, colW - 56 * S, { weight: 700, size: tickSize * S, min: 18 * S, family: F.d7 }), cx, tickerY);
    ctx.letterSpacing = "0px";
    ctx.fillStyle = SITE.muted;
    ctx.fillText(fitText(ctx, c.name || "", colW - 60 * S, { weight: 500, size: 16 * S, min: 11 * S, family: F.d5 }), cx, tickerY + 28 * S);
    ctx.restore();

    // the hero figure — positioned OFF the name, so no fixed fraction can ever
    // collide with the identity block above it. No "24H CHANGE" label here: the
    // header kicker already says it, and a label was what collided last time.
    bigPct(ctx, cx, tickerY + 28 * S + (winner ? 96 : 78) * S, c.pctLabel, pctSize * S, S, { align: "center" });

    // a clean sparkline strip between the figure and the stat divider — its own
    // band, clipped, so the curve can never slice through a glyph or the rule
    const stripTop = y + h - 84 * S - 56 * S;
    ctx.save();
    roundRect(ctx, x, y, colW, h, 24 * S);
    ctx.clip();
    sparkline(ctx, cx - (colW - 140 * S) / 2, stripTop, colW - 140 * S, 42 * S, c.symbol, c.pct, S, { alpha: 0.8 });
    ctx.restore();

    // footer stats split by a hairline
    ctx.fillStyle = SITE.line;
    ctx.fillRect(x + 30 * S, y + h - 84 * S, colW - 60 * S, 1);
    const stat = (label, value, sx, align) => {
      microLabel(ctx, sx, y + h - 54 * S, label, { size: 10 * S, track: 0.2, align, color: SITE.faint });
      ctx.save();
      ctx.font = `700 ${17 * S}px ${F.m7}`;
      ctx.fillStyle = SITE.muted;
      ctx.textAlign = align === "right" ? "right" : "left";
      ctx.textBaseline = "alphabetic";
      ctx.fillText(value, sx, y + h - 26 * S);
      ctx.restore();
    };
    stat("Chain", chainShort(c.chain), x + 30 * S, "left");
    if (c.mcap) stat("Mkt cap", fmtCap(c.mcap), x + colW - 30 * S, "right");
    else if (c.price) stat("Price", fmtPrice(c.price), x + colW - 30 * S, "right");
  });
}

/** hero1 — the biggest mover as a product-launch card: kicker, giant figures,
 *  stat tiles, a big trend area, and an editorial "01" watermark. */
function layoutHero(ctx, S, spec, coins) {
  const c = coins[0];
  if (!c) return;
  const x = PAD * S;
  const w = (REF_W - 2 * PAD) * S;
  const y = BAND_TOP * S;
  const h = BAND_H * S;
  surface(ctx, x, y, w, h, 26 * S, { S, accent: SITE.mint, lift: 1.5 });

  // The avatar sits at ~0.70w so it bridges the text stack and the right edge
  // instead of leaving a hollow centre; the editorial "01" lives at the far
  // right where the avatar no longer buries it; the trend area rises through
  // the card's midfield underneath both.
  const heroD = 190 * S;
  const heroX = x + w * 0.70;
  const heroY = y + h * 0.40;
  ctx.save();
  roundRect(ctx, x, y, w, h, 26 * S);
  ctx.clip();
  sparkline(ctx, x + w * 0.44, y + h * 0.30, w * 0.53, h * 0.62, c.symbol, c.pct, S, { alpha: 0.2 });
  ctx.font = `800 ${290 * S}px ${F.m8}`;
  ctx.fillStyle = "rgba(255,255,255,.04)";
  ctx.textAlign = "right";
  ctx.textBaseline = "alphabetic";
  ctx.fillText("01", x + w - 26 * S, y + 300 * S);
  ctx.restore();

  const px = x + 52 * S;
  microLabel(ctx, px, y + 62 * S, "Biggest 24h mover", { size: 13 * S, color: SITE.mint, track: 0.26 });

  const textW = w - 220 * S - heroD;

  ctx.save();
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = SITE.text;
  ctx.font = `700 ${80 * S}px ${F.d7}`;
  ctx.letterSpacing = `${(-1.6 * S).toFixed(1)}px`;
  ctx.fillText(fitText(ctx, `$${c.symbol}`, textW, { weight: 700, size: 80 * S, min: 36 * S, family: F.d7 }), px, y + 152 * S);
  ctx.letterSpacing = "0px";
  ctx.fillStyle = SITE.muted;
  ctx.fillText(fitText(ctx, c.name || "", textW, { weight: 500, size: 23 * S, min: 14 * S, family: F.d5 }), px, y + 190 * S);
  ctx.restore();

  bigPct(ctx, px, y + 322 * S, c.pctLabel, 118 * S, S);

  // stat tiles
  const tiles = [
    { l: "Chain", v: chainName(c.chain) || "—" },
    ...(c.price ? [{ l: "Price", v: fmtPrice(c.price) }] : []),
    ...(c.mcap ? [{ l: "Market cap", v: fmtCap(c.mcap) }] : []),
  ].slice(0, 3);
  const tileW = Math.min(206 * S, (textW - 32 * S) / Math.max(1, tiles.length));
  const tileH = 86 * S;
  tiles.forEach((t, i) => {
    const tx = px + i * (tileW + 16 * S);
    const ty = y + h - 44 * S - tileH;
    roundRect(ctx, tx, ty, tileW, tileH, 14 * S);
    // Opaque surface: a trend line showing through a stat chip reads as noise
    // inside the data, not depth.
    ctx.fillStyle = "rgba(13,17,25,.92)";
    ctx.fill();
    roundRect(ctx, tx, ty, tileW, tileH, 14 * S);
    ctx.fillStyle = "rgba(255,255,255,.04)";
    ctx.fill();
    ctx.lineWidth = Math.max(1, 1.1 * S);
    ctx.strokeStyle = SITE.line;
    ctx.stroke();
    microLabel(ctx, tx + 18 * S, ty + 30 * S, t.l, { size: 10.5 * S, track: 0.2 });
    ctx.save();
    ctx.font = `700 ${21 * S}px ${F.m7}`;
    ctx.fillStyle = SITE.text;
    ctx.textBaseline = "alphabetic";
    ctx.fillText(fitText(ctx, t.v, tileW - 36 * S, { weight: 700, size: 21 * S, min: 13 * S, family: F.m7 }), tx + 18 * S, ty + 62 * S);
    ctx.restore();
  });

  // hero avatar + gold #1 chip
  radial(ctx, heroX, heroY, heroD * 0.95, SITE.mint, 0.16);
  avatar(ctx, c.img, heroX, heroY, heroD, c.symbol, S);
  chip(ctx, heroX, heroY + heroD / 2 + 34 * S, "#1 Gainer", 13 * S, S, {
    align: "center",
    color: SITE.gold,
    border: hexA(SITE.gold, 0.4),
    bg: hexA(SITE.gold, 0.12),
  });
}

const LAYOUTS = {
  hero: layoutHero,
  podium: layoutPodium,
  cards: layoutCards,
  list: layoutList,
  rail: (ctx, S, spec, coins) => layoutColumns(ctx, S, spec, coins, { rowsPerCol: 4, big: true }),
  grid: (ctx, S, spec, coins) => layoutColumns(ctx, S, spec, coins, { rowsPerCol: 5, big: false }),
};

// ── render ──────────────────────────────────────────────────────────────────
/** Decode a coin's logo bytes once (async), attaching `img`. Never throws. */
async function decodeLogos(cv, coins) {
  await Promise.all(
    coins.map(async (c) => {
      if (!c.logo) return;
      try {
        c.img = await cv.loadImage(c.logo);
      } catch {
        c.img = null; // undecodable → the site's jewel monogram
      }
    }),
  );
  return coins;
}

/** Optional admin background artwork. A missing/broken file is ignored — the
 *  procedural backdrop is always available underneath. */
async function loadBackground(cv, bgPath) {
  if (!bgPath) return null;
  try {
    if (!fss.existsSync(bgPath)) return null;
    return await cv.loadImage(fss.readFileSync(bgPath));
  } catch (e) {
    log.debug(`[gainers] background ${bgPath}: ${e.message}`);
    return null;
  }
}

/**
 * Render a gainers banner.
 *
 * @param {object} o
 * @param {string} o.template   template id (see TEMPLATE_IDS)
 * @param {Array}  o.coins      gainers.js coins (each may carry a `logo` Buffer)
 * @param {string} o.dateText   date line, or "" to hide it
 * @param {string} o.bgPath     optional admin-uploaded background artwork
 * @param {number} o.scale      output scale (1 = 1600×900)
 * @returns {Promise<Buffer|null>} PNG/JPEG buffer, or null on ANY failure
 */
async function render({ template = DEFAULT_TEMPLATE, coins = [], dateText = "", bgPath = "", scale = 1 } = {}) {
  const cv = canvasLib();
  if (!cv) return null;
  const spec = specOf(template);
  const list = (coins || []).filter(Boolean).slice(0, spec.n);
  if (!list.length) return null; // nothing real to show → the caller posts nothing
  try {
    const S = Math.max(0.5, Math.min(2, Number(scale) || 1));
    const W = Math.round(REF_W * S);
    const H = Math.round(REF_H * S);
    const canvas = cv.createCanvas(W, H);
    const ctx = canvas.getContext("2d");
    ctx.textBaseline = "alphabetic";
    ctx.textAlign = "left";

    // One formatter for the % on the artwork AND in the caption (helpers/format),
    // so a banner can never print a different number than the text beside it.
    for (const c of list) c.pctLabel = fmtPct(c.pct);
    await decodeLogos(cv, list);
    const bg = await loadBackground(cv, bgPath);

    backdrop(cv, ctx, S, spec, bg);
    header(ctx, S, spec, { n: list.length, dateText });
    (LAYOUTS[spec.layout] || layoutList)(ctx, S, spec, list);
    footer(ctx, S);

    return toSendBuffer(canvas);
  } catch (e) {
    log.warn(`[gainers] ${template} render failed: ${e.message}`);
    return null;
  }
}

module.exports = {
  TEMPLATES,
  TEMPLATE_IDS,
  DEFAULT_TEMPLATE,
  REF_W,
  REF_H,
  templateList,
  specOf,
  countOf,
  labelOf,
  isTemplate,
  pickTemplate,
  render,
  available: () => !!canvasLib(),
  // exposed for tests / the preview script
  _internals: { LAYOUTS, syntheticTrend, bannerTrend, jewelFor, monogramOf },
};
