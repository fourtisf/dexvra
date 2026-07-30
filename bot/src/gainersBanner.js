// Top-Gainers banners — six layouts drawn in the dexvra.io design language.
//
// The operator picks a layout in @dexvraadminbot, the live top movers
// (gainers.js) are burned into it, and the finished PNG goes to a channel.
// Everything is procedural (@napi-rs/canvas), so a layout works the moment the
// code ships and adapts to however many real gainers exist right now.
//
// DESIGN: this is deliberately NOT a "crypto poster" — no neon glow titles, no
// metallic medallions, no sparkles. It is the dexvra.io board itself, framed:
// the site's own surfaces (#090C12 page, #101624 cards, hairline borders), its
// two typefaces (Space Grotesk for display, JetBrains Mono for every stat and
// micro-label), its mint→cyan gradient with the violet bloom its body background
// carries, and its change pill drawn to the same spec as `.chg.up` in
// globals.css. A reader who knows the site should recognise this before they
// read a word of it. Tokens live in helpers/canvasKit (SITE).
//
// THE CONTRACT (same shape as the per-token cards in bannerRender.js):
//   • render() NEVER throws and never rejects — any failure resolves null, and
//     null means the caller posts nothing rather than posting something wrong.
//   • The layout is driven by coins.length, never by the template's nominal
//     size. Three live gainers on the "Top 5" layout draws three rows, centred,
//     titled "Top 3 Gainers" — never two empty slots.
//   • No number is invented here. A coin with no market cap simply doesn't get
//     that cell; the % comes from gainers.js, which drops unpriced tokens.
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
// One margin everywhere. The site's content is a 20px gutter on a ~1400px board;
// at banner scale that is 72, and holding it makes the artwork feel laid out
// rather than assembled.
const PAD = 72;
// The band left between the header block and the footer rule. Every layout
// centres its content in this, so the six banners share a horizon line.
const BAND_TOP = 276;
const BAND_BOTTOM = 794;
const BAND_H = BAND_BOTTOM - BAND_TOP;

// ── Templates ───────────────────────────────────────────────────────────────
// `n` is the MAXIMUM number of slots (what the admin picks and what gainers.js
// is asked to fetch); the layout draws min(n, coins.length).
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
    blurb: "Four product cards, 2×2 — logo, ticker, name and the move.",
    n: 4,
    layout: "cards",
    accent: SITE.cyan,
    title: (n) => `Top ${n} Gainers`,
  },
  list5: {
    id: "list5",
    label: "📋 Top 5 List",
    blurb: "The Dexvra board itself — ranked rows with real columns.",
    n: 5,
    layout: "list",
    accent: SITE.mint,
    title: (n) => `Top ${n} Gainers`,
  },
  rail8: {
    id: "rail8",
    label: "🎞 Top 8 Rail",
    blurb: "Two columns of four — the Top-8 shape, Dexvra styling.",
    n: 8,
    layout: "rail",
    accent: SITE.cyan,
    title: (n) => `Top ${n} Gainers`,
  },
  grid10: {
    id: "grid10",
    label: "🔟 Top 10 Grid",
    blurb: "The full top ten, two compact columns of five.",
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

// ── primitives ──────────────────────────────────────────────────────────────
/** Cover-fit an image into a box (the CSS `object-fit: cover` maths). */
function drawCover(ctx, img, x, y, w, h) {
  const s = Math.max(w / img.width, h / img.height);
  const iw = img.width * s;
  const ih = img.height * s;
  ctx.drawImage(img, x + (w - iw) / 2, y + (h - ih) / 2, iw, ih);
}

/** Uppercase micro-label: JetBrains Mono, wide tracking — the site's `.nav-label`
 *  / `.row.head` / `.fld label` voice, and the single strongest brand signal in
 *  the whole system after the logo. */
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

/** A surface card: the site's `--card` fill with its hairline border, an optional
 *  accent tint, and a soft shadow. No translucent white washes — those are what
 *  made the first pass look like frosted glass instead of Dexvra. */
function card(ctx, x, y, w, h, r, { accent = null, S = 1, lift = 1 } = {}) {
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,.45)";
  ctx.shadowBlur = 30 * S * lift;
  ctx.shadowOffsetY = 12 * S * lift;
  roundRect(ctx, x, y, w, h, r);
  ctx.fillStyle = SITE.card;
  ctx.fill();
  ctx.restore();
  if (accent) {
    // The faintest possible wash of the accent across the card — the site tints
    // its active nav row exactly this way (rgba(61,245,159,.14) → .07).
    ctx.save();
    roundRect(ctx, x, y, w, h, r);
    ctx.clip();
    const g = ctx.createLinearGradient(x, y, x + w, y + h);
    g.addColorStop(0, hexA(accent, 0.09));
    g.addColorStop(0.6, hexA(accent, 0.02));
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g;
    ctx.fillRect(x, y, w, h);
    ctx.restore();
  }
  roundRect(ctx, x, y, w, h, r);
  ctx.lineWidth = Math.max(1, 1.2 * S);
  ctx.strokeStyle = accent ? hexA(accent, 0.28) : SITE.line;
  ctx.stroke();
  // top inner sheen — 1px, not a gradient panel
  ctx.save();
  roundRect(ctx, x, y, w, h, r);
  ctx.clip();
  ctx.fillStyle = "rgba(255,255,255,.055)";
  ctx.fillRect(x + r * 0.6, y, w - r * 1.2, Math.max(1, 1.2 * S));
  ctx.restore();
}

/** The board's 24h change pill — `.chg.up` / `.chg.dn` from globals.css: a
 *  120° bright gradient with DARK ink on gains, white on losses, and the site's
 *  soft 9px-on-23px corner ratio rather than a full capsule. */
function pctChip(ctx, x, y, text, size, S, { align = "c" } = {}) {
  if (!text) return 0;
  const up = !String(text).startsWith("-");
  ctx.save();
  ctx.font = `800 ${size}px ${F.m8}`;
  const tw = ctx.measureText(text).width;
  const padX = size * 0.78;
  const padY = size * 0.52;
  const w = tw + padX * 2;
  const h = size + padY * 2;
  const left = align === "l" ? x : align === "r" ? x - w : x - w / 2;
  const top = y - h / 2;
  const r = h * 0.38;
  roundRect(ctx, left, top, w, h, r);
  const g = ctx.createLinearGradient(left, top + h, left + w, top);
  g.addColorStop(0, up ? SITE.upTo : SITE.downTo);
  g.addColorStop(1, up ? SITE.upFrom : SITE.downFrom);
  ctx.shadowColor = hexA(up ? SITE.mint : SITE.red, 0.28);
  ctx.shadowBlur = 18 * S;
  ctx.shadowOffsetY = 4 * S;
  ctx.fillStyle = g;
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;
  ctx.fillStyle = up ? SITE.upInk : SITE.downInk;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, left + w / 2, top + h / 2 + size * 0.06);
  ctx.restore();
  return w;
}

/** A bordered mono chip — the site's `.ichip` / `.age-chip`. */
function chip(ctx, x, y, text, size, S, { color = SITE.muted, border = SITE.line2, bg = "rgba(255,255,255,.03)", align = "left", track = 0.12 } = {}) {
  ctx.save();
  ctx.font = `700 ${size}px ${F.m7}`;
  const t = String(text).toUpperCase();
  const spacing = size * track;
  const tw = [...t].reduce((a, c) => a + ctx.measureText(c).width, 0) + spacing * Math.max(0, t.length - 1);
  const padX = size * 0.85;
  const padY = size * 0.6;
  const w = tw + padX * 2;
  const h = size + padY * 2;
  const left = align === "right" ? x - w : align === "center" ? x - w / 2 : x;
  roundRect(ctx, left, y - h / 2, w, h, h * 0.36);
  ctx.fillStyle = bg;
  ctx.fill();
  ctx.lineWidth = Math.max(1, 1.1 * S);
  ctx.strokeStyle = border;
  ctx.stroke();
  ctx.restore();
  microLabel(ctx, left + padX, y + size * 0.36, t, { size, color, track, weight: 700 });
  return w;
}

/** Token avatar: circle-clipped logo with the site's 2px rim; a $SYMBOL monogram
 *  on the brand gradient when no logo decoded, so a slot is never an empty disc. */
function avatar(ctx, img, cx, cy, d, symbol, rank, S) {
  const r = d / 2;
  const ring = rank <= 3 ? rankColor(rank) : "rgba(255,255,255,.16)";
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.clip();
  ctx.fillStyle = "#0A0E16";
  ctx.fillRect(cx - r, cy - r, d, d);
  if (img) {
    drawCover(ctx, img, cx - r, cy - r, d, d);
  } else {
    const g = ctx.createLinearGradient(cx - r, cy - r, cx + r, cy + r);
    g.addColorStop(0, "#4BFCA6");
    g.addColorStop(1, "#22D3EE");
    ctx.fillStyle = g;
    ctx.fillRect(cx - r, cy - r, d, d);
    ctx.fillStyle = "#03150B";
    ctx.font = `700 ${Math.round(d * 0.36)}px ${F.d7}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(symbol || "?").slice(0, 3).toUpperCase(), cx, cy + d * 0.02);
  }
  ctx.restore();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.lineWidth = Math.max(1.5, (rank <= 3 ? 2.6 : 2) * S);
  ctx.strokeStyle = ring;
  ctx.stroke();
}

/** Rank as a NUMBER, in mono, coloured for the podium — the site's `.rank`. */
function rankNum(ctx, x, y, rank, size, { align = "right" } = {}) {
  ctx.save();
  ctx.font = `700 ${size}px ${F.m7}`;
  ctx.fillStyle = rankColor(rank);
  ctx.textAlign = align;
  ctx.textBaseline = "middle";
  ctx.fillText(String(rank), x, y);
  ctx.restore();
}

const chainName = (id) => String(chainOf(id) ? chainOf(id).label : id || "").toUpperCase();

// ── page chrome ─────────────────────────────────────────────────────────────
/** The site's own background: #090C12 under a mint bloom top-right and a violet
 *  bloom left — the two radial-gradients on `body` in globals.css. */
function backdrop(ctx, S, spec, bg) {
  const W = REF_W * S;
  const H = REF_H * S;
  if (bg) {
    drawCover(ctx, bg, 0, 0, W, H);
    const scrim = ctx.createLinearGradient(0, 0, 0, H);
    scrim.addColorStop(0, "rgba(9,12,18,.80)");
    scrim.addColorStop(0.5, "rgba(9,12,18,.66)");
    scrim.addColorStop(1, "rgba(9,12,18,.86)");
    ctx.fillStyle = scrim;
    ctx.fillRect(0, 0, W, H);
  } else {
    ctx.fillStyle = SITE.bg;
    ctx.fillRect(0, 0, W, H);
    radial(ctx, W * 0.78, -H * 0.16, W * 0.62, SITE.mint, 0.1);
    radial(ctx, -W * 0.08, H * 0.12, W * 0.52, SITE.violetDeep, 0.11);
    radial(ctx, W * 0.5, H * 1.06, W * 0.5, spec.accent, 0.05);
  }
  // Whisper grid — the faint structure the site's panels sit on. Lines, not dots:
  // dots at this scale read as noise/JPEG artefacts.
  ctx.save();
  ctx.strokeStyle = "rgba(255,255,255,.018)";
  ctx.lineWidth = 1;
  for (let x = PAD * S; x < W; x += 64 * S) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, H);
    ctx.stroke();
  }
  ctx.restore();
}

/** Brand lockup + live/date chips + the title. Returns nothing: every layout
 *  works inside the fixed band below it, so the six share one horizon. */
function header(ctx, S, spec, { n, dateText }) {
  const W = REF_W * S;
  const x = PAD * S;
  const right = W - PAD * S;

  // ── brand lockup (the sidebar's .brand, scaled) ──
  drawBrandMark(ctx, x, 54 * S, 58 * S);
  ctx.save();
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = SITE.text;
  ctx.font = `700 ${34 * S}px ${F.d7}`;
  ctx.fillText("Dexvra", x + 74 * S, 92 * S);
  ctx.restore();
  microLabel(ctx, x + 76 * S, 114 * S, "Discovery", { size: 11 * S, color: SITE.mint, track: 0.26 });

  // ── date chip, right ──
  if (dateText) chip(ctx, right, 86 * S, dateText, 13 * S, S, { align: "right", color: SITE.muted });

  // ── title + a live marker ──
  const title = String(spec.title(n) || "");
  let size = 56 * S;
  ctx.save();
  ctx.textBaseline = "alphabetic";
  ctx.font = `700 ${size}px ${F.d7}`;
  const maxTitle = W - 2 * PAD * S - 190 * S;
  while (size > 34 * S && ctx.measureText(title).width > maxTitle) {
    size -= 2 * S;
    ctx.font = `700 ${size}px ${F.d7}`;
  }
  const baseline = 198 * S;
  // A hairline mint underline anchored to the title's own width — the only
  // decorative flourish in the whole header.
  const tw = ctx.measureText(title).width;
  ctx.fillStyle = SITE.text;
  ctx.fillText(title, x, baseline);
  ctx.restore();
  const ug = ctx.createLinearGradient(x, 0, x + tw, 0);
  ug.addColorStop(0, hexA(spec.accent, 0.9));
  ug.addColorStop(1, hexA(spec.accent, 0));
  ctx.fillStyle = ug;
  roundRect(ctx, x, baseline + 16 * S, tw, Math.max(2, 3 * S), 2 * S);
  ctx.fill();

  // "LIVE" dot + label, right-aligned on the title's line (the site's .top-stat)
  const ly = baseline - 16 * S;
  const label = "Live · 24h";
  ctx.save();
  ctx.font = `700 ${13 * S}px ${F.m7}`;
  const labelW = [...label.toUpperCase()].reduce((a, c) => a + ctx.measureText(c).width, 0) + 13 * S * 0.16 * label.length;
  ctx.restore();
  const dotR = 5 * S;
  const startX = right - labelW - 18 * S;
  radial(ctx, startX + dotR, ly - 4 * S, 14 * S, SITE.mint, 0.6);
  ctx.beginPath();
  ctx.arc(startX + dotR, ly - 4 * S, dotR, 0, Math.PI * 2);
  ctx.fillStyle = SITE.mint;
  ctx.fill();
  microLabel(ctx, startX + dotR * 2 + 10 * S, ly, label, { size: 13 * S, color: SITE.mint, track: 0.16 });
}

/** A column-header strip, exactly like the board's `.row.head`. Only the table
 *  layouts use it — it is what makes the artwork read as data rather than promo. */
function columnHead(ctx, S, cols) {
  for (const c of cols) microLabel(ctx, c.x, BAND_TOP * S - 22 * S, c.label, { size: 11 * S, track: 0.14, align: c.align || "left" });
}

function footer(ctx, S) {
  const W = REF_W * S;
  const x = PAD * S;
  const y = 818 * S;
  ctx.fillStyle = SITE.line;
  ctx.fillRect(x, y, W - 2 * PAD * S, 1);
  microLabel(ctx, x, y + 34 * S, "dexvra.io", { size: 14 * S, color: SITE.text, track: 0.1, weight: 800 });
  ctx.save();
  ctx.font = `500 ${15 * S}px ${F.d5}`;
  ctx.fillStyle = SITE.faint;
  ctx.textBaseline = "alphabetic";
  ctx.fillText("Find the next Moonshot", x + 128 * S, y + 34 * S);
  ctx.restore();
  microLabel(ctx, W - PAD * S, y + 34 * S, "Ranked by 24h change", { size: 12 * S, color: SITE.faint, track: 0.16, align: "right" });
}

// ── layouts ─────────────────────────────────────────────────────────────────
/** The board: ranked rows with real columns (#, token, chain, market cap, 24h). */
function layoutList(ctx, S, spec, coins) {
  const x = PAD * S;
  const w = (REF_W - 2 * PAD) * S;
  const n = coins.length;
  const gap = 14 * S;
  const rowH = Math.min(96 * S, (BAND_H * S - gap * (n - 1)) / n);
  const total = rowH * n + gap * (n - 1);
  let y = BAND_TOP * S + (BAND_H * S - total) / 2;

  // Four data columns, right-aligned like the site's board. PRICE earns its place
  // here rather than padding: without it the row was a ticker and then 500px of
  // nothing before the numbers.
  const cChain = x + w - 690 * S;
  const cPrice = x + w - 480 * S;
  const cMcap = x + w - 250 * S;
  const cChg = x + w - 30 * S;
  columnHead(ctx, S, [
    { x: x + 44 * S, label: "#", align: "right" },
    { x: x + 96 * S, label: "Token" },
    { x: cChain, label: "Chain", align: "right" },
    { x: cPrice, label: "Price", align: "right" },
    { x: cMcap, label: "Market cap", align: "right" },
    { x: cChg, label: "24h", align: "right" },
  ]);

  for (let i = 0; i < n; i++) {
    const c = coins[i];
    const rank = i + 1;
    const cy = y + rowH / 2;
    card(ctx, x, y, w, rowH, 20 * S, { S, accent: rank === 1 ? spec.accent : null });
    rankNum(ctx, x + 44 * S, cy, rank, 22 * S);
    const d = rowH * 0.56;
    avatar(ctx, c.img, x + 96 * S + d / 2, cy, d, c.symbol, rank, S);

    const tx = x + 96 * S + d + 24 * S;
    const tw = cChain - 140 * S - tx;
    ctx.save();
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = SITE.text;
    ctx.fillText(fitText(ctx, `$${c.symbol}`, tw, { weight: 700, size: 28 * S, min: 16 * S, family: F.d7 }), tx, cy - 4 * S);
    ctx.fillStyle = SITE.muted;
    ctx.fillText(fitText(ctx, c.name || "", tw, { weight: 500, size: 16 * S, min: 11 * S, family: F.d5 }), tx, cy + 24 * S);
    ctx.restore();

    microLabel(ctx, cChain, cy + 6 * S, chainName(c.chain), { size: 14 * S, color: SITE.muted, track: 0.14, align: "right" });
    const mono = (val, cx, color) => {
      ctx.save();
      ctx.font = `700 ${20 * S}px ${F.m7}`;
      ctx.fillStyle = color;
      ctx.textAlign = "right";
      ctx.textBaseline = "middle";
      ctx.fillText(val, cx, cy + 1 * S);
      ctx.restore();
    };
    mono(c.price ? fmtPrice(c.price) : "—", cPrice, c.price ? SITE.muted : SITE.faint);
    mono(c.mcap ? fmtCap(c.mcap) : "—", cMcap, c.mcap ? SITE.text : SITE.faint);
    pctChip(ctx, cChg, cy, c.pctLabel, 22 * S, S, { align: "r" });
    y += rowH + gap;
  }
}

/** Two columns of compact rows. `rowsPerCol` decides rail8 (4) vs grid10 (5). */
function layoutColumns(ctx, S, spec, coins, { rowsPerCol, big }) {
  const n = coins.length;
  const cols = n > rowsPerCol ? 2 : 1;
  const rows = Math.ceil(n / cols);
  const gapX = 28 * S;
  const gapY = (big ? 18 : 14) * S;
  const colW = ((REF_W - 2 * PAD) * S - gapX * (cols - 1)) / cols;
  const rowH = Math.min((big ? 118 : 96) * S, (BAND_H * S - gapY * (rows - 1)) / rows);
  const totalH = rowH * rows + gapY * (rows - 1);
  const x0 = PAD * S;
  const y0 = BAND_TOP * S + (BAND_H * S - totalH) / 2;

  if (cols === 2) {
    columnHead(ctx, S, [
      { x: x0 + 40 * S, label: "#", align: "right" },
      { x: x0 + 88 * S, label: "Token" },
      { x: x0 + colW - 24 * S, label: "24h", align: "right" },
      { x: x0 + colW + gapX + 40 * S, label: "#", align: "right" },
      { x: x0 + colW + gapX + 88 * S, label: "Token" },
      { x: x0 + colW * 2 + gapX - 24 * S, label: "24h", align: "right" },
    ]);
  }

  for (let i = 0; i < n; i++) {
    const c = coins[i];
    const rank = i + 1;
    // Fill DOWN the left column first — a leaderboard is read in rank order, and
    // 1,3,5,7 down one side is not that.
    const col = Math.floor(i / rows);
    const row = i % rows;
    const x = x0 + col * (colW + gapX);
    const y = y0 + row * (rowH + gapY);
    const cy = y + rowH / 2;
    card(ctx, x, y, colW, rowH, 18 * S, { S, accent: rank === 1 ? spec.accent : null });

    rankNum(ctx, x + 40 * S, cy, rank, big ? 20 * S : 18 * S);
    const d = rowH * 0.54;
    avatar(ctx, c.img, x + 84 * S + d / 2, cy, d, c.symbol, rank, S);

    const tx = x + 84 * S + d + 20 * S;
    const chgW = (big ? 132 : 120) * S;
    const mcapW = big ? 118 * S : 0;
    const tw = colW - 26 * S - chgW - mcapW - 18 * S - (tx - x);
    ctx.save();
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = SITE.text;
    ctx.fillText(
      fitText(ctx, `$${c.symbol}`, tw, { weight: 700, size: (big ? 25 : 22) * S, min: 14 * S, family: F.d7 }),
      tx,
      big ? cy - 2 * S : cy + 6 * S,
    );
    if (big) {
      ctx.fillStyle = SITE.muted;
      ctx.fillText(fitText(ctx, c.name || chainName(c.chain), tw, { weight: 500, size: 15 * S, min: 11 * S, family: F.d5 }), tx, cy + 24 * S);
    } else {
      microLabel(ctx, tx, cy + 26 * S, chainName(c.chain), { size: 11 * S, track: 0.14 });
    }
    ctx.restore();
    if (big && c.mcap) {
      ctx.save();
      ctx.font = `700 ${17 * S}px ${F.m7}`;
      ctx.fillStyle = SITE.faint;
      ctx.textAlign = "right";
      ctx.textBaseline = "middle";
      ctx.fillText(fmtCap(c.mcap), x + colW - 26 * S - chgW - 16 * S, cy);
      ctx.restore();
    }
    pctChip(ctx, x + colW - 26 * S, cy, c.pctLabel, (big ? 20 : 18) * S, S, { align: "r" });
  }
}

/** 2×2 product cards: avatar + ticker on the left, the move on the right. */
function layoutCards(ctx, S, spec, coins) {
  const n = coins.length;
  const cols = n <= 2 ? n : 2;
  const rows = Math.ceil(n / cols);
  const gapX = 28 * S;
  const gapY = 24 * S;
  const cardW = ((REF_W - 2 * PAD) * S - gapX * (cols - 1)) / cols;
  const cardH = Math.min(250 * S, (BAND_H * S - gapY * (rows - 1)) / rows);
  const x0 = PAD * S;
  const y0 = BAND_TOP * S + (BAND_H * S - (cardH * rows + gapY * (rows - 1))) / 2;

  for (let i = 0; i < n; i++) {
    const c = coins[i];
    const rank = i + 1;
    const x = x0 + (i % cols) * (cardW + gapX);
    const y = y0 + Math.floor(i / cols) * (cardH + gapY);
    card(ctx, x, y, cardW, cardH, 24 * S, { S, accent: rank <= 3 ? rankColor(rank) : null });

    // Two columns inside the card: identity on the left, the move on the right.
    // Stacking everything on the left left a third of every card empty.
    const rightW = 210 * S;
    const tx = x + 34 * S;
    const textW = cardW - 68 * S - rightW;
    const d = Math.min(80 * S, cardH * 0.34);
    avatar(ctx, c.img, tx + d / 2, y + 34 * S + d / 2, d, c.symbol, rank, S);
    chip(ctx, tx + d + 18 * S, y + 34 * S + d / 2, `#${rank}`, 12 * S, S, {
      color: rankColor(rank),
      border: hexA(rankColor(rank), 0.35),
      bg: hexA(rankColor(rank), 0.1),
    });

    const ty = y + 34 * S + d + 48 * S;
    ctx.save();
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = SITE.text;
    ctx.fillText(fitText(ctx, `$${c.symbol}`, textW, { weight: 700, size: 34 * S, min: 18 * S, family: F.d7 }), tx, ty);
    ctx.fillStyle = SITE.muted;
    ctx.fillText(fitText(ctx, c.name || "", textW, { weight: 500, size: 16 * S, min: 12 * S, family: F.d5 }), tx, ty + 27 * S);
    ctx.restore();
    microLabel(ctx, tx, y + cardH - 30 * S, `${chainName(c.chain)}${c.price ? `   ·   ${fmtPrice(c.price)}` : ""}`, {
      size: 12 * S,
      track: 0.14,
    });

    // right column — the move, with its market cap beneath it
    const rcx = x + cardW - 34 * S;
    const rcy = y + cardH / 2;
    microLabel(ctx, rcx, rcy - 42 * S, "24h change", { size: 11 * S, track: 0.18, align: "right" });
    pctChip(ctx, rcx, rcy, c.pctLabel, 28 * S, S, { align: "r" });
    if (c.mcap) {
      ctx.save();
      ctx.font = `700 ${18 * S}px ${F.m7}`;
      ctx.fillStyle = SITE.muted;
      ctx.textAlign = "right";
      ctx.textBaseline = "alphabetic";
      ctx.fillText(`MC ${fmtCap(c.mcap)}`, rcx, rcy + 54 * S);
      ctx.restore();
    }
  }
}

/** Top 3: three tall cards, the winner raised and tinted. No pedestals, no
 *  medallions — the hierarchy is height, colour and type size.
 *
 *  Positions inside a card are FRACTIONS of its height, so the winner's extra
 *  34px lands as proportional breathing room everywhere instead of one gap in
 *  the middle. */
function layoutPodium(ctx, S, spec, coins) {
  const n = coins.length;
  const order = n >= 3 ? [1, 0, 2] : n === 2 ? [1, 0] : [0];
  const slots = order.filter((i) => coins[i]);
  const gapX = 28 * S;
  const colW = ((REF_W - 2 * PAD) * S - gapX * (slots.length - 1)) / slots.length;
  const baseH = BAND_H * S; // fill the band — a short card floating in it looked unfinished
  const bottom = BAND_BOTTOM * S;

  slots.forEach((idx, col) => {
    const c = coins[idx];
    const rank = idx + 1;
    const rc = rankColor(rank);
    const winner = rank === 1;
    const h = winner ? baseH : baseH - 38 * S;
    const x = PAD * S + col * (colW + gapX);
    const y = bottom - h;
    const cx = x + colW / 2;
    card(ctx, x, y, colW, h, 26 * S, { S, accent: rc, lift: winner ? 1.4 : 1 });

    chip(ctx, cx, y + 44 * S, winner ? "#1 · Top gainer" : `#${rank}`, 13 * S, S, {
      align: "center",
      color: rc,
      border: hexA(rc, 0.4),
      bg: hexA(rc, 0.12),
    });

    const d = (winner ? 148 : 130) * S;
    const lcy = y + h * 0.3;
    if (winner) radial(ctx, cx, lcy, d * 1.5, rc, 0.16);
    avatar(ctx, c.img, cx, lcy, d, c.symbol, rank, S);

    ctx.save();
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = SITE.text;
    ctx.fillText(
      fitText(ctx, `$${c.symbol}`, colW - 48 * S, { weight: 700, size: (winner ? 44 : 38) * S, min: 20 * S, family: F.d7 }),
      cx,
      lcy + d / 2 + 54 * S,
    );
    ctx.fillStyle = SITE.muted;
    ctx.fillText(
      fitText(ctx, c.name || "", colW - 56 * S, { weight: 500, size: 18 * S, min: 12 * S, family: F.d5 }),
      cx,
      lcy + d / 2 + 84 * S,
    );
    ctx.restore();

    // The move is this card's hero — big, and sitting on the lower third with
    // clearance above the footer rule (its glow used to graze the hairline).
    pctChip(ctx, cx, y + h * 0.735, c.pctLabel, (winner ? 34 : 29) * S, S);
    // hairline + the card's own footer stats
    ctx.fillStyle = SITE.line;
    ctx.fillRect(x + 34 * S, y + h - 76 * S, colW - 68 * S, 1);
    microLabel(ctx, cx, y + h - 44 * S, chainName(c.chain), { size: 12 * S, track: 0.16, align: "center" });
    if (c.mcap || c.price) {
      ctx.save();
      ctx.font = `700 ${17 * S}px ${F.m7}`;
      ctx.fillStyle = SITE.muted;
      ctx.textAlign = "center";
      ctx.textBaseline = "alphabetic";
      ctx.fillText(c.mcap ? `MC ${fmtCap(c.mcap)}` : fmtPrice(c.price), cx, y + h - 20 * S);
      ctx.restore();
    }
  });
}

/** #1 spotlight: the move as the headline, the token as the hero. */
function layoutHero(ctx, S, spec, coins) {
  const c = coins[0];
  if (!c) return;
  const x = PAD * S;
  const w = (REF_W - 2 * PAD) * S;
  const y = BAND_TOP * S;
  const h = BAND_H * S;
  card(ctx, x, y, w, h, 28 * S, { S, accent: SITE.mint, lift: 1.4 });

  const px = x + 56 * S;
  const cy = y + h / 2;
  const heroD = 286 * S;
  const heroX = x + w - 76 * S - heroD / 2;

  microLabel(ctx, px, y + 62 * S, "Biggest 24h mover", { size: 13 * S, color: SITE.mint, track: 0.24 });

  const textW = w - 160 * S - heroD;
  ctx.save();
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = SITE.text;
  ctx.fillText(fitText(ctx, `$${c.symbol}`, textW, { weight: 700, size: 76 * S, min: 34 * S, family: F.d7 }), px, y + 148 * S);
  ctx.fillStyle = SITE.muted;
  ctx.fillText(fitText(ctx, c.name || "", textW, { weight: 500, size: 24 * S, min: 14 * S, family: F.d5 }), px, y + 186 * S);

  // the move, as the headline number
  ctx.font = `800 ${104 * S}px ${F.m8}`;
  const g = ctx.createLinearGradient(px, y + 220 * S, px, y + 320 * S);
  const up = !String(c.pctLabel || "").startsWith("-");
  g.addColorStop(0, up ? SITE.upFrom : SITE.downFrom);
  g.addColorStop(1, up ? SITE.mintDeep : SITE.downTo);
  ctx.fillStyle = g;
  ctx.fillText(c.pctLabel || "", px, y + 300 * S);
  ctx.restore();

  // stat tiles
  const tiles = [
    { l: "Chain", v: chainName(c.chain) || "—" },
    ...(c.price ? [{ l: "Price", v: fmtPrice(c.price) }] : []),
    ...(c.mcap ? [{ l: "Market cap", v: fmtCap(c.mcap) }] : []),
  ].slice(0, 3);
  const tw = Math.min(200 * S, (textW - 2 * 16 * S) / Math.max(1, tiles.length));
  const th = 88 * S;
  tiles.forEach((t, i) => {
    const tx = px + i * (tw + 16 * S);
    const ty = y + h - 56 * S - th;
    roundRect(ctx, tx, ty, tw, th, 16 * S);
    ctx.fillStyle = "rgba(255,255,255,.035)";
    ctx.fill();
    ctx.lineWidth = Math.max(1, 1.1 * S);
    ctx.strokeStyle = SITE.line;
    ctx.stroke();
    microLabel(ctx, tx + 18 * S, ty + 32 * S, t.l, { size: 11 * S, track: 0.18 });
    ctx.save();
    ctx.font = `700 ${22 * S}px ${F.m7}`;
    ctx.fillStyle = SITE.text;
    ctx.textBaseline = "alphabetic";
    ctx.fillText(fitText(ctx, t.v, tw - 36 * S, { weight: 700, size: 22 * S, min: 13 * S, family: F.m7 }), tx + 18 * S, ty + 66 * S);
    ctx.restore();
  });

  // hero avatar with a soft brand bloom + a rank chip
  radial(ctx, heroX, cy, heroD * 1.15, SITE.mint, 0.16);
  avatar(ctx, c.img, heroX, cy, heroD, c.symbol, 1, S);
  chip(ctx, heroX, cy + heroD / 2 + 30 * S, "#1 Gainer", 14 * S, S, {
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
  _internals: { LAYOUTS },
};
