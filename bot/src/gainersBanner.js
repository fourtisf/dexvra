// Top-Gainers banners — six premium layouts, drawn with @napi-rs/canvas.
//
// This is the fourtis "gainers banner" idea rebuilt for Dexvra: the operator
// picks a layout in @dexvraadminbot, the live top movers (gainers.js) are burned
// into it — logo, $TICKER, name, 24h %, market cap — and the finished PNG goes to
// a channel. Unlike fourtis it needs no designed JPG per layout and no Python:
// every pixel is procedural, so a layout works the moment the code ships and
// adapts to however many real gainers exist right now.
//
// THE CONTRACT (same shape as the per-token cards in bannerRender.js):
//   • render() NEVER throws and never rejects — any failure resolves null, and
//     null means the caller posts nothing rather than posting something wrong.
//   • The layout is driven by coins.length, never by the template's nominal
//     size. Three live gainers on the "Top 5" layout draws three rows, centred,
//     titled "TOP 3 GAINERS" — never two empty slots.
//   • No number is invented here. A coin with no market cap simply doesn't get
//     that line; the % comes from gainers.js, which drops unpriced tokens.
//
// Coordinates are written in a 1600×900 reference space and multiplied by S, so
// a template can change output size without a re-layout.
const fss = require("node:fs");
const { toSendBuffer } = require("./helpers/encodeImage");
const {
  canvasLib,
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
} = require("./helpers/canvasKit");
const { fmtCap, fmtPrice, fmtPct } = require("./helpers/format");
const { chainOf } = require("./config/chains");
const log = require("./helpers/logger");

const REF_W = 1600;
const REF_H = 900;

// ── Templates ───────────────────────────────────────────────────────────────
// `n` is the MAXIMUM number of slots (what the admin picks and what gainers.js
// is asked to fetch); the layout draws min(n, coins.length).
// Accents stay inside the Dexvra palette — the variety comes from composition,
// not from six unrelated colour schemes.
const TEMPLATES = {
  hero1: {
    id: "hero1",
    label: "👑 #1 Spotlight",
    blurb: "One hero card for the single biggest 24h mover.",
    n: 1,
    layout: "hero",
    accent: MINT,
    accent2: CYAN,
    title: () => "TOP GAINER",
  },
  podium: {
    id: "podium",
    label: "🏆 Top 3 Podium",
    blurb: "Gold / silver / bronze pedestals — the classic winners' shot.",
    n: 3,
    layout: "podium",
    accent: "#FFD24D",
    accent2: MINT,
    title: (n) => (n >= 3 ? "TOP 3 GAINERS" : `TOP ${n} GAINER${n > 1 ? "S" : ""}`),
  },
  cards4: {
    id: "cards4",
    label: "🃏 Top 4 Cards",
    blurb: "Four big glass cards, 2×2 — logo, ticker, name and %.",
    n: 4,
    layout: "cards",
    accent: CYAN,
    accent2: MINT,
    title: (n) => `TOP ${n} GAINERS`,
  },
  list5: {
    id: "list5",
    label: "📋 Top 5 List",
    blurb: "Ranked leaderboard rows — the most readable layout.",
    n: 5,
    layout: "list",
    accent: MINT,
    accent2: CYAN,
    title: (n) => `TOP ${n} GAINERS`,
  },
  rail8: {
    id: "rail8",
    label: "🎞 Top 8 Rail",
    blurb: "Two columns of four — fourtis' Top-8 shape, Dexvra styling.",
    n: 8,
    layout: "rail",
    accent: CYAN,
    accent2: DEEP,
    title: (n) => `TOP ${n} GAINERS`,
  },
  grid10: {
    id: "grid10",
    label: "🔟 Top 10 Grid",
    blurb: "The full top ten, two compact columns of five.",
    n: 10,
    layout: "grid",
    accent: DEEP,
    accent2: CYAN,
    title: (n) => `TOP ${n} GAINERS`,
  },
};
const TEMPLATE_IDS = Object.keys(TEMPLATES);
const DEFAULT_TEMPLATE = "list5";

const specOf = (id) => TEMPLATES[id] || TEMPLATES[DEFAULT_TEMPLATE];
const countOf = (id) => specOf(id).n;
const labelOf = (id) => specOf(id).label;
const isTemplate = (id) => Object.prototype.hasOwnProperty.call(TEMPLATES, id);
const templateList = () => TEMPLATE_IDS.map((id) => ({ ...TEMPLATES[id] }));

/**
 * Resolve a template choice. `"random"` (or anything unknown) picks from `pool`
 * — the admin's chosen rotation, or every template when that is empty.
 * `rng` is injectable so a test can pin the choice.
 */
function pickTemplate(id, { pool = [], rng = Math.random } = {}) {
  if (isTemplate(id)) return id;
  const from = (pool || []).filter(isTemplate);
  const list = from.length ? from : TEMPLATE_IDS;
  return list[Math.floor(rng() * list.length) % list.length];
}

// ── drawing helpers ─────────────────────────────────────────────────────────
/** Cover-fit an image into a box (the CSS `object-fit: cover` maths). */
function drawCover(ctx, img, x, y, w, h) {
  const s = Math.max(w / img.width, h / img.height);
  const iw = img.width * s;
  const ih = img.height * s;
  ctx.drawImage(img, x + (w - iw) / 2, y + (h - ih) / 2, iw, ih);
}

/** The base surface: brand gradient, aurora, a diagonal light ray, a whisper
 *  dot grid, a vignette and a hairline inner frame. With `bg` (an admin-uploaded
 *  artwork) the photo replaces the gradient and gets a scrim so text stays
 *  legible — the aurora is skipped so two light sources don't fight. */
function backdrop(ctx, S, spec, bg) {
  const W = REF_W * S;
  const H = REF_H * S;
  if (bg) {
    drawCover(ctx, bg, 0, 0, W, H);
    const scrim = ctx.createLinearGradient(0, 0, 0, H);
    scrim.addColorStop(0, "rgba(5,9,14,.78)");
    scrim.addColorStop(0.5, "rgba(5,9,14,.62)");
    scrim.addColorStop(1, "rgba(5,9,14,.84)");
    ctx.fillStyle = scrim;
    ctx.fillRect(0, 0, W, H);
  } else {
    const base = ctx.createLinearGradient(0, 0, W * 0.6, H);
    base.addColorStop(0, "#0B141D");
    base.addColorStop(0.55, "#080F16");
    base.addColorStop(1, "#05090E");
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, W, H);
    // aurora — two symmetric blooms behind the header and under the content
    radial(ctx, W * 0.5, -H * 0.16, W * 0.62, spec.accent, 0.17);
    radial(ctx, W * 0.08, H * 0.92, W * 0.46, spec.accent2, 0.13);
    radial(ctx, W * 0.94, H * 1.02, W * 0.44, spec.accent, 0.1);
    // one diagonal catch-light across the whole card
    ctx.save();
    ctx.translate(W * 0.66, -H * 0.1);
    ctx.rotate(0.42);
    const ray = ctx.createLinearGradient(0, 0, 320 * S, 0);
    ray.addColorStop(0, "rgba(150,245,225,0)");
    ray.addColorStop(0.5, "rgba(150,245,225,.05)");
    ray.addColorStop(1, "rgba(150,245,225,0)");
    ctx.fillStyle = ray;
    ctx.fillRect(0, 0, 320 * S, H * 1.6);
    ctx.restore();
  }
  // dot grid
  ctx.save();
  ctx.fillStyle = "rgba(150,195,200,.05)";
  const step = 40 * S;
  for (let y = step; y < H; y += step) {
    for (let x = step; x < W; x += step) {
      ctx.beginPath();
      ctx.arc(x, y, Math.max(1, 1.2 * S), 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
  // vignette
  const vg = ctx.createRadialGradient(W / 2, H / 2, H * 0.32, W / 2, H / 2, H * 1.05);
  vg.addColorStop(0, "rgba(0,0,0,0)");
  vg.addColorStop(1, "rgba(0,0,0,.55)");
  ctx.fillStyle = vg;
  ctx.fillRect(0, 0, W, H);
  // top accent rule
  ctx.fillStyle = hexA(spec.accent, 0.85);
  ctx.fillRect(0, 0, W, Math.max(2, 4 * S));
  // inner hairline frame
  roundRect(ctx, 22 * S, 22 * S, W - 44 * S, H - 44 * S, 34 * S);
  const fr = ctx.createLinearGradient(0, 0, W, H);
  fr.addColorStop(0, hexA(spec.accent, 0.3));
  fr.addColorStop(0.5, "rgba(255,255,255,.06)");
  fr.addColorStop(1, hexA(spec.accent2, 0.26));
  ctx.lineWidth = Math.max(1, 1.6 * S);
  ctx.strokeStyle = fr;
  ctx.stroke();
}

// Display-title tracking. Deliberately tight: at 4px a narrow glyph still reads
// as part of its word. At 6px the "I" in GAINERS detached into a bar of its own
// and the title read "GA NERS" — worse, the separate blurred glow pass bloomed
// hardest on exactly those narrow glyphs, so the stray bar was also the
// brightest thing on the banner. The glow now rides on the gradient fill (ONE
// pass), which is why nothing accumulates per glyph any more.
const TITLE_TRACKING = 4;

/** A metallic display title: drop shadow, then a white→accent vertical gradient
 *  fill carrying its own accent glow. */
function displayTitle(ctx, cx, y, text, size, accent, S) {
  const tracking = TITLE_TRACKING * S;
  ctx.save();
  ctx.textAlign = "left"; // trackedCenter positions each glyph itself
  ctx.textBaseline = "alphabetic";
  ctx.font = `800 ${size}px ${F.x}`;
  // depth shadow
  ctx.fillStyle = "rgba(0,0,0,.5)";
  trackedCenter(ctx, cx + 2 * S, y + 3 * S, text, tracking);
  // metallic fill + glow, in a single pass
  const g = ctx.createLinearGradient(0, y - size * 0.86, 0, y + size * 0.22);
  g.addColorStop(0, "#FFFFFF");
  g.addColorStop(0.55, "#EAF7F4");
  g.addColorStop(1, hexA(accent, 1));
  ctx.fillStyle = g;
  ctx.shadowColor = hexA(accent, 0.5);
  ctx.shadowBlur = 26 * S;
  const w = trackedCenter(ctx, cx, y, text, tracking);
  ctx.restore();
  return w;
}

/** Kicker + title + gradient underline + date. Returns the content-area top. */
function header(ctx, S, spec, { n, dateText, showDate }) {
  const W = REF_W * S;
  const cx = W / 2;
  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  // kicker
  ctx.font = `700 ${20 * S}px ${F.b}`;
  ctx.fillStyle = hexA(spec.accent, 0.95);
  trackedCenter(ctx, cx, 72 * S, "LIVE · DEXVRA.IO", 7 * S);
  ctx.restore();

  const title = String(spec.title(n) || "").toUpperCase();
  // Shrink the title before it can touch the frame (long titles never wrap).
  // The tracking is part of the measured width — without it a title that "fits"
  // at 0 tracking still overflows once every gap is added.
  let size = 74 * S;
  ctx.font = `800 ${size}px ${F.x}`;
  const runW = () => ctx.measureText(title).width + TITLE_TRACKING * S * Math.max(0, title.length - 1);
  while (size > 42 * S && runW() > W - 260 * S) {
    size -= 2 * S;
    ctx.font = `800 ${size}px ${F.x}`;
  }
  const titleY = 152 * S;
  const tw = displayTitle(ctx, cx, titleY, title, size, spec.accent, S);

  // underline: accent in the middle, fading both ways
  const uw = Math.max(220 * S, Math.min(tw * 0.9, W * 0.42));
  const uy = titleY + 26 * S;
  const ug = ctx.createLinearGradient(cx - uw / 2, 0, cx + uw / 2, 0);
  ug.addColorStop(0, hexA(spec.accent, 0));
  ug.addColorStop(0.5, hexA(spec.accent, 0.95));
  ug.addColorStop(1, hexA(spec.accent, 0));
  ctx.fillStyle = ug;
  roundRect(ctx, cx - uw / 2, uy, uw, Math.max(3, 5 * S), 3 * S);
  ctx.fill();

  if (showDate && dateText) {
    ctx.save();
    ctx.textAlign = "center";
    ctx.font = `600 ${22 * S}px ${F.s}`;
    ctx.fillStyle = SOFT;
    trackedCenter(ctx, cx, uy + 44 * S, String(dateText).toUpperCase(), 3 * S);
    ctx.restore();
    return uy + 78 * S;
  }
  return uy + 40 * S;
}

/** Gem + wordmark on the left, a "24H · dexvra.io" chip on the right. */
function footer(ctx, S, spec) {
  const W = REF_W * S;
  const H = REF_H * S;
  const y = H - 62 * S;
  drawGem(ctx, 62 * S, y - 26 * S, 46 * S);
  ctx.save();
  ctx.textBaseline = "middle";
  ctx.fillStyle = INK;
  ctx.font = `800 ${28 * S}px ${F.x}`;
  ctx.letterSpacing = `${2 * S}px`;
  ctx.fillText("DEXVRA", 118 * S, y - 12 * S);
  ctx.fillStyle = FAINT;
  ctx.font = `600 ${15 * S}px ${F.s}`;
  ctx.fillText("LISTING · TRENDING · ADS", 119 * S, y + 14 * S);
  ctx.letterSpacing = "0px";

  // right-hand chip
  const label = "24H CHANGE · DEXVRA.IO";
  ctx.font = `700 ${18 * S}px ${F.b}`;
  const tw = ctx.measureText(label).width + 3 * S * label.length;
  const pad = 26 * S;
  const h = 48 * S;
  const x = W - 62 * S - (tw + pad * 2);
  roundRect(ctx, x, y - h / 2, tw + pad * 2, h, h / 2);
  ctx.fillStyle = "rgba(255,255,255,.05)";
  ctx.fill();
  ctx.lineWidth = Math.max(1, 1.3 * S);
  ctx.strokeStyle = hexA(spec.accent, 0.45);
  ctx.stroke();
  ctx.textAlign = "center";
  ctx.fillStyle = hexA(spec.accent, 0.95);
  trackedCenter(ctx, x + (tw + pad * 2) / 2, y + 1 * S, label, 3 * S);
  ctx.restore();
}

/** Frosted glass panel — drop shadow, gradient fill, hairline border, top sheen
 *  and an optional coloured halo (used to tint the top-3 rows gold/silver/bronze). */
function glass(ctx, x, y, w, h, r, { glow = null, fill = 0.075, S = 1 } = {}) {
  if (glow) {
    ctx.save();
    roundRect(ctx, x, y, w, h, r);
    ctx.shadowColor = hexA(glow, 0.4);
    ctx.shadowBlur = 34 * S;
    ctx.fillStyle = hexA(glow, 0.06);
    ctx.fill();
    ctx.restore();
  }
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,.45)";
  ctx.shadowBlur = 26 * S;
  ctx.shadowOffsetY = 10 * S;
  roundRect(ctx, x, y, w, h, r);
  const g = ctx.createLinearGradient(x, y, x, y + h);
  g.addColorStop(0, `rgba(255,255,255,${fill * 1.5})`);
  g.addColorStop(1, `rgba(255,255,255,${fill * 0.35})`);
  ctx.fillStyle = g;
  ctx.fill();
  ctx.restore();
  // hairline border
  roundRect(ctx, x, y, w, h, r);
  const b = ctx.createLinearGradient(x, y, x + w, y + h);
  b.addColorStop(0, glow ? hexA(glow, 0.5) : "rgba(255,255,255,.16)");
  b.addColorStop(0.5, "rgba(255,255,255,.09)");
  b.addColorStop(1, glow ? hexA(glow, 0.28) : "rgba(255,255,255,.07)");
  ctx.lineWidth = Math.max(1, 1.4 * S);
  ctx.strokeStyle = b;
  ctx.stroke();
  // top sheen
  ctx.save();
  roundRect(ctx, x, y, w, h, r);
  ctx.clip();
  const sh = ctx.createLinearGradient(x, y, x, y + h * 0.45);
  sh.addColorStop(0, "rgba(255,255,255,.11)");
  sh.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = sh;
  ctx.fillRect(x, y, w, h * 0.45);
  ctx.restore();
}

/** The 24h % pill. Green for a gain, red for a loss — the sign is a colour
 *  before it is a character. `align` is where (x, y) sits: "l" | "c" | "r". */
function pctChip(ctx, x, y, text, size, S, { align = "c" } = {}) {
  if (!text) return 0;
  const up = !String(text).startsWith("-");
  const col = up ? RISE : FALL;
  const hi = up ? "#8CF7C8" : "#F5A79E";
  ctx.save();
  ctx.font = `800 ${size}px ${F.x}`;
  const tw = ctx.measureText(text).width;
  const padX = size * 0.62;
  const w = tw + padX * 2;
  const h = size * 1.86;
  const left = align === "l" ? x : align === "r" ? x - w : x - w / 2;
  const top = y - h / 2;
  // glow
  roundRect(ctx, left, top, w, h, h / 2);
  ctx.shadowColor = hexA(col, 0.45);
  ctx.shadowBlur = 22 * S;
  const g = ctx.createLinearGradient(left, top, left, top + h);
  g.addColorStop(0, hexA(hi, 0.95));
  g.addColorStop(1, hexA(col, 0.9));
  ctx.fillStyle = g;
  ctx.fill();
  ctx.shadowBlur = 0;
  roundRect(ctx, left, top, w, h, h / 2);
  ctx.lineWidth = Math.max(1, 1.6 * S);
  ctx.strokeStyle = hexA(hi, 0.9);
  ctx.stroke();
  ctx.fillStyle = "#05130D";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, left + w / 2, top + h / 2 + size * 0.04);
  ctx.restore();
  return w;
}

/** Circle-clipped token logo with a glow, a metallic rank ring and a rim
 *  highlight. No decoded image → a $SYMBOL monogram on the brand gradient, so a
 *  slot is never an empty white disc. */
function logoBadge(ctx, img, cx, cy, d, rank, S, { glow = true } = {}) {
  const r = d / 2;
  const m = medalOf(rank);
  const ring = rank <= 3 ? m.mid : CYAN;
  // Glow radius grows with the badge but its INTENSITY doesn't: at hero size
  // (d≈300) a flat 0.3 alpha over r*1.9 washed a third of the card in gold.
  if (glow) radial(ctx, cx, cy, r * 1.7, ring, 0.3 * Math.min(1, 150 / r));
  // face
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.clip();
  ctx.fillStyle = "#0B141C";
  ctx.fillRect(cx - r, cy - r, d, d);
  if (img) {
    drawCover(ctx, img, cx - r, cy - r, d, d);
  } else {
    ctx.fillStyle = brandGrad(ctx, cx - r, cy - r, cx + r, cy + r);
    ctx.fillRect(cx - r, cy - r, d, d);
  }
  ctx.restore();
  // ring
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r + Math.max(2, d * 0.035), 0, Math.PI * 2);
  ctx.lineWidth = Math.max(2, d * 0.07);
  ctx.strokeStyle = rank <= 3 ? metalGrad(ctx, cx, cy, r, m) : brandGrad(ctx, cx - r, cy - r, cx + r, cy + r);
  ctx.shadowColor = hexA(ring, 0.5);
  ctx.shadowBlur = 16 * S;
  ctx.stroke();
  ctx.restore();
  // inner rim highlight
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.lineWidth = Math.max(1, 1.6 * S);
  ctx.strokeStyle = "rgba(255,255,255,.18)";
  ctx.stroke();
  return r;
}

/** The monogram text drawn OVER a logo-less badge (kept separate so it uses the
 *  card's font sizing rather than the clip's). */
function monogram(ctx, symbol, cx, cy, d) {
  ctx.save();
  ctx.fillStyle = "#06121A";
  ctx.font = `800 ${Math.round(d * 0.36)}px ${F.x}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(String(symbol || "?").slice(0, 3).toUpperCase(), cx, cy + d * 0.02);
  ctx.restore();
}

/** A small medallion carrying "#N" — metallic ring, dark glass face, sparkle on
 *  the champion. Used where a full rank column would be noise. */
function rankMedal(ctx, cx, cy, r, rank, S) {
  const m = medalOf(rank);
  radial(ctx, cx, cy, r * 2.1, m.glow, 0.32);
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = "#080F16";
  ctx.shadowColor = "rgba(0,0,0,.6)";
  ctx.shadowBlur = 16 * S;
  ctx.fill();
  ctx.restore();
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.lineWidth = Math.max(2, r * 0.22);
  ctx.strokeStyle = metalGrad(ctx, cx, cy, r, m);
  ctx.stroke();
  // top sheen on the ring
  ctx.beginPath();
  ctx.arc(cx, cy, r, Math.PI * 1.1, Math.PI * 1.6);
  ctx.lineWidth = Math.max(2, r * 0.22);
  ctx.strokeStyle = "rgba(255,255,255,.5)";
  ctx.lineCap = "round";
  ctx.stroke();
  ctx.restore();
  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `800 ${Math.round(r * 0.98)}px ${F.x}`;
  const g = ctx.createLinearGradient(cx, cy - r, cx, cy + r);
  g.addColorStop(0, "#FFFFFF");
  g.addColorStop(1, m.light);
  ctx.fillStyle = g;
  ctx.fillText(String(rank), cx, cy + r * 0.06);
  ctx.restore();
  if (rank === 1) sparkle(ctx, cx + r * 0.86, cy - r * 0.82, r * 0.3, m.light);
}

/** "SOLANA · $1.2M" style meta line under a ticker. */
function metaLine(coin, { showChain = true, showMcap = true } = {}) {
  const bits = [];
  if (showChain && coin.chain) bits.push(String(chainOf(coin.chain) ? chainOf(coin.chain).label : coin.chain).toUpperCase());
  if (showMcap && coin.mcap) bits.push(fmtCap(coin.mcap));
  return bits.join("  ·  ");
}

/** A labelled glass metric tile (PRICE / MARKET CAP / LIQUIDITY). */
function metricTile(ctx, x, y, w, h, label, value, accent, S) {
  glass(ctx, x, y, w, h, 20 * S, { S, fill: 0.07 });
  ctx.save();
  roundRect(ctx, x, y, w, h, 20 * S);
  ctx.clip();
  const bar = ctx.createLinearGradient(x, y, x + w, y);
  bar.addColorStop(0, hexA(accent, 0));
  bar.addColorStop(0.5, hexA(accent, 0.9));
  bar.addColorStop(1, hexA(accent, 0));
  ctx.fillStyle = bar;
  ctx.fillRect(x, y, w, Math.max(2, 3 * S));
  ctx.restore();
  ctx.save();
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = MUTE;
  ctx.font = `700 ${14 * S}px ${F.b}`;
  ctx.letterSpacing = `${1.6 * S}px`;
  ctx.fillText(label, x + 22 * S, y + 36 * S);
  ctx.letterSpacing = "0px";
  ctx.fillStyle = INK;
  ctx.fillText(fitText(ctx, String(value), w - 44 * S, { weight: 700, size: 30 * S, min: 17 * S, family: F.b }), x + 22 * S, y + 76 * S);
  ctx.restore();
}

// ── layouts ─────────────────────────────────────────────────────────────────
// Every layout receives the already-decoded coins and the content band
// [top, bottom] left by the header/footer, and centres its own content in it.

/** #1 spotlight: hero logo on the right, the GAIN as the headline on the left. */
function layoutHero(ctx, S, spec, coins, top, bottom) {
  const W = REF_W * S;
  const c = coins[0];
  if (!c) return;
  const cy = (top + bottom) / 2;
  const x0 = 108 * S;
  const textW = 760 * S;
  // The left column is one vertical rhythm, spelled out so the blocks can't
  // collide: ticker → name → eyebrow → the % headline → metric tiles. The
  // eyebrow used to sit 4px above the % baseline, i.e. INSIDE its cap height.
  const PCT_SIZE = 112 * S;
  const symY = cy - 108 * S;
  const nameY = cy - 62 * S;
  const eyebrowY = cy - 16 * S;
  const pctY = cy + 84 * S;

  const sym = `$${c.symbol}`;
  ctx.save();
  ctx.textBaseline = "alphabetic";
  const symTxt = fitText(ctx, sym, textW, { weight: 800, size: 104 * S, min: 46 * S, family: F.x });
  ctx.save();
  ctx.shadowColor = hexA(spec.accent, 0.4);
  ctx.shadowBlur = 30 * S;
  ctx.fillStyle = brandGrad(ctx, x0, symY - 80 * S, x0 + 560 * S, symY);
  ctx.fillText(symTxt, x0, symY);
  ctx.restore();

  // name
  ctx.fillStyle = SOFT;
  ctx.fillText(fitText(ctx, c.name || "", textW, { weight: 500, size: 34 * S, min: 20 * S, family: F.m }), x0, nameY);

  // eyebrow, then the gain as the headline
  ctx.fillStyle = MUTE;
  ctx.font = `600 ${22 * S}px ${F.s}`;
  ctx.letterSpacing = `${2 * S}px`;
  ctx.fillText("PAST 24 HOURS", x0 + 4 * S, eyebrowY);
  ctx.letterSpacing = "0px";

  const pct = c.pctLabel || "";
  ctx.font = `800 ${PCT_SIZE}px ${F.x}`;
  const triW = 52 * S;
  ctx.save();
  ctx.shadowColor = hexA(RISE, 0.45);
  ctx.shadowBlur = 34 * S;
  ctx.fillStyle = RISE;
  ctx.beginPath();
  ctx.moveTo(x0 + triW / 2, pctY - 50 * S);
  ctx.lineTo(x0 + triW, pctY);
  ctx.lineTo(x0, pctY);
  ctx.closePath();
  ctx.fill();
  const gg = ctx.createLinearGradient(0, pctY - PCT_SIZE * 0.9, 0, pctY + PCT_SIZE * 0.1);
  gg.addColorStop(0, "#8CF7C8");
  gg.addColorStop(0.55, RISE);
  gg.addColorStop(1, "#12B87A");
  ctx.fillStyle = gg;
  ctx.fillText(pct, x0 + triW + 24 * S, pctY);
  ctx.restore();
  ctx.restore();

  // metric tiles
  const tiles = [{ l: "CHAIN", v: metaLine(c, { showMcap: false }) || "—" }];
  if (c.price) tiles.push({ l: "PRICE", v: fmtPrice(c.price) });
  if (c.mcap) tiles.push({ l: "MARKET CAP", v: fmtCap(c.mcap) });
  const tw = 232 * S;
  const th = 100 * S;
  const gap = 20 * S;
  tiles.slice(0, 3).forEach((t, i) => metricTile(ctx, x0 + i * (tw + gap), bottom - th, tw, th, t.l, t.v, spec.accent, S));

  // hero logo + champion medallion
  const hx = W - 300 * S;
  const d = 296 * S;
  logoBadge(ctx, c.img, hx, cy - 10 * S, d, 1, S);
  if (!c.img) monogram(ctx, c.symbol, hx, cy - 10 * S, d);
  rankMedal(ctx, hx - d * 0.36, cy + d * 0.36, 52 * S, 1, S);
}

/** Gold / silver / bronze pedestals. Visual order is 2 · 1 · 3.
 *
 *  Pedestal heights differ by RANK (that is the whole point of a podium), but
 *  the text block inside them is a fixed stack anchored to the top and the
 *  chip/market-cap pair is anchored to the bottom — so a shorter pedestal must
 *  still be tall enough to hold both. That minimum is computed rather than
 *  guessed: with hard-coded heights the bronze pedestal was 208px and its
 *  project name landed underneath its own % chip. */
function layoutPodium(ctx, S, spec, coins, top, bottom) {
  const W = REF_W * S;
  const order = coins.length >= 3 ? [1, 0, 2] : coins.length === 2 ? [1, 0] : [0];
  const slots = order.filter((i) => coins[i]);
  const cols = slots.length;
  const colW = Math.min(400 * S, (W - 200 * S) / cols);
  const startX = (W - colW * cols) / 2;
  const baseY = bottom - 6 * S;
  // Extra pedestal height above the minimum, per rank — pure presence.
  const RISER = { 1: 92, 2: 42, 3: 8 };

  slots.forEach((idx, col) => {
    const c = coins[idx];
    const rank = idx + 1;
    const m = medalOf(rank);
    const cx = startX + colW * col + colW / 2;
    const w = colW - 40 * S;
    const d = (rank === 1 ? 152 : 126) * S; // logo diameter (overhangs the top edge)
    const chipSize = (rank === 1 ? 34 : 30) * S;

    // Vertical budget, top → bottom: the logo's lower half sits inside the card,
    // then ticker + name, then (from the bottom) the chip and the MC line.
    const foot = metaLine(c, { showMcap: Boolean(c.mcap) }).replace(/·\s+\$/, "· MC $");
    const blockTop = d * 0.26;
    const tickerDY = blockTop + 44 * S;
    const nameDY = blockTop + 76 * S;
    const chipUp = (foot ? 78 : 54) * S; // chip centre, measured off the bottom
    const minH = nameDY + 14 * S + chipUp + chipSize * 0.93;
    const h = Math.max(minH, minH + RISER[rank] * S);
    const y = baseY - h;

    glass(ctx, cx - w / 2, y, w, h, 26 * S, { S, glow: m.mid, fill: 0.085 });

    const lcy = y - d * 0.28;
    logoBadge(ctx, c.img, cx, lcy, d, rank, S);
    if (!c.img) monogram(ctx, c.symbol, cx, lcy, d);
    rankMedal(ctx, cx + d * 0.38, lcy + d * 0.34, (rank === 1 ? 34 : 30) * S, rank, S);

    ctx.save();
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = INK;
    ctx.fillText(
      fitText(ctx, `$${c.symbol}`, w - 44 * S, { weight: 800, size: (rank === 1 ? 46 : 40) * S, min: 22 * S, family: F.x }),
      cx,
      y + tickerDY,
    );
    ctx.fillStyle = MUTE;
    ctx.fillText(fitText(ctx, c.name || "", w - 52 * S, { weight: 500, size: 21 * S, min: 14 * S, family: F.m }), cx, y + nameDY);
    ctx.restore();

    pctChip(ctx, cx, y + h - chipUp, c.pctLabel, chipSize, S);
    // Chain + market cap on ONE bottom line. Deliberately not a separate block
    // in the gap the riser opens up: that gap exists on the gold pedestal and not
    // on the bronze one, so anything drawn there appears on some cards and not
    // others — which reads as a bug rather than as a hierarchy.
    if (foot) {
      ctx.save();
      ctx.textAlign = "center";
      ctx.fillStyle = SOFT;
      ctx.font = `600 ${19 * S}px ${F.s}`;
      ctx.fillText(fitText(ctx, foot, w - 40 * S, { weight: 600, size: 19 * S, min: 13 * S, family: F.s }), cx, y + h - 26 * S);
      ctx.restore();
    }
  });
}

/** 2×2 feature cards: big logo left, ticker/name/% stacked right. */
function layoutCards(ctx, S, spec, coins, top, bottom) {
  const W = REF_W * S;
  const n = coins.length;
  const cols = n <= 2 ? n : 2;
  const rows = Math.ceil(n / cols);
  const gapX = 40 * S;
  const gapY = 28 * S;
  const cardW = Math.min(660 * S, (W - 240 * S - gapX * (cols - 1)) / cols);
  const cardH = Math.min(252 * S, (bottom - top - gapY * (rows - 1)) / rows);
  const totalW = cardW * cols + gapX * (cols - 1);
  const totalH = cardH * rows + gapY * (rows - 1);
  const x0 = (W - totalW) / 2;
  const y0 = top + (bottom - top - totalH) / 2;

  coins.forEach((c, i) => {
    const rank = i + 1;
    const m = medalOf(rank);
    const x = x0 + (i % cols) * (cardW + gapX);
    const y = y0 + Math.floor(i / cols) * (cardH + gapY);
    glass(ctx, x, y, cardW, cardH, 30 * S, { S, glow: rank <= 3 ? m.mid : spec.accent, fill: 0.08 });

    const d = Math.min(140 * S, cardH * 0.58);
    const lcx = x + 34 * S + d / 2;
    const lcy = y + cardH / 2;
    logoBadge(ctx, c.img, lcx, lcy, d, rank, S);
    if (!c.img) monogram(ctx, c.symbol, lcx, lcy, d);
    rankMedal(ctx, lcx - d * 0.38, lcy - d * 0.38, 28 * S, rank, S);

    const tx = lcx + d / 2 + 30 * S;
    const tw = x + cardW - 30 * S - tx;
    ctx.save();
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = INK;
    ctx.fillText(fitText(ctx, `$${c.symbol}`, tw, { weight: 800, size: 44 * S, min: 22 * S, family: F.x }), tx, lcy - 26 * S);
    ctx.fillStyle = MUTE;
    ctx.fillText(fitText(ctx, c.name || metaLine(c), tw, { weight: 500, size: 21 * S, min: 14 * S, family: F.m }), tx, lcy + 4 * S);
    ctx.restore();
    pctChip(ctx, tx, lcy + 46 * S, c.pctLabel, 30 * S, S, { align: "l" });
    if (c.mcap) {
      ctx.save();
      ctx.fillStyle = SOFT;
      ctx.font = `600 ${19 * S}px ${F.s}`;
      ctx.textBaseline = "middle";
      ctx.textAlign = "right";
      ctx.fillText(fmtCap(c.mcap), x + cardW - 30 * S, lcy + 46 * S);
      ctx.restore();
    }
  });
}

/** Ranked full-width rows — the most readable layout, and the daily default. */
function layoutList(ctx, S, spec, coins, top, bottom) {
  const W = REF_W * S;
  const n = coins.length;
  const gap = 16 * S;
  const rowH = Math.min(96 * S, (bottom - top - gap * (n - 1)) / n);
  const totalH = rowH * n + gap * (n - 1);
  const x = 120 * S;
  const w = W - 240 * S;
  let y = top + (bottom - top - totalH) / 2;

  coins.forEach((c, i) => {
    const rank = i + 1;
    const m = medalOf(rank);
    glass(ctx, x, y, w, rowH, rowH * 0.32, { S, glow: rank <= 3 ? m.mid : null, fill: 0.075 });
    const cy = y + rowH / 2;

    rankMedal(ctx, x + 46 * S, cy, rowH * 0.3, rank, S);
    const d = rowH * 0.68;
    const lcx = x + 118 * S + d / 2;
    logoBadge(ctx, c.img, lcx, cy, d, rank, S, { glow: false });
    if (!c.img) monogram(ctx, c.symbol, lcx, cy, d);

    const tx = lcx + d / 2 + 26 * S;
    const chipW = 150 * S;
    const tw = x + w - 34 * S - chipW - 40 * S - tx;
    ctx.save();
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = INK;
    ctx.fillText(fitText(ctx, `$${c.symbol}`, tw, { weight: 800, size: 38 * S, min: 20 * S, family: F.x }), tx, cy - 2 * S);
    ctx.fillStyle = MUTE;
    ctx.fillText(fitText(ctx, c.name || "", tw, { weight: 500, size: 19 * S, min: 13 * S, family: F.m }), tx, cy + 26 * S);
    // chain · mcap, right-aligned just left of the chip
    ctx.fillStyle = SOFT;
    ctx.font = `600 ${19 * S}px ${F.s}`;
    ctx.textAlign = "right";
    ctx.fillText(metaLine(c), x + w - 34 * S - chipW - 24 * S, cy + 7 * S);
    ctx.restore();
    pctChip(ctx, x + w - 34 * S, cy, c.pctLabel, 30 * S, S, { align: "r" });
    y += rowH + gap;
  });
}

/** Two columns of compact pills — `perCol` rows each. Shared by rail8/grid10. */
function layoutColumns(ctx, S, spec, coins, top, bottom, { rowsPerCol, big }) {
  const W = REF_W * S;
  const n = coins.length;
  const cols = n > rowsPerCol ? 2 : 1;
  const rows = Math.ceil(n / cols);
  const gapX = 40 * S;
  const gapY = big ? 20 * S : 16 * S;
  const cardW = Math.min((big ? 672 : 648) * S, (W - 220 * S - gapX * (cols - 1)) / cols);
  const cardH = Math.min((big ? 106 : 90) * S, (bottom - top - gapY * (rows - 1)) / rows);
  const totalW = cardW * cols + gapX * (cols - 1);
  const totalH = cardH * rows + gapY * (rows - 1);
  const x0 = (W - totalW) / 2;
  const y0 = top + (bottom - top - totalH) / 2;

  coins.forEach((c, i) => {
    const rank = i + 1;
    const m = medalOf(rank);
    // Fill DOWN the left column first, then the right — a leaderboard is read
    // in rank order, and 1,3,5,7 down one side is not that.
    const col = Math.floor(i / rows);
    const row = i % rows;
    const x = x0 + col * (cardW + gapX);
    const y = y0 + row * (cardH + gapY);
    glass(ctx, x, y, cardW, cardH, cardH * 0.32, { S, glow: rank <= 3 ? m.mid : null, fill: 0.07 });
    const cy = y + cardH / 2;

    // rank: a medallion for the podium, a plain numeral below it
    if (rank <= 3) {
      rankMedal(ctx, x + 40 * S, cy, cardH * 0.29, rank, S);
    } else {
      ctx.save();
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = hexA(spec.accent, 0.9);
      ctx.font = `800 ${cardH * 0.32}px ${F.x}`;
      ctx.fillText(String(rank), x + 40 * S, cy);
      ctx.restore();
    }

    const d = cardH * 0.64;
    const lcx = x + 82 * S + d / 2;
    logoBadge(ctx, c.img, lcx, cy, d, rank, S, { glow: false });
    if (!c.img) monogram(ctx, c.symbol, lcx, cy, d);

    const chipSize = big ? 26 * S : 23 * S;
    const chipW = (big ? 132 : 120) * S;
    const tx = lcx + d / 2 + 20 * S;
    const tw = x + cardW - 24 * S - chipW - 20 * S - tx;
    ctx.save();
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = INK;
    ctx.fillText(fitText(ctx, `$${c.symbol}`, tw, { weight: 800, size: (big ? 32 : 28) * S, min: 17 * S, family: F.x }), tx, big ? cy - 1 * S : cy + 3 * S);
    if (big) {
      ctx.fillStyle = MUTE;
      ctx.fillText(fitText(ctx, c.name || metaLine(c), tw, { weight: 500, size: 18 * S, min: 12 * S, family: F.m }), tx, cy + 26 * S);
    }
    ctx.restore();
    pctChip(ctx, x + cardW - 24 * S, cy, c.pctLabel, chipSize, S, { align: "r" });
  });
}

const LAYOUTS = {
  hero: layoutHero,
  podium: layoutPodium,
  cards: layoutCards,
  list: layoutList,
  rail: (ctx, S, spec, coins, top, bottom) => layoutColumns(ctx, S, spec, coins, top, bottom, { rowsPerCol: 4, big: true }),
  grid: (ctx, S, spec, coins, top, bottom) => layoutColumns(ctx, S, spec, coins, top, bottom, { rowsPerCol: 5, big: false }),
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
        c.img = null; // undecodable → monogram
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

    backdrop(ctx, S, spec, bg);
    const top = header(ctx, S, spec, { n: list.length, dateText, showDate: Boolean(dateText) });
    const bottom = H - 118 * S;
    (LAYOUTS[spec.layout] || layoutList)(ctx, S, spec, list, top, bottom);
    footer(ctx, S, spec);

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
  _internals: { LAYOUTS },
};
