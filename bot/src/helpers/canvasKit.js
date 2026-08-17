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
  x: "sans-serif", // 800  display        (Sora — the per-token cards)
  b: "sans-serif", // 700  bold
  s: "sans-serif", // 600  semibold
  m: "sans-serif", // 500  medium
  r: "sans-serif", // 400  regular
  d7: "sans-serif", // Space Grotesk 700  — the SITE's display face
  d6: "sans-serif", // Space Grotesk 600
  d5: "sans-serif", // Space Grotesk 500
  m8: "sans-serif", // JetBrains Mono 800 — the SITE's stat/label face
  m7: "sans-serif", // JetBrains Mono 700
  m6: "sans-serif", // JetBrains Mono 600
};

/**
 * THE COVERAGE FONT — the one that draws what the brand faces cannot.
 *
 * A token listed as 牛来 ($牛来) went out to 12,607 subscribers as "$???" on the
 * listing card and again on the pump alert. Sora, Space Grotesk, JetBrains Mono
 * and Liberation Sans are all Latin faces: not one of them has a single Han
 * glyph, so every Chinese, Japanese, Korean, Thai or Arabic ticker this bot has
 * ever drawn came out as question marks — silently, because a missing glyph
 * renders rather than throwing.
 *
 * The fix is a FALLBACK CHAIN, not a second font for Chinese. Canvas resolves a
 * comma-separated family list PER GLYPH, so "牛来 Finance" keeps Sora for the
 * Latin word and reaches the coverage face only for the Han characters. Swapping
 * the whole face on a mixed name would put the brand type on one half of a title
 * and a system face on the other.
 *
 * DISCOVERED, never one hardcoded path — same rule as the launchpad hosts. The
 * repo's own assets win (an operator can drop any font in and it is used), then
 * the standard system locations. `fonts-noto-cjk` puts a .ttc there, which
 * @napi-rs/canvas registers happily.
 */
const CJK_CANDIDATES = [
  path.join(__dirname, "..", "..", "assets", "fonts", "NotoSansCJK-Bold.ttc"),
  path.join(__dirname, "..", "..", "assets", "fonts", "NotoSansCJK-Regular.ttc"),
  path.join(__dirname, "..", "..", "assets", "fonts", "NotoSansSC-Bold.otf"),
  path.join(__dirname, "..", "..", "assets", "fonts", "NotoSansSC-Regular.otf"),
  "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc",
  "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
  "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
  "/usr/share/fonts/opentype/noto/NotoSerifCJK-Bold.ttc",
  "/System/Library/Fonts/PingFang.ttc",
];
const EMOJI_CANDIDATES = [
  path.join(__dirname, "..", "..", "assets", "fonts", "NotoColorEmoji.ttf"),
  "/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf",
  "/usr/share/fonts/truetype/noto-color-emoji/NotoColorEmoji.ttf",
];
// Everything else a ticker might be written in. These ship in fonts-noto-core,
// which is NOT a prerequisite — the chain simply gains whichever of them exist.
// Listed here rather than added later so that installing the package is the
// whole fix, with no deploy: the same contract the launchpad hosts have.
const EXTRA_CANDIDATES = [
  ["DexCover Thai", ["/usr/share/fonts/truetype/noto/NotoSansThai-Regular.ttf", path.join(__dirname, "..", "..", "assets", "fonts", "NotoSansThai-Regular.ttf")]],
  ["DexCover Arabic", ["/usr/share/fonts/truetype/noto/NotoSansArabic-Regular.ttf", path.join(__dirname, "..", "..", "assets", "fonts", "NotoSansArabic-Regular.ttf")]],
  ["DexCover Deva", ["/usr/share/fonts/truetype/noto/NotoSansDevanagari-Regular.ttf"]],
  ["DexCover Hebrew", ["/usr/share/fonts/truetype/noto/NotoSansHebrew-Regular.ttf"]],
];
/** Which coverage faces registered, in chain order — for the boot line, for
 *  fonts:check, and so a reader can see the chain rather than infer it. */
const COVER = { cjk: null, emoji: null, faces: [] };

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
    // The SITE's typefaces — dexvra.io sets Space Grotesk as its display face and
    // JetBrains Mono for every stat, ticker and micro-label (globals.css). Artwork
    // that ships a different typeface reads as a third-party graphic no matter how
    // well drawn it is, so anything meant to look like Dexvra uses these.
    reg("SpaceGrotesk-700.ttf", "Space Grotesk 700", "d7");
    reg("SpaceGrotesk-600.ttf", "Space Grotesk 600", "d6");
    reg("SpaceGrotesk-500.ttf", "Space Grotesk 500", "d5");
    reg("JetBrainsMono-800.ttf", "JetBrains Mono 800", "m8");
    reg("JetBrainsMono-700.ttf", "JetBrains Mono 700", "m7");
    reg("JetBrainsMono-600.ttf", "JetBrains Mono 600", "m6");
    // FALLBACKS — and only fallbacks.
    //
    // These called the same reg() as the brand faces, and reg() assigns
    // unconditionally. Both ran AFTER their Sora counterparts, so Liberation Sans
    // silently won the two keys it touched: `x` is the 800 display weight — the
    // big token title on every card — and it has been Liberation, not Sora, for
    // as long as the brand fonts have been in the repo. Nothing failed; the
    // artwork was just quietly off-brand on its most prominent line.
    //
    // The guards immediately below (`if (F.b === "sans-serif")`) are the intent
    // these two calls did not carry.
    const regFb = (file, fam, key) => { if (F[key] === "sans-serif") reg(file, fam, key); };
    regFb("LiberationSans-Bold.ttf", "DexBold", "x");
    if (F.b === "sans-serif") F.b = F.x;
    if (F.s === "sans-serif") F.s = F.x;
    regFb("LiberationSans-Regular.ttf", "DexReg", "m");
    if (F.r === "sans-serif") F.r = F.m;
    for (const [k, fb] of [["d7", "x"], ["d6", "b"], ["d5", "m"], ["m8", "x"], ["m7", "b"], ["m6", "s"]]) {
      if (F[k] === "sans-serif") F[k] = F[fb];
    }
    // The coverage faces, appended to EVERY family so no call site has to know
    // this exists — a renderer that had to opt in is a renderer that will forget
    // to on the one card that needed it. First path that registers wins.
    const first = (list, fam) => {
      for (const p of list) {
        try { if (fss.existsSync(p) && CV.GlobalFonts.registerFromPath(p, fam)) return p; } catch (_) { /* unreadable font is not a reason to fail boot */ }
      }
      return null;
    };
    COVER.cjk = first(CJK_CANDIDATES, "DexCover CJK");
    COVER.emoji = first(EMOJI_CANDIDATES, "DexCover Emoji");
    COVER.faces = [];
    if (COVER.cjk) COVER.faces.push({ family: "DexCover CJK", path: COVER.cjk });
    // Scripts before emoji: a colour-emoji face claims some text codepoints, and
    // a ticker's letters must not be resolved by it ahead of a real text font.
    for (const [family, paths] of EXTRA_CANDIDATES) {
      const p = first(paths, family);
      if (p) COVER.faces.push({ family, path: p });
    }
    if (COVER.emoji) COVER.faces.push({ family: "DexCover Emoji", path: COVER.emoji });
    const tail = COVER.faces.map((f) => `"${f.family}"`).join(", ");
    if (tail) for (const k of Object.keys(F)) F[k] = `${F[k]}, ${tail}`;
    // Said once, at load, because the alternative is finding out from a customer
    // screenshot — which is exactly how this was found.
    if (!COVER.cjk) log.warn("[banner] no CJK font found — Chinese/Japanese/Korean names will render as boxes. Install fonts-noto-cjk, or drop NotoSansCJK-Bold.ttc into bot/assets/fonts/. Run: npm run fonts:check");
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

// ── The SITE's design tokens (src/app/globals.css :root) ────────────────────
// Copied value-for-value on purpose. The per-token cards above grew their own
// near-miss palette (a warmer mint, a greener black) and the result was artwork
// that never quite matched dexvra.io. Anything new draws from SITE.
const SITE = {
  bg: "#090C12",
  panel: "#0D1119",
  card: "#101624",
  line: "rgba(255,255,255,.08)",
  line2: "rgba(255,255,255,.15)",
  text: "#F1F5FB",
  muted: "#9AA6BC",
  faint: "#66738C",
  mint: "#3DF59F",
  mintDeep: "#12D97C",
  cyan: "#22D3EE",
  violet: "#A97CFF",
  violetDeep: "#7C3AED",
  orange: "#FF9D4D",
  red: "#FF5C7A",
  gold: "#FFD166",
  // .chg.up / .chg.dn — the board's change pill, exactly as the site draws it
  upFrom: "#4DFFA6",
  upTo: "#25E890",
  upInk: "#063A1F",
  downFrom: "#FF7291",
  downTo: "#FF4D6D",
  downInk: "#FFFFFF",
};

// Rank colours built from SITE tokens rather than literal metals: gold, a cool
// silver drawn from the muted text ramp, and the brand orange for third. The
// heavy gold/silver/bronze medallions this replaced read as a game HUD.
const RANK_COLOR = { 1: SITE.gold, 2: "#C9D4E4", 3: SITE.orange };
const rankColor = (r) => RANK_COLOR[r] || SITE.faint;

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

/**
 * The Dexvra logo mark, traced from src/components/Logo.tsx (48px viewBox): a
 * dark rounded badge with a gradient hairline, the brilliant-cut gem in the
 * mint→cyan brand gradient, its facet cuts, and the top-left highlight facet.
 *
 * The bot used to draw a bare gem with no badge and a different gradient — close
 * enough to look like a knock-off of the real mark, which is worse than not
 * showing one. This is the mark.
 */
function drawBrandMark(ctx, x, y, size) {
  const u = size / 48;
  const P = (px, py) => [x + px * u, y + py * u];
  const grad = () => {
    const g = ctx.createLinearGradient(...P(9, 12), ...P(39, 37));
    g.addColorStop(0, "#4BFCA6");
    g.addColorStop(0.55, "#22D3EE");
    g.addColorStop(1, "#12B9E0");
    return g;
  };
  ctx.save();
  // badge
  roundRect(ctx, x + 2 * u, y + 2 * u, 44 * u, 44 * u, 13 * u);
  ctx.fillStyle = "#0A0E16";
  ctx.fill();
  ctx.lineWidth = Math.max(1, 1.5 * u);
  ctx.strokeStyle = grad();
  ctx.globalAlpha = 0.45;
  ctx.stroke();
  ctx.globalAlpha = 1;
  // gem body
  ctx.beginPath();
  ctx.moveTo(...P(15, 12));
  ctx.lineTo(...P(33, 12));
  ctx.lineTo(...P(39, 19));
  ctx.lineTo(...P(24, 37));
  ctx.lineTo(...P(9, 19));
  ctx.closePath();
  ctx.fillStyle = grad();
  ctx.fill();
  // facet cuts
  ctx.strokeStyle = "rgba(10,14,22,.5)";
  ctx.lineWidth = Math.max(0.8, 1.3 * u);
  const seg = (a, b, c, d) => {
    ctx.beginPath();
    ctx.moveTo(...P(a, b));
    ctx.lineTo(...P(c, d));
    ctx.stroke();
  };
  seg(9, 19, 39, 19);
  seg(15, 12, 20, 19);
  seg(33, 12, 28, 19);
  seg(20, 19, 28, 19);
  seg(20, 19, 24, 37);
  seg(28, 19, 24, 37);
  // top-left highlight facet
  ctx.beginPath();
  ctx.moveTo(...P(15.6, 12.5));
  ctx.lineTo(...P(22, 12.5));
  ctx.lineTo(...P(19, 18.5));
  ctx.lineTo(...P(10.5, 18.5));
  ctx.closePath();
  ctx.fillStyle = "rgba(255,255,255,.14)";
  ctx.fill();
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

/**
 * Which scripts this process can actually draw, measured rather than assumed.
 *
 * A glyph the font lacks does not throw — it draws a box, or a question mark,
 * and ships. So the only honest answer comes from rendering a sample and
 * comparing it against the same sample in a face that definitely cannot draw it:
 * equal widths mean both fell back to notdef. `npm run fonts:check` prints this,
 * and it is the one thing that would have caught "$???" before 12,607 people did.
 */
function coverage() {
  const CVl = canvasLib();
  if (!CVl) return { available: false, cjk: null, emoji: null, scripts: {} };
  const c = CVl.createCanvas(64, 64), ctx = c.getContext("2d");
  const w = (family, s) => { ctx.font = `40px ${family}`; return +ctx.measureText(s).width.toFixed(2); };
  // Liberation Sans alone is the control: a pure Latin face, so anything it
  // measures identically to the full chain is a glyph the chain also lacks.
  const bare = F.r.split(",")[0].trim();
  const scripts = {};
  for (const [name, sample] of [
    ["latin", "Ab"], ["greek", "Ωπ"], ["cyrillic", "Дж"],
    ["chinese", "牛来"], ["japanese", "あア"], ["korean", "한글"],
    ["thai", "ไทย"], ["arabic", "عربي"], ["emoji", "🚀"],
  ]) {
    scripts[name] = name === "latin" ? true : w(F.r, sample) !== w(bare, sample);
  }
  return { available: true, cjk: COVER.cjk, emoji: COVER.emoji, scripts };
}

module.exports = {
  canvasLib,
  available: () => !!canvasLib(),
  coverage,
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
  SITE,
  RANK_COLOR,
  rankColor,
  drawBrandMark,
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
