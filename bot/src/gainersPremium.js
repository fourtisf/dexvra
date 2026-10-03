"use strict";
// The PREMIUM Top-Gainers set — ten still banners, one per board size, Top 1
// through Top 10, each with its own silhouette AND its own backdrop.
//
// "hapus top gainer yang vidio ganti ke foto banner aja … buatkan template
// banner top 1 sampai 10 banner premium yang berbeda" (2026-10-03). The motion
// boards (MP4 played as a GIF) were removed on the operator's call and this set
// took their place on the panel's front screen — so it has to cover the same
// ladder the videos did (one layout per count) and look like none of the
// eleven classic stills next to it.
//
// WHY A FACTORY. These layouts draw with gainersBanner's primitives (surface,
// avatar, medal, bigPct, the header/footer and the mood backdrop), and a copy
// of those here would be a second idea of what a Dexvra banner looks like —
// the first thing to drift would be the % pill. gainersBanner calls this with
// its kit once, at the bottom of its own module, and merges the result into
// its TEMPLATES / LAYOUTS / MOODS / PATTERNS. So the premium set goes through
// the SAME render() — the same showPct switch, the same "a layout is driven by
// coins.length" contract, the same never-throws — and every guard test that
// walks gb.TEMPLATE_IDS walks these too.
//
// THE CONTRACT each layout keeps (gainersBanner's, restated where it bites):
//   • Driven by coins.length. A Top 7 handed four live gainers draws the Top 4
//     design, not four tiles and three holes — `ladder()` delegates DOWN the
//     premium set, so every count has a composition designed for it.
//   • No number is invented. A coin with no price or cap simply loses that
//     cell. The equalizer bar is the real % as a LENGTH, so it goes with the
//     figure when the admin hides percentages (spec.showPct === false).
//   • No "24h" heading of its own: the header strip already says it, and
//     gainersPct.test counts the mentions against hero1's.

module.exports = function premiumKit(k) {
  const {
    SITE, F, hexA, radial, roundRect, fitText, medalOf, metalGrad, sparkle,
    surface, avatar, metalRing, medal, bigPct, chip, microLabel,
    sparkline, fmtCap, fmtPrice, REF_W, REF_H, PAD, BAND_TOP, BAND_H,
    drawBrandMark, trackedCenter, grain, drawCover,
  } = k;

  const X0 = PAD;
  const X1 = REF_W - PAD;
  const IW = X1 - X0; // 1456
  const Y0 = BAND_TOP;
  const BH = BAND_H; // 518

  // ── the premium palette ──────────────────────────────────────────────────
  // Gold, silver and bronze for the podium, PLATINUM after it — never the
  // brand mint, which is reserved for the one thing that is green on purpose:
  // the gain. A board where every border is mint reads as the classic set
  // recoloured; black, gold and platinum is what reads as "premium".
  const PLAT = "#C9D2DF";
  const METAL = {
    1: medalOf(1),
    2: medalOf(2),
    3: medalOf(3),
    plat: { light: "#FFFFFF", mid: "#C9D2DF", dark: "#566074", glow: "#AEB8CC" },
  };
  const metalOf = (rank) => (rank >= 1 && rank <= 3 ? METAL[rank] : METAL.plat);
  const toneOf = (rank) => (rank === 1 ? SITE.gold : rank === 2 ? "#D6DEE2" : rank === 3 ? "#E38A3C" : PLAT);

  /** Gold FOIL — a vertical metallic ramp with a dark band through the middle,
   *  which is what makes flat type read as stamped metal rather than yellow. */
  function foil(ctx, y0, y1) {
    const g = ctx.createLinearGradient(0, y0, 0, y1);
    g.addColorStop(0, "#FFF8E0");
    g.addColorStop(0.3, "#F7D987");
    g.addColorStop(0.52, "#C38F2E");
    g.addColorStop(0.58, "#B27D24");
    g.addColorStop(0.8, "#F2D27F");
    g.addColorStop(1, "#FFF0C0");
    return g;
  }

  // ── premium furniture ────────────────────────────────────────────────────
  /** The premium card: smoked glass over the field, a soft light pooled under
   *  its top edge, a METAL border in the card's rank (gold / silver / bronze /
   *  platinum) and a second hairline inset inside it — the double frame every
   *  luxury plaque carries. */
  function luxe(ctx, x, y, w, h, r, S, { tone = SITE.gold, glow = 0, path = null, rank = 0 } = {}) {
    const shape = path || (() => roundRect(ctx, x, y, w, h, r));
    const metal = rank ? metalOf(rank) : tone === SITE.gold ? METAL[1] : METAL.plat;
    if (glow) {
      ctx.save();
      shape();
      ctx.shadowColor = hexA(tone, 0.5 * glow);
      ctx.shadowBlur = 60 * S;
      ctx.fillStyle = hexA(tone, 0.05);
      ctx.fill();
      ctx.restore();
    }
    ctx.save();
    shape();
    ctx.shadowColor = "rgba(0,0,0,.7)";
    ctx.shadowBlur = 44 * S;
    ctx.shadowOffsetY = 18 * S;
    const g = ctx.createLinearGradient(x, y, x, y + h);
    g.addColorStop(0, "rgba(24,27,37,.94)");
    g.addColorStop(1, "rgba(8,9,13,.96)");
    ctx.fillStyle = g;
    ctx.fill();
    ctx.restore();
    ctx.save();
    shape();
    ctx.clip();
    // light pooled under the top edge
    ctx.save();
    ctx.translate(x + w / 2, y);
    ctx.scale(1, Math.min(1, (h * 0.9) / Math.max(w, 1)));
    radial(ctx, 0, 0, w * 0.62, tone, 0.13);
    ctx.restore();
    const wash = ctx.createLinearGradient(x, y, x + w, y + h);
    wash.addColorStop(0, hexA(tone, 0.08));
    wash.addColorStop(0.5, "rgba(255,255,255,0)");
    wash.addColorStop(1, hexA(tone, 0.04));
    ctx.fillStyle = wash;
    ctx.fillRect(x, y, w, h);
    // diagonal glass sheen
    const sh = ctx.createLinearGradient(x, y, x + w * 0.6, y + h * 0.6);
    sh.addColorStop(0, "rgba(255,255,255,.06)");
    sh.addColorStop(0.35, "rgba(255,255,255,.015)");
    sh.addColorStop(0.36, "rgba(255,255,255,0)");
    ctx.fillStyle = sh;
    ctx.fillRect(x, y, w, h);
    ctx.restore();
    // the metal frame
    ctx.save();
    shape();
    ctx.lineWidth = Math.max(1.4, 2 * S);
    ctx.strokeStyle = metalGrad(ctx, x + w / 2, y + h / 2, Math.max(w, h) / 2, metal);
    ctx.globalAlpha = rank > 3 || (!rank && tone !== SITE.gold) ? 0.55 : 0.95;
    ctx.stroke();
    ctx.restore();
    // the inset hairline — only where the shape is a plain rounded box
    if (!path && w > 40 * S && h > 40 * S) {
      const i = 7 * S;
      ctx.save();
      roundRect(ctx, x + i, y + i, w - 2 * i, h - 2 * i, Math.max(2, r - i));
      ctx.lineWidth = Math.max(1, 1 * S);
      ctx.strokeStyle = hexA(tone, 0.12);
      ctx.stroke();
      ctx.restore();
    }
  }

  /** A token as a minted COIN: drop shadow, a metal bezel in its rank, the
   *  logo (or the site's jewel monogram) as the face, a glass gloss over the
   *  top and a lit arc on the bezel. Same face the classic avatar draws — only
   *  the setting changes. */
  function coin(ctx, img, cx, cy, d, symbol, S, rank, { glow = true } = {}) {
    const m = metalOf(rank);
    const bz = Math.max(3, d * 0.075);
    const R = d / 2 + bz;
    if (glow) radial(ctx, cx, cy, d * 1.0, m.glow, rank <= 3 ? 0.22 : 0.1);
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.fillStyle = "#06070A";
    ctx.shadowColor = "rgba(0,0,0,.65)";
    ctx.shadowBlur = Math.max(10, d * 0.22);
    ctx.shadowOffsetY = Math.max(3, d * 0.06);
    ctx.fill();
    ctx.restore();
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, d / 2 + bz / 2, 0, Math.PI * 2);
    ctx.lineWidth = bz;
    ctx.strokeStyle = metalGrad(ctx, cx, cy, R, m);
    ctx.stroke();
    // lit arc on the bezel, top-left
    ctx.beginPath();
    ctx.arc(cx, cy, d / 2 + bz / 2, Math.PI * 1.05, Math.PI * 1.45);
    ctx.lineWidth = bz * 0.34;
    ctx.lineCap = "round";
    ctx.strokeStyle = "rgba(255,255,255,.6)";
    ctx.stroke();
    ctx.restore();
    avatar(ctx, img, cx, cy, d, symbol, S);
    // glass gloss over the face
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, d / 2, 0, Math.PI * 2);
    ctx.clip();
    const gl = ctx.createLinearGradient(0, cy - d / 2, 0, cy + d * 0.05);
    gl.addColorStop(0, "rgba(255,255,255,.22)");
    gl.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = gl;
    ctx.beginPath();
    ctx.ellipse(cx, cy - d * 0.24, d * 0.44, d * 0.3, 0, 0, Math.PI * 2);
    ctx.fill();
    // inner shadow at the rim, so the face sits INSIDE the bezel
    const ig = ctx.createRadialGradient(cx, cy, d * 0.36, cx, cy, d / 2);
    ig.addColorStop(0, "rgba(0,0,0,0)");
    ig.addColorStop(1, "rgba(0,0,0,.35)");
    ctx.fillStyle = ig;
    ctx.fillRect(cx - d / 2, cy - d / 2, d, d);
    ctx.restore();
    void metalRing;
  }

  /** `$SYMBOL`, fitted, in Sora ExtraBold — heavier than the classic set's
   *  Space Grotesk, which is half of what makes these read as headlines.
   *  Returns the width actually drawn. */
  function sym(ctx, c, x, y, maxW, size, S, { align = "left", min = 12, color = SITE.text } = {}) {
    ctx.save();
    ctx.textBaseline = "alphabetic";
    ctx.textAlign = align;
    ctx.fillStyle = color;
    const t = fitText(ctx, `$${c.symbol}`, maxW, { weight: 800, size, min: min * S, family: F.x });
    if (size >= 30 * S) ctx.letterSpacing = `${(-0.02 * size).toFixed(1)}px`;
    ctx.shadowColor = "rgba(0,0,0,.55)";
    ctx.shadowBlur = 10 * S;
    ctx.shadowOffsetY = 2 * S;
    ctx.fillText(t, x, y);
    const w = ctx.measureText(t).width;
    ctx.letterSpacing = "0px";
    ctx.restore();
    return w;
  }

  /** The premium gain pill: smoked glass, an emerald hairline and an emerald
   *  figure — the classic board's solid mint pill shouts on a black-and-gold
   *  field. Draws NOTHING for an empty label (the showPct switch), exactly as
   *  pctChip does, and the figure is ONE fillText without its sign, so
   *  gainersPct.test sees it the same way. */
  function gainPill(ctx, x, y, text, size, S, { align = "c" } = {}) {
    if (!text) return 0;
    const up = !String(text).startsWith("-");
    const t = String(text).replace(/^[+-]/, "");
    const col = up ? "#4DFFA6" : SITE.red;
    ctx.save();
    ctx.font = `800 ${size}px ${F.m8}`;
    const tw = ctx.measureText(t).width;
    const tri = size * 0.5;
    const gap = size * 0.34;
    const padX = size * 0.72;
    const padY = size * 0.52;
    const w = padX * 2 + tri + gap + tw;
    const h = size + padY * 2;
    const left = align === "l" ? x : align === "r" ? x - w : x - w / 2;
    const top = y - h / 2;
    roundRect(ctx, left, top, w, h, h / 2);
    ctx.shadowColor = hexA(col, 0.28);
    ctx.shadowBlur = 18 * S;
    const bg = ctx.createLinearGradient(0, top, 0, top + h);
    bg.addColorStop(0, hexA(col, 0.2));
    bg.addColorStop(1, hexA(col, 0.07));
    ctx.fillStyle = "rgba(6,10,9,.85)";
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle = bg;
    ctx.fill();
    ctx.lineWidth = Math.max(1, 1.3 * S);
    ctx.strokeStyle = hexA(col, 0.65);
    ctx.stroke();
    const tx = left + padX;
    const ty = y + size * 0.04;
    ctx.fillStyle = col;
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
    ctx.shadowColor = hexA(col, 0.5);
    ctx.shadowBlur = 10 * S;
    ctx.fillText(t, tx + tri + gap, ty);
    ctx.restore();
    return w;
  }

  /** The project name under a ticker, muted. */
  function nameLine(ctx, c, x, y, maxW, size, S, { align = "left", min = 9.5 } = {}) {
    if (!c.name) return;
    ctx.save();
    ctx.textBaseline = "alphabetic";
    ctx.textAlign = align;
    ctx.fillStyle = SITE.muted;
    ctx.fillText(fitText(ctx, c.name, maxW, { weight: 500, size, min: min * S, family: F.d5 }), x, y);
    ctx.restore();
  }

  /** "$0.0042 · MC $1.20M" — only the parts that exist. */
  const facts = (c, { price = true, mcap = true } = {}) =>
    [price && c.price ? fmtPrice(c.price) : null, mcap && c.mcap ? `MC ${fmtCap(c.mcap)}` : null].filter(Boolean).join("  ·  ");

  /** A rank tag: a small metal-filled pill on the podium, a glass one after. */
  function rankTag(ctx, x, y, rank, S, { size = 12, align = "left" } = {}) {
    const label = `#${rank}`;
    ctx.save();
    ctx.font = `800 ${size * S}px ${F.m8}`;
    const tw = ctx.measureText(label).width;
    const w = tw + 20 * S;
    const h = size * S + 14 * S;
    const left = align === "center" ? x - w / 2 : align === "right" ? x - w : x;
    roundRect(ctx, left, y - h / 2, w, h, h / 2);
    if (rank <= 3) {
      ctx.fillStyle = metalGrad(ctx, left + w / 2, y, w / 2, medalOf(rank));
      ctx.fill();
      ctx.fillStyle = "#0A0E17";
    } else {
      ctx.fillStyle = "rgba(255,255,255,.06)";
      ctx.fill();
      ctx.lineWidth = Math.max(1, 1.1 * S);
      ctx.strokeStyle = SITE.line2;
      ctx.stroke();
      ctx.fillStyle = SITE.text;
    }
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(label, left + 10 * S, y + 0.5 * S);
    ctx.restore();
    return w;
  }

  /** A label / value pair in the stat strips. */
  function stat(ctx, x, y, label, value, S, { size = 22, align = "left", maxW = 260 } = {}) {
    microLabel(ctx, x, y, label, { size: 10.5 * S, track: 0.2, align, color: SITE.faint });
    ctx.save();
    ctx.textAlign = align;
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = SITE.text;
    ctx.fillText(fitText(ctx, value, maxW * S, { weight: 700, size: size * S, min: 12 * S, family: F.m7 }), x, y + (size + 12) * S);
    ctx.restore();
  }

  // ── Top 1 · Diamond Crest ──────────────────────────────────────────────
  // The champion set INSIDE a rotated diamond — two nested metal frames, a
  // gold seat behind the coin — with the copy as an editorial column on the
  // right: rank, ticker, the move at billboard size, a hairline stat strip.
  function crest(ctx, S, spec, coins) {
    const c = coins[0];
    const cx = (X0 + 330) * S;
    const cy = (Y0 + BH / 2) * S;
    const R = 236 * S;
    const diamond = (r) => {
      ctx.beginPath();
      ctx.moveTo(cx, cy - r);
      ctx.lineTo(cx + r, cy);
      ctx.lineTo(cx, cy + r);
      ctx.lineTo(cx - r, cy);
      ctx.closePath();
    };
    radial(ctx, cx, cy, R * 1.25, SITE.gold, 0.16);
    luxe(ctx, cx - R, cy - R, 2 * R, 2 * R, 0, S, { tone: SITE.gold, glow: 1, path: () => diamond(R) });
    ctx.save();
    diamond(R - 22 * S);
    ctx.lineWidth = Math.max(1, 1.2 * S);
    ctx.strokeStyle = hexA(SITE.gold, 0.3);
    ctx.stroke();
    ctx.restore();
    ctx.save();
    diamond(R);
    ctx.lineWidth = Math.max(2.5, 4 * S);
    ctx.strokeStyle = metalGrad(ctx, cx, cy, R, medalOf(1));
    ctx.stroke();
    ctx.restore();
    const d = 200 * S;
    radial(ctx, cx, cy, d * 0.95, SITE.gold, 0.2);
    coin(ctx, c.img, cx, cy, d, c.symbol, S, 1);
    sparkle(ctx, cx, cy - R, 13 * S, "#FFF1C2");
    sparkle(ctx, cx + R, cy, 8 * S, "#FFF1C2");
    sparkle(ctx, cx - R, cy, 8 * S, "#FFF1C2");
    medal(ctx, cx, cy + R - 4 * S, 26 * S, 1, S);

    // editorial column
    const tx = (X0 + 712) * S;
    const tw = (X1 - 712 - X0 - 20) * S;
    chip(ctx, tx, (Y0 + 34) * S, "#1 · Champion of the day", 13 * S, S, {
      color: SITE.gold, border: hexA(SITE.gold, 0.45), bg: hexA(SITE.gold, 0.12),
    });
    sym(ctx, c, tx, (Y0 + 128) * S, tw, 84 * S, S, { min: 30 });
    nameLine(ctx, c, tx + 4 * S, (Y0 + 168) * S, tw, 22 * S, S);
    bigPct(ctx, tx, (Y0 + 312) * S, c.pctLabel, 128 * S, S, { align: "left" });
    // gold rule
    const ry = (Y0 + 362) * S;
    const rg = ctx.createLinearGradient(tx, 0, tx + tw, 0);
    rg.addColorStop(0, hexA(SITE.gold, 0.8));
    rg.addColorStop(1, hexA(SITE.gold, 0));
    ctx.fillStyle = rg;
    ctx.fillRect(tx, ry, tw, Math.max(1, 1.5 * S));
    const stats = [
      c.price ? ["Price", fmtPrice(c.price)] : null,
      c.mcap ? ["Market cap", fmtCap(c.mcap)] : null,
      c.liq ? ["Liquidity", fmtCap(c.liq)] : null,
    ].filter(Boolean);
    const sw = tw / 3;
    stats.forEach(([l, v], i) => {
      const sx = tx + i * sw;
      if (i) {
        ctx.fillStyle = SITE.line2;
        ctx.fillRect(sx - 20 * S, ry + 30 * S, 1, 62 * S);
      }
      stat(ctx, sx, ry + 50 * S, l, v, S, { size: 26, maxW: sw / S - 40 });
    });
    ctx.save();
    ctx.beginPath();
    ctx.rect(tx, ry + 104 * S, tw, 60 * S);
    ctx.clip();
    sparkline(ctx, tx, ry + 112 * S, tw, 40 * S, c.symbol, c.pct, S, { alpha: 0.55 });
    ctx.restore();
  }

  // ── Top 2 · Golden Ticket ──────────────────────────────────────────────
  // One wide admission ticket, notched and perforated down the middle: the
  // winner's stub in gold on the left, the runner-up's in silver on the right.
  function ticket(ctx, S, spec, coins) {
    const x = X0 * S;
    const y = (Y0 + 20) * S;
    const w = IW * S;
    const h = (BH - 40) * S;
    const r = 28 * S;
    const mx = x + w / 2;
    const nr = 30 * S;
    const shape = () => {
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.lineTo(mx - nr, y);
      ctx.arc(mx, y, nr, Math.PI, 0, true);
      ctx.lineTo(x + w - r, y);
      ctx.arcTo(x + w, y, x + w, y + r, r);
      ctx.lineTo(x + w, y + h - r);
      ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
      ctx.lineTo(mx + nr, y + h);
      ctx.arc(mx, y + h, nr, 0, Math.PI, true);
      ctx.lineTo(x + r, y + h);
      ctx.arcTo(x, y + h, x, y + h - r, r);
      ctx.lineTo(x, y + r);
      ctx.arcTo(x, y, x + r, y, r);
      ctx.closePath();
    };
    luxe(ctx, x, y, w, h, r, S, { tone: SITE.gold, glow: 0.8, path: shape });
    // the silver half's own wash, so the two stubs read as two prizes
    ctx.save();
    shape();
    ctx.clip();
    const sg = ctx.createLinearGradient(x + w, y, mx, y + h);
    sg.addColorStop(0, "rgba(201,212,228,.12)");
    sg.addColorStop(1, "rgba(201,212,228,0)");
    ctx.fillStyle = sg;
    ctx.fillRect(mx, y, w / 2, h);
    ctx.restore();
    // perforation
    ctx.fillStyle = "rgba(255,255,255,.22)";
    for (let py = y + nr + 16 * S; py < y + h - nr - 10 * S; py += 18 * S) {
      ctx.beginPath();
      ctx.arc(mx, py, 2.6 * S, 0, Math.PI * 2);
      ctx.fill();
    }
    coins.slice(0, 2).forEach((c, i) => {
      const rank = i + 1;
      const hx = i === 0 ? x : mx;
      const hw = w / 2;
      const tone = toneOf(rank);
      microLabel(ctx, hx + 46 * S, y + 52 * S, rank === 1 ? "Admit one · winner" : "Admit one · runner-up", { size: 12 * S, track: 0.3, color: tone });
      microLabel(ctx, hx + hw - 46 * S, y + 52 * S, `No. 0${rank}`, { size: 12 * S, track: 0.3, color: SITE.faint, align: "right" });
      ctx.fillStyle = hexA(tone, 0.35);
      ctx.fillRect(hx + 46 * S, y + 70 * S, hw - 92 * S, Math.max(1, 1.2 * S));
      const d = (rank === 1 ? 208 : 188) * S;
      const acx = hx + 64 * S + d / 2;
      const acy = y + h / 2 + 34 * S;
      radial(ctx, acx, acy, d, tone, 0.14);
      coin(ctx, c.img, acx, acy, d, c.symbol, S, rank);
      medal(ctx, acx + d * 0.38, acy - d * 0.38, 22 * S, rank, S);
      const tx = acx + d / 2 + 34 * S;
      const tw = hx + hw - 50 * S - tx;
      sym(ctx, c, tx, acy - 64 * S, tw, 54 * S, S, { min: 20 });
      nameLine(ctx, c, tx, acy - 30 * S, tw, 19 * S, S);
      bigPct(ctx, tx, acy + 62 * S, c.pctLabel, 80 * S, S);
      microLabel(ctx, tx, acy + (c.pctLabel ? 108 : 20) * S, facts(c), { size: 13 * S, track: 0.14, color: SITE.muted });
    });
  }

  // ── Top 3 · Medal Arc ──────────────────────────────────────────────────
  // No cards at all: three medallions standing on one sweeping gold arc, each
  // on its own pool of light, the champion at the crest.
  function arc(ctx, S, spec, coins) {
    const cxm = (REF_W / 2) * S;
    const slots = [
      { i: 0, x: REF_W / 2, y: Y0 + 172, d: 196 },
      { i: 1, x: X0 + 250, y: Y0 + 228, d: 156 },
      { i: 2, x: X1 - 250, y: Y0 + 228, d: 156 },
    ];
    // the arc itself
    ctx.save();
    ctx.beginPath();
    ctx.ellipse(cxm, (Y0 + 640) * S, 760 * S, 430 * S, 0, Math.PI * 1.08, Math.PI * 1.92);
    const ag = ctx.createLinearGradient(X0 * S, 0, X1 * S, 0);
    ag.addColorStop(0, hexA(SITE.gold, 0));
    ag.addColorStop(0.5, hexA(SITE.gold, 0.55));
    ag.addColorStop(1, hexA(SITE.gold, 0));
    ctx.lineWidth = Math.max(1.5, 2.4 * S);
    ctx.strokeStyle = ag;
    ctx.shadowColor = hexA(SITE.gold, 0.5);
    ctx.shadowBlur = 16 * S;
    ctx.stroke();
    ctx.restore();
    for (const s of slots) {
      const c = coins[s.i];
      if (!c) continue;
      const rank = s.i + 1;
      const tone = toneOf(rank);
      const x = s.x * S;
      const y = s.y * S;
      const d = s.d * S;
      // light pool on the floor
      ctx.save();
      ctx.translate(x, y + d / 2 + 26 * S);
      ctx.scale(1, 0.22);
      radial(ctx, 0, 0, d * 1.05, tone, 0.32);
      ctx.restore();
      radial(ctx, x, y, d * 1.15, tone, rank === 1 ? 0.22 : 0.14);
      coin(ctx, c.img, x, y, d, c.symbol, S, rank, { glow: false });
      medal(ctx, x, y - d / 2 - 14 * S, (rank === 1 ? 24 : 20) * S, rank, S);
      if (rank === 1) sparkle(ctx, x + d * 0.55, y - d * 0.42, 12 * S, "#FFF1C2");
      const ty = y + d / 2 + 64 * S;
      sym(ctx, c, x, ty, 380 * S, (rank === 1 ? 44 : 36) * S, S, { align: "center", min: 18 });
      nameLine(ctx, c, x, ty + 28 * S, 360 * S, 16 * S, S, { align: "center" });
      gainPill(ctx, x, ty + 72 * S, c.pctLabel, (rank === 1 ? 24 : 20) * S, S);
      if (!c.pctLabel) microLabel(ctx, x, ty + 76 * S, facts(c, { price: false }), { size: 12 * S, color: SITE.muted, align: "center" });
    }
  }

  // ── Top 4 · Hex Vault ──────────────────────────────────────────────────
  // Four hexagonal vault doors in a row — the coin in the upper chamber, the
  // ticker in the lower — with the move pinned beneath each door.
  function hex(ctx, S, spec, coins) {
    const n = coins.length;
    const R = 158 * S; // centre → vertex
    const hw = R * Math.sqrt(3); // flat-to-flat width
    const gap = 40 * S;
    const rowW = n * hw + (n - 1) * gap;
    const cy = (Y0 + 196) * S;
    const path = (cx) => () => {
      ctx.beginPath();
      for (let i = 0; i < 6; i++) {
        const a = -Math.PI / 2 + (i * Math.PI) / 3;
        ctx[i ? "lineTo" : "moveTo"](cx + R * Math.cos(a), cy + R * Math.sin(a));
      }
      ctx.closePath();
    };
    coins.forEach((c, i) => {
      const rank = i + 1;
      const tone = toneOf(rank);
      const cx = (REF_W * S - rowW) / 2 + hw / 2 + i * (hw + gap);
      luxe(ctx, cx - hw / 2, cy - R, hw, 2 * R, 0, S, { tone, rank, glow: rank === 1 ? 1 : 0.3, path: path(cx) });
      ctx.save();
      path(cx)();
      ctx.lineWidth = Math.max(2, 3 * S);
      ctx.strokeStyle = metalGrad(ctx, cx, cy, R, metalOf(rank));
      ctx.stroke();
      ctx.restore();
      const d = 112 * S;
      const ay = cy - 34 * S;
      radial(ctx, cx, ay, d, tone, 0.16);
      coin(ctx, c.img, cx, ay, d, c.symbol, S, rank);
      sym(ctx, c, cx, cy + 66 * S, hw - 70 * S, 30 * S, S, { align: "center", min: 15 });
      nameLine(ctx, c, cx, cy + 92 * S, hw - 96 * S, 14 * S, S, { align: "center" });
      rankTag(ctx, cx, cy - R + 2 * S, rank, S, { size: 13, align: "center" });
      gainPill(ctx, cx, cy + R + 50 * S, c.pctLabel, 22 * S, S);
      microLabel(ctx, cx, cy + R + (c.pctLabel ? 104 : 56) * S, facts(c), { size: 11.5 * S, track: 0.12, color: SITE.muted, align: "center" });
    });
  }

  // ── Top 5 · Grand Staircase ────────────────────────────────────────────
  // Five bars that step down and inward with rank, so the ranking is a shape
  // before it is a list: the champion's bar is the longest and lit gold.
  function stairs(ctx, S, spec, coins) {
    const n = coins.length;
    const gap = 14 * S;
    const bh = Math.min(92 * S, (BH * S - gap * (n - 1)) / n);
    const y0 = Y0 * S + (BH * S - (bh * n + gap * (n - 1))) / 2;
    const step = 64 * S;
    coins.forEach((c, i) => {
      const rank = i + 1;
      const tone = toneOf(rank);
      const x = X0 * S + i * step;
      const w = X1 * S - x;
      const y = y0 + i * (bh + gap);
      const cy = y + bh / 2;
      luxe(ctx, x, y, w, bh, 18 * S, S, { tone, rank, glow: rank === 1 ? 1 : 0 });
      // the rank block
      const bw = bh;
      ctx.save();
      roundRect(ctx, x, y, w, bh, 18 * S);
      ctx.clip();
      const rg = ctx.createLinearGradient(x, y, x + bw, y + bh);
      rg.addColorStop(0, hexA(tone, 0.32));
      rg.addColorStop(1, hexA(tone, 0.08));
      ctx.fillStyle = rg;
      ctx.fillRect(x, y, bw, bh);
      ctx.fillStyle = hexA(tone, 0.6);
      ctx.fillRect(x + bw, y, Math.max(1, 1.2 * S), bh);
      ctx.restore();
      ctx.save();
      ctx.font = `800 ${bh * 0.46}px ${F.m8}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      const ng = ctx.createLinearGradient(0, y, 0, y + bh);
      ng.addColorStop(0, "#FFFFFF");
      ng.addColorStop(1, metalOf(rank).mid);
      ctx.fillStyle = ng;
      ctx.fillText(String(rank).padStart(2, "0"), x + bw / 2, cy + 2 * S);
      ctx.restore();
      const d = bh * 0.66;
      const ax = x + bw + 26 * S + d / 2;
      coin(ctx, c.img, ax, cy, d, c.symbol, S, rank);
      const tx = ax + d / 2 + 20 * S;
      const right = X1 * S - 26 * S;
      // the % sits right; facts take the middle when there is room for them
      const pw = c.pctLabel ? 190 * S : 0;
      const fx = right - pw - 24 * S;
      const nameW = Math.min(420 * S, fx - tx - 230 * S);
      sym(ctx, c, tx, cy - 4 * S, nameW, (rank === 1 ? 32 : 28) * S, S, { min: 15 });
      nameLine(ctx, c, tx, cy + 22 * S, nameW, 14 * S, S);
      const f = facts(c);
      if (f) microLabel(ctx, fx, cy + 5 * S, f, { size: 12.5 * S, track: 0.12, color: SITE.muted, align: "right" });
      gainPill(ctx, right, cy, c.pctLabel, (rank === 1 ? 24 : 21) * S, S, { align: "r" });
    });
  }

  // ── Top 6 · Glass Capsules ─────────────────────────────────────────────
  // Six pill-shaped capsules in two columns — coin flush to the round left
  // end, the rank as a ghost numeral behind the right end, the move on top.
  function capsules(ctx, S, spec, coins) {
    const n = coins.length;
    const cols = 2;
    const rows = Math.ceil(n / cols);
    const gx = 30 * S;
    const gy = 26 * S;
    const cw = (IW * S - gx) / cols;
    const ch = Math.min(150 * S, (BH * S - gy * (rows - 1)) / rows);
    const y0 = Y0 * S + (BH * S - (ch * rows + gy * (rows - 1))) / 2;
    coins.forEach((c, i) => {
      const rank = i + 1;
      const col = Math.floor(i / rows);
      const row = i % rows;
      const tone = toneOf(rank);
      const x = X0 * S + col * (cw + gx);
      const y = y0 + row * (ch + gy);
      const cy = y + ch / 2;
      luxe(ctx, x, y, cw, ch, ch / 2, S, { tone, rank, glow: rank === 1 ? 0.9 : 0 });
      ctx.save();
      roundRect(ctx, x, y, cw, ch, ch / 2);
      ctx.clip();
      ctx.font = `800 ${ch * 1.02}px ${F.m8}`;
      ctx.textAlign = "right";
      ctx.textBaseline = "middle";
      ctx.fillStyle = hexA(tone, 0.09);
      ctx.fillText(String(rank), x + cw - 30 * S, cy + ch * 0.06);
      ctx.restore();
      const d = ch - 30 * S;
      const ax = x + 15 * S + d / 2;
      radial(ctx, ax, cy, d * 0.85, tone, 0.14);
      coin(ctx, c.img, ax, cy, d, c.symbol, S, rank);
      const tx = ax + d / 2 + 26 * S;
      // the % stops short of the ghost numeral so the two never overprint
      const right = x + cw - ch * 0.72;
      rankTag(ctx, tx, cy - 38 * S, rank, S, { size: 11 });
      const tw = right - tx - (c.pctLabel ? 200 * S : 0);
      sym(ctx, c, tx, cy + 6 * S, tw, 30 * S, S, { min: 14 });
      const f = facts(c);
      if (f) microLabel(ctx, tx, cy + 36 * S, f, { size: 11 * S, track: 0.12, color: SITE.muted });
      bigPct(ctx, right, cy + 16 * S, c.pctLabel, 42 * S, S, { align: "right" });
    });
  }

  // ── Top 7 · Orbit Seven ────────────────────────────────────────────────
  // The champion as a planet at the centre, six satellites docked three a
  // side, each joined to it by a gold filament.
  function orbit(ctx, S, spec, coins) {
    const cx = (REF_W / 2) * S;
    const cy = (Y0 + BH / 2) * S;
    const R = 212 * S;
    const sats = coins.slice(1);
    const perSide = Math.ceil(sats.length / 2);
    const sw = 430 * S;
    const gap = 22 * S;
    const sh = Math.min(150 * S, (BH * S - gap * (perSide - 1)) / perSide);
    const sy0 = Y0 * S + (BH * S - (sh * perSide + gap * (perSide - 1))) / 2;
    const satBox = (k) => {
      const left = k < perSide;
      const j = left ? k : k - perSide;
      return { x: left ? X0 * S : X1 * S - sw, y: sy0 + j * (sh + gap), left };
    };
    // orbit ellipses + filaments first, so the cards sit on them
    ctx.save();
    for (const [rx, ry, a] of [[R * 1.32, R * 0.62, 0.22], [R * 1.62, R * 0.86, 0.12]]) {
      ctx.beginPath();
      ctx.ellipse(cx, cy, rx, ry, -0.12, 0, Math.PI * 2);
      ctx.lineWidth = Math.max(1, 1.4 * S);
      ctx.strokeStyle = hexA(SITE.gold, a);
      ctx.stroke();
    }
    sats.forEach((c, k) => {
      const b = satBox(k);
      const sx = b.left ? b.x + sw : b.x;
      const sy = b.y + sh / 2;
      const ex = b.left ? cx - R : cx + R;
      const g = ctx.createLinearGradient(sx, 0, ex, 0);
      g.addColorStop(0, hexA(SITE.gold, 0.5));
      g.addColorStop(1, hexA(SITE.gold, 0.05));
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.bezierCurveTo((sx + ex) / 2, sy, (sx + ex) / 2, cy, ex, cy);
      ctx.lineWidth = Math.max(1, 1.3 * S);
      ctx.strokeStyle = g;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(sx, sy, 3.5 * S, 0, Math.PI * 2);
      ctx.fillStyle = SITE.gold;
      ctx.fill();
    });
    ctx.restore();
    // the planet
    const c = coins[0];
    radial(ctx, cx, cy, R * 1.35, SITE.gold, 0.16);
    const disc = () => {
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, Math.PI * 2);
    };
    luxe(ctx, cx - R, cy - R, 2 * R, 2 * R, 0, S, { tone: SITE.gold, glow: 1, path: disc });
    ctx.save();
    disc();
    ctx.lineWidth = Math.max(3, 5 * S);
    ctx.strokeStyle = metalGrad(ctx, cx, cy, R, medalOf(1));
    ctx.stroke();
    ctx.restore();
    const d = 124 * S;
    const ay = cy - 82 * S;
    coin(ctx, c.img, cx, ay, d, c.symbol, S, 1);
    medal(ctx, cx + d * 0.42, ay - d * 0.36, 20 * S, 1, S);
    sym(ctx, c, cx, cy + 32 * S, R * 1.5, 40 * S, S, { align: "center", min: 18 });
    nameLine(ctx, c, cx, cy + 58 * S, R * 1.4, 15 * S, S, { align: "center" });
    if (c.pctLabel) bigPct(ctx, cx, cy + 128 * S, c.pctLabel, 52 * S, S, { align: "center" });
    else microLabel(ctx, cx, cy + 112 * S, facts(c), { size: 13 * S, color: SITE.muted, align: "center" });
    // satellites
    sats.forEach((s, k) => {
      const b = satBox(k);
      const rank = k + 2;
      const tone = toneOf(rank);
      luxe(ctx, b.x, b.y, sw, sh, 20 * S, S, { tone, rank });
      const scy = b.y + sh / 2;
      const dd = Math.min(70 * S, sh - 40 * S);
      const ax = b.x + 30 * S + dd / 2;
      coin(ctx, s.img, ax, scy, dd, s.symbol, S, rank);
      const tx = ax + dd / 2 + 18 * S;
      const tw = sw - (tx - b.x) - 26 * S;
      rankTag(ctx, tx, scy - 30 * S, rank, S, { size: 10.5 });
      sym(ctx, s, tx, scy + 8 * S, tw - (s.pctLabel ? 120 * S : 0), 24 * S, S, { min: 12 });
      nameLine(ctx, s, tx, scy + 32 * S, tw, 12.5 * S, S);
      gainPill(ctx, b.x + sw - 22 * S, scy - 28 * S, s.pctLabel, 16 * S, S, { align: "r" });
    });
  }

  // ── Top 8 · Equalizer ──────────────────────────────────────────────────
  // Eight columns, each a meter: the ticker on top, the gain as a lit bar
  // rising from the floor. The bar IS the percentage (as a length), so it is
  // drawn only while the figure is.
  function equalizer(ctx, S, spec, coins) {
    const n = coins.length;
    const showPct = spec.showPct !== false;
    const gap = 16 * S;
    const cw = (IW * S - gap * (n - 1)) / n;
    const y = Y0 * S;
    const h = BH * S;
    const best = Math.max(...coins.map((c) => Math.max(0, Number(c.pct) || 0)), 1);
    coins.forEach((c, i) => {
      const rank = i + 1;
      const tone = toneOf(rank);
      const x = X0 * S + i * (cw + gap);
      const mx = x + cw / 2;
      luxe(ctx, x, y, cw, h, 20 * S, S, { tone, rank, glow: rank === 1 ? 0.8 : 0 });
      rankTag(ctx, mx, y + 34 * S, rank, S, { size: 11.5, align: "center" });
      const d = Math.min(76 * S, cw - 50 * S);
      const ay = y + 70 * S + d / 2;
      coin(ctx, c.img, mx, ay, d, c.symbol, S, rank);
      sym(ctx, c, mx, ay + d / 2 + 34 * S, cw - 22 * S, 21 * S, S, { align: "center", min: 11 });
      nameLine(ctx, c, mx, ay + d / 2 + 54 * S, cw - 24 * S, 11.5 * S, S, { align: "center", min: 8.5 });
      // the meter
      const top = ay + d / 2 + 100 * S;
      const bottom = y + h - 48 * S;
      const mw = Math.min(56 * S, cw * 0.38);
      const metered = showPct && !!c.pctLabel;
      // tick marks — the meter's scale, only under a bar that uses it
      for (let t = 0; metered && t <= 8; t++) {
        const ty = bottom - ((bottom - top) * t) / 8;
        ctx.fillStyle = "rgba(255,255,255,.07)";
        ctx.fillRect(mx - mw / 2 - 10 * S, ty, mw + 20 * S, Math.max(1, S));
      }
      if (metered) {
        const frac = Math.max(0.06, Math.max(0, Number(c.pct) || 0) / best);
        const bt = bottom - (bottom - top - 34 * S) * frac;
        ctx.save();
        roundRect(ctx, mx - mw / 2, bt, mw, bottom - bt, 10 * S);
        const bg = ctx.createLinearGradient(0, bt, 0, bottom);
        bg.addColorStop(0, rank === 1 ? "#FFE7A3" : SITE.upFrom);
        bg.addColorStop(1, hexA(rank === 1 ? SITE.gold : SITE.mintDeep, 0.5));
        ctx.shadowColor = hexA(rank === 1 ? SITE.gold : SITE.mint, 0.45);
        ctx.shadowBlur = 20 * S;
        ctx.fillStyle = bg;
        ctx.fill();
        ctx.restore();
        ctx.save();
        ctx.font = `800 ${Math.min(19 * S, cw * 0.13)}px ${F.m8}`;
        ctx.textAlign = "center";
        ctx.textBaseline = "alphabetic";
        ctx.fillStyle = rank === 1 ? SITE.gold : SITE.mint;
        ctx.fillText(fitText(ctx, c.pctLabel.replace(/^\+/, ""), cw - 16 * S, { weight: 800, size: Math.min(19 * S, cw * 0.13), min: 10 * S, family: F.m8 }), mx, bt - 12 * S);
        ctx.restore();
      }
      else if (c.price) {
        // no figure → no bar; the meter shows the price instead of standing empty
        ctx.save();
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillStyle = SITE.text;
        ctx.fillText(fitText(ctx, fmtPrice(c.price), cw - 20 * S, { weight: 700, size: 17 * S, min: 9 * S, family: F.m7 }), mx, (top + bottom) / 2);
        ctx.restore();
      }
      if (c.mcap) microLabel(ctx, mx, y + h - 20 * S, `MC ${fmtCap(c.mcap)}`, { size: 10.5 * S, track: 0.1, color: SITE.muted, align: "center" });
    });
  }

  // ── Top 9 · Cover Story ────────────────────────────────────────────────
  // A magazine cover: the champion as the tall lead story on the left, the
  // other eight as a two-row index of tiles beside it.
  function cover(ctx, S, spec, coins) {
    const c = coins[0];
    const lw = 470 * S;
    const x = X0 * S;
    const y = Y0 * S;
    const h = BH * S;
    luxe(ctx, x, y, lw, h, 24 * S, S, { tone: SITE.gold, glow: 1 });
    const mx = x + lw / 2;
    microLabel(ctx, x + 32 * S, y + 46 * S, "Cover story", { size: 12 * S, track: 0.34, color: SITE.gold });
    microLabel(ctx, x + lw - 32 * S, y + 46 * S, "Issue 01", { size: 12 * S, track: 0.34, color: SITE.faint, align: "right" });
    ctx.fillStyle = hexA(SITE.gold, 0.4);
    ctx.fillRect(x + 32 * S, y + 62 * S, lw - 64 * S, Math.max(1, 1.2 * S));
    const d = 150 * S;
    const ay = y + 92 * S + d / 2;
    radial(ctx, mx, ay, d * 1.1, SITE.gold, 0.18);
    coin(ctx, c.img, mx, ay, d, c.symbol, S, 1);
    medal(ctx, mx + d * 0.4, ay + d * 0.36, 20 * S, 1, S);
    sym(ctx, c, mx, ay + d / 2 + 58 * S, lw - 60 * S, 46 * S, S, { align: "center", min: 20 });
    nameLine(ctx, c, mx, ay + d / 2 + 86 * S, lw - 70 * S, 16 * S, S, { align: "center" });
    bigPct(ctx, mx, y + h - 70 * S, c.pctLabel, 64 * S, S, { align: "center" });
    microLabel(ctx, mx, y + h - (c.pctLabel ? 30 : 60) * S, facts(c), { size: 12 * S, track: 0.12, color: SITE.muted, align: "center" });
    // the index
    const rest = coins.slice(1);
    const gx = 16 * S;
    const ix = x + lw + 24 * S;
    const iw = X1 * S - ix;
    const cols = Math.min(4, Math.max(1, Math.ceil(rest.length / 2)));
    const rows = Math.ceil(rest.length / cols);
    const tw = (iw - gx * (cols - 1)) / cols;
    const th = (h - gx * (rows - 1)) / rows;
    rest.forEach((s, k) => {
      const rank = k + 2;
      const tone = toneOf(rank);
      const tx = ix + (k % cols) * (tw + gx);
      const ty = y + Math.floor(k / cols) * (th + gx);
      const tcx = tx + tw / 2;
      luxe(ctx, tx, ty, tw, th, 18 * S, S, { tone, rank });
      rankTag(ctx, tx + 18 * S, ty + 30 * S, rank, S, { size: 11 });
      const dd = Math.min(72 * S, th * 0.3);
      const ay2 = ty + 50 * S + dd / 2;
      coin(ctx, s.img, tcx, ay2, dd, s.symbol, S, rank);
      sym(ctx, s, tcx, ay2 + dd / 2 + 32 * S, tw - 26 * S, 22 * S, S, { align: "center", min: 11 });
      nameLine(ctx, s, tcx, ay2 + dd / 2 + 52 * S, tw - 28 * S, 11.5 * S, S, { align: "center", min: 8.5 });
      gainPill(ctx, tcx, ty + th - 36 * S, s.pctLabel, 16 * S, S);
      if (!s.pctLabel && s.mcap) microLabel(ctx, tcx, ty + th - 30 * S, `MC ${fmtCap(s.mcap)}`, { size: 11 * S, color: SITE.muted, align: "center" });
    });
  }

  // ── Top 10 · Hall of Fame ──────────────────────────────────────────────
  // Two galleries: the three podium places as wide plaques on top, each with
  // a metal crown-bar, and the seven after them as a row of portrait frames.
  function hall(ctx, S, spec, coins) {
    const top = coins.slice(0, 3);
    const rest = coins.slice(3);
    const gap = 20 * S;
    const topH = 236 * S;
    const y = Y0 * S;
    const pw = (IW * S - gap * (top.length - 1)) / top.length;
    top.forEach((c, i) => {
      const rank = i + 1;
      const tone = toneOf(rank);
      const x = X0 * S + i * (pw + gap);
      luxe(ctx, x, y, pw, topH, 22 * S, S, { tone, rank, glow: rank === 1 ? 1 : 0.25 });
      // metal crown-bar along the top edge
      ctx.save();
      roundRect(ctx, x, y, pw, topH, 22 * S);
      ctx.clip();
      ctx.fillStyle = metalGrad(ctx, x + pw / 2, y, pw / 2, medalOf(rank));
      ctx.fillRect(x, y, pw, 6 * S);
      ctx.restore();
      const d = 118 * S;
      const acx = x + 34 * S + d / 2;
      const acy = y + topH / 2 + 6 * S;
      radial(ctx, acx, acy, d, tone, 0.16);
      coin(ctx, c.img, acx, acy, d, c.symbol, S, rank);
      medal(ctx, acx + d * 0.4, acy + d * 0.38, 19 * S, rank, S);
      const tx = acx + d / 2 + 26 * S;
      const tw = x + pw - 26 * S - tx;
      microLabel(ctx, tx, acy - 54 * S, rank === 1 ? "Gold" : rank === 2 ? "Silver" : "Bronze", { size: 11 * S, track: 0.34, color: tone });
      sym(ctx, c, tx, acy - 14 * S, tw, 32 * S, S, { min: 15 });
      nameLine(ctx, c, tx, acy + 10 * S, tw, 13.5 * S, S);
      bigPct(ctx, tx, acy + 66 * S, c.pctLabel, 40 * S, S);
      if (!c.pctLabel) microLabel(ctx, tx, acy + 52 * S, facts(c), { size: 11.5 * S, color: SITE.muted });
    });
    if (!rest.length) return;
    const by = y + topH + gap;
    const bh = BH * S - topH - gap;
    const fw = (IW * S - 14 * S * (rest.length - 1)) / rest.length;
    rest.forEach((c, k) => {
      const rank = k + 4;
      const x = X0 * S + k * (fw + 14 * S);
      const mx = x + fw / 2;
      luxe(ctx, x, by, fw, bh, 18 * S, S, { tone: toneOf(rank), rank });
      microLabel(ctx, mx, by + 30 * S, `No. ${String(rank).padStart(2, "0")}`, { size: 11 * S, track: 0.28, color: SITE.faint, align: "center" });
      const d = Math.min(62 * S, fw - 50 * S);
      const ay = by + 48 * S + d / 2;
      coin(ctx, c.img, mx, ay, d, c.symbol, S, rank);
      sym(ctx, c, mx, ay + d / 2 + 30 * S, fw - 20 * S, 19 * S, S, { align: "center", min: 10 });
      nameLine(ctx, c, mx, ay + d / 2 + 50 * S, fw - 24 * S, 11.5 * S, S, { align: "center", min: 8.5 });
      gainPill(ctx, mx, by + bh - 52 * S, c.pctLabel, 14 * S, S);
      if (c.mcap) microLabel(ctx, mx, by + bh - 18 * S, `MC ${fmtCap(c.mcap)}`, { size: 10 * S, track: 0.08, color: SITE.muted, align: "center" });
    });
  }

  // ── the ladder ───────────────────────────────────────────────────────────
  /** Index = the count a composition is designed for. A template whose board
   *  came up short draws the design for the count it actually has. */
  const LADDER = [null, crest, ticket, arc, hex, stairs, capsules, orbit, equalizer, cover, hall];
  const ladder = (k) => (ctx, S, spec, coins) => {
    const n = Math.max(1, Math.min(k, coins.length));
    return LADDER[n](ctx, S, spec, coins.slice(0, n));
  };

  // ── templates ────────────────────────────────────────────────────────────
  const title = (n) => (n > 1 ? `Top ${n} Gainers` : "Top Gainer");
  const T = (id, label, blurb, n, mood, accent) => ({ id, label, blurb, n, layout: `p_${id}`, mood, accent, title, premium: true });
  const TEMPLATES = {
    p1_crest: T("p1_crest", "💎 Diamond Crest", "The champion set inside a metal diamond, its move at billboard size beside it.", 1, "aurum", SITE.gold),
    p2_ticket: T("p2_ticket", "🎟 Golden Ticket", "One notched admission ticket — the winner's gold stub against the runner-up's silver.", 2, "ticket", SITE.gold),
    p3_arc: T("p3_arc", "🏅 Medal Arc", "Three medallions on one sweeping gold arc, each in its own pool of light.", 3, "arena", SITE.gold),
    p4_hex: T("p4_hex", "⬡ Hex Vault", "Four hexagonal vault doors, the move pinned beneath each.", 4, "hive", SITE.gold),
    p5_stairs: T("p5_stairs", "📶 Grand Staircase", "Five bars stepping down with rank — the ranking as a shape.", 5, "ascent", SITE.gold),
    p6_capsules: T("p6_capsules", "💊 Glass Capsules", "Six pill capsules in two columns, ghost rank numerals behind.", 6, "flow", SITE.cyan),
    p7_orbit: T("p7_orbit", "🪐 Orbit Seven", "The champion as a planet, six satellites docked around it.", 7, "cosmos", SITE.gold),
    p8_equalizer: T("p8_equalizer", "🎚 Equalizer", "Eight meter columns — each gain as a lit bar rising from the floor.", 8, "studio", SITE.gold),
    p9_cover: T("p9_cover", "📰 Cover Story", "A magazine cover: the champion as the lead story, eight more as the index.", 9, "press", SITE.gold),
    p10_hall: T("p10_hall", "🏛 Hall of Fame", "Three podium plaques over a gallery of seven portrait frames.", 10, "gala", SITE.gold),
  };
  const LAYOUTS = Object.fromEntries(Object.values(TEMPLATES).map((t) => [t.layout, ladder(t.n)]));

  // ── backdrops: one mood + one pattern per premium template ─────────────
  const MOODS = {
    aurum: { blooms: [[0.22, 0.6, 0.55, "gold", 0.2], [0.85, -0.1, 0.5, "violetDeep", 0.16], [1.0, 1.0, 0.4, "mint", 0.1]], pattern: "lattice" },
    ticket: { blooms: [[0.2, 0.2, 0.5, "gold", 0.18], [0.82, 0.25, 0.5, "cyan", 0.14], [0.5, 1.15, 0.6, "violetDeep", 0.14]], pattern: "chevrons" },
    arena: { blooms: [[0.5, 0.1, 0.6, "gold", 0.2], [0.5, 1.25, 0.8, "violetDeep", 0.2]], pattern: "floorGrid" },
    hive: { blooms: [[0.15, 0.2, 0.5, "mint", 0.16], [0.85, 0.85, 0.55, "cyan", 0.15], [0.5, -0.2, 0.5, "gold", 0.1]], pattern: "honeycomb" },
    ascent: { blooms: [[0.05, 0.25, 0.5, "gold", 0.18], [0.95, 1.0, 0.6, "mint", 0.13], [0.7, -0.1, 0.4, "violetDeep", 0.14]], pattern: "steps" },
    flow: { blooms: [[0.25, 0.1, 0.55, "cyan", 0.17], [0.8, 0.95, 0.55, "violet", 0.16], [0.95, 0.15, 0.35, "gold", 0.1]], pattern: "waves" },
    cosmos: { blooms: [[0.5, 0.55, 0.5, "gold", 0.17], [0.05, 0.1, 0.45, "violetDeep", 0.2], [0.95, 0.95, 0.45, "violetDeep", 0.2]], pattern: "burst" },
    studio: { blooms: [[0.5, 1.1, 0.7, "mint", 0.16], [0.1, -0.1, 0.45, "cyan", 0.14], [0.9, -0.1, 0.45, "violet", 0.14]], pattern: "meterGrid" },
    press: { blooms: [[0.15, 0.4, 0.5, "gold", 0.17], [0.85, 0.2, 0.55, "cyan", 0.12], [0.7, 1.1, 0.5, "violetDeep", 0.16]], pattern: "halftone" },
    gala: { blooms: [[0.5, -0.15, 0.75, "gold", 0.2], [0.1, 1.05, 0.45, "violetDeep", 0.18], [0.9, 1.05, 0.45, "mint", 0.12]], pattern: "confetti" },
  };

  const PATTERNS = {
    lattice(ctx, W, H, S) {
      ctx.save();
      ctx.strokeStyle = hexA(SITE.gold, 0.045);
      ctx.lineWidth = Math.max(1, 1.1 * S);
      const step = 96 * S;
      for (let x = -H; x < W + H; x += step) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x + H, H);
        ctx.moveTo(x + H, 0);
        ctx.lineTo(x, H);
        ctx.stroke();
      }
      ctx.restore();
    },
    chevrons(ctx, W, H, S) {
      ctx.save();
      ctx.strokeStyle = "rgba(255,255,255,.03)";
      ctx.lineWidth = 16 * S;
      for (let y = -H * 0.2; y < H * 1.2; y += 92 * S) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(W / 2, y + 120 * S);
        ctx.lineTo(W, y);
        ctx.stroke();
      }
      ctx.restore();
    },
    floorGrid(ctx, W, H, S) {
      ctx.save();
      const vy = H * 0.52;
      ctx.strokeStyle = hexA(SITE.gold, 0.06);
      ctx.lineWidth = Math.max(1, 1.1 * S);
      for (let i = -12; i <= 12; i++) {
        ctx.beginPath();
        ctx.moveTo(W / 2, vy);
        ctx.lineTo(W / 2 + i * W * 0.12, H);
        ctx.stroke();
      }
      for (let k = 1; k < 9; k++) {
        const y = vy + (H - vy) * Math.pow(k / 8, 1.8);
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(W, y);
        ctx.stroke();
      }
      ctx.restore();
    },
    honeycomb(ctx, W, H, S) {
      ctx.save();
      const r = 46 * S;
      const hw = r * Math.sqrt(3);
      ctx.strokeStyle = hexA(SITE.gold, 0.045);
      ctx.lineWidth = Math.max(1, 1.1 * S);
      for (let row = -1, y = 0; y < H + r * 2; row++, y = row * r * 1.5) {
        for (let x = (row % 2 ? hw / 2 : 0) - hw; x < W + hw; x += hw) {
          ctx.beginPath();
          for (let i = 0; i < 6; i++) {
            const a = -Math.PI / 2 + (i * Math.PI) / 3;
            ctx[i ? "lineTo" : "moveTo"](x + r * Math.cos(a), y + r * Math.sin(a));
          }
          ctx.closePath();
          ctx.stroke();
        }
      }
      ctx.restore();
    },
    steps(ctx, W, H, S) {
      ctx.save();
      for (let k = 0; k < 7; k++) {
        const x = W * 0.02 + k * 110 * S;
        const y = H * 0.28 + k * 70 * S;
        ctx.fillStyle = hexA(SITE.gold, 0.035);
        ctx.fillRect(x, y, W - x, 70 * S);
        ctx.fillStyle = hexA(SITE.gold, 0.08);
        ctx.fillRect(x, y, W - x, Math.max(1, 1.1 * S));
      }
      ctx.restore();
    },
    waves(ctx, W, H, S) {
      ctx.save();
      ctx.lineWidth = Math.max(1, 1.3 * S);
      for (let k = 0; k < 9; k++) {
        ctx.beginPath();
        const base = H * 0.18 + k * 82 * S;
        for (let x = 0; x <= W; x += 16 * S) {
          const y = base + Math.sin(x / (170 * S) + k * 0.7) * 26 * S;
          ctx[x ? "lineTo" : "moveTo"](x, y);
        }
        ctx.strokeStyle = hexA(k % 2 ? SITE.violet : SITE.cyan, 0.06);
        ctx.stroke();
      }
      ctx.restore();
    },
    burst(ctx, W, H, S) {
      ctx.save();
      const cx = W / 2;
      const cy = H * 0.59;
      for (let i = 0; i < 36; i++) {
        const a = (i / 36) * Math.PI * 2;
        const g = ctx.createLinearGradient(cx, cy, cx + Math.cos(a) * W * 0.7, cy + Math.sin(a) * W * 0.7);
        g.addColorStop(0, hexA(SITE.gold, 0.09));
        g.addColorStop(1, hexA(SITE.gold, 0));
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(cx + Math.cos(a) * W * 0.7, cy + Math.sin(a) * W * 0.7);
        ctx.lineWidth = Math.max(1, 1.4 * S);
        ctx.strokeStyle = g;
        ctx.stroke();
      }
      ctx.restore();
    },
    meterGrid(ctx, W, H, S) {
      ctx.save();
      for (let y = H * 0.32; y < H * 0.9; y += 40 * S) {
        for (let x = 40 * S; x < W - 40 * S; x += 22 * S) {
          ctx.fillStyle = hexA(PLAT, 0.05);
          ctx.fillRect(x, y, 10 * S, Math.max(1, 1.2 * S));
        }
      }
      ctx.restore();
    },
    halftone(ctx, W, H, S) {
      ctx.save();
      const step = 26 * S;
      for (let y = step; y < H; y += step) {
        for (let x = W * 0.45; x < W; x += step) {
          const f = ((x - W * 0.45) / (W * 0.55)) * (1 - y / H);
          const r = Math.max(0, f) * 7 * S;
          if (r < 0.6 * S) continue;
          ctx.beginPath();
          ctx.arc(x, y, r, 0, Math.PI * 2);
          ctx.fillStyle = hexA(SITE.gold, 0.06);
          ctx.fill();
        }
      }
      ctx.restore();
    },
    confetti(ctx, W, H, S) {
      const toks = [SITE.gold, "#FFF0C0", PLAT, "#E38A3C"];
      // a celebration falling from the top edge: dense at the ceiling,
      // thinning out before it reaches the plaques
      for (let i = 0; i < 90; i++) {
        const h = (i * 2654435761) >>> 0;
        const x = ((h % 1009) / 1009) * W;
        const f = ((h >> 11) % 887) / 887;
        const y = H * 0.02 + f * f * H * 0.42;
        // keep the title column clear — confetti over the type is noise
        if (x > W * 0.26 && x < W * 0.74 && y > H * 0.12) continue;
        const rot = ((h >> 5) % 360) * (Math.PI / 180);
        const len = (8 + ((h >> 15) % 4) * 3) * S;
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(rot);
        ctx.fillStyle = hexA(toks[i % toks.length], (0.26 - f * 0.18) * (0.7 + ((h >> 9) % 3) * 0.15));
        ctx.fillRect(-len / 2, -2.2 * S, len, 4.4 * S);
        ctx.restore();
      }
    },
  };

  // ── the premium CHROME: backdrop, header, footer ───────────────────────
  // The classic set's page is the site's page (mint keyline, mint title). This
  // set gets its own — black and gold, a stamped-foil title, a framed poster
  // edge — because a premium board that shares the classic chrome reads as the
  // classic board with different cards in it. The brand lockup, the LIVE · 24H
  // chip and the dexvra.io CTA all stay: it is a Dexvra poster either way.
  // (The kicker and the chip keep their exact wording — gainersPct.test counts
  // the "24H" mentions every template's header makes.)

  /** Deterministic bokeh — out-of-focus lights in the field. */
  function bokeh(ctx, W, H, S) {
    const toks = [SITE.gold, "#FFF0C0", "#E38A3C", PLAT];
    for (let i = 0; i < 26; i++) {
      const h = ((i + 7) * 2246822519) >>> 0;
      const x = ((h % 1013) / 1013) * W;
      const y = (((h >>> 10) % 911) / 911) * H;
      const r = (10 + ((h >>> 20) % 9) * 6) * S;
      radial(ctx, x, y, r, toks[i % toks.length], 0.05 + ((h >>> 6) % 4) * 0.02, 0);
      ctx.beginPath();
      ctx.arc(x, y, r * 0.55, 0, Math.PI * 2);
      ctx.lineWidth = Math.max(1, 0.8 * S);
      ctx.strokeStyle = hexA(toks[i % toks.length], 0.035);
      ctx.stroke();
    }
  }

  function backdrop(cv, ctx, S, spec, bg) {
    const W = REF_W * S;
    const H = REF_H * S;
    if (bg) {
      drawCover(ctx, bg, 0, 0, W, H);
      const scrim = ctx.createLinearGradient(0, 0, 0, H);
      scrim.addColorStop(0, "rgba(5,6,9,.86)");
      scrim.addColorStop(0.5, "rgba(5,6,9,.72)");
      scrim.addColorStop(1, "rgba(5,6,9,.9)");
      ctx.fillStyle = scrim;
      ctx.fillRect(0, 0, W, H);
    } else {
      const base = ctx.createRadialGradient(W / 2, H * 0.42, 0, W / 2, H * 0.42, W * 0.75);
      base.addColorStop(0, "#151821");
      base.addColorStop(0.55, "#0A0B10");
      base.addColorStop(1, "#040406");
      ctx.fillStyle = base;
      ctx.fillRect(0, 0, W, H);
      const mood = MOODS[spec.mood];
      if (mood) {
        for (const [bx, by, br, tok, a] of mood.blooms) radial(ctx, W * bx, H * by, W * br, SITE[tok] || SITE.gold, a * 0.85);
        if (mood.pattern && PATTERNS[mood.pattern]) {
          ctx.save();
          PATTERNS[mood.pattern](ctx, W, H, S);
          ctx.restore();
        }
      }
      bokeh(ctx, W, H, S);
    }
    // the gold spotlight the title sits in
    ctx.save();
    ctx.translate(W / 2, H * 0.17);
    ctx.scale(1, 0.42);
    radial(ctx, 0, 0, W * 0.4, SITE.gold, 0.14);
    ctx.restore();
    grain(cv, ctx, W, H, S);
    // deep vignette — the luxury falls away into black at the corners
    const vg = ctx.createRadialGradient(W / 2, H * 0.46, H * 0.42, W / 2, H / 2, H * 1.05);
    vg.addColorStop(0, "rgba(0,0,0,0)");
    vg.addColorStop(1, "rgba(0,0,0,.62)");
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, W, H);
    // the poster edge: a gold double frame with bright corner brackets
    const fx = 22 * S;
    const fr = ctx.createLinearGradient(0, 0, W, H);
    fr.addColorStop(0, hexA(SITE.gold, 0.6));
    fr.addColorStop(0.5, hexA(SITE.gold, 0.14));
    fr.addColorStop(1, hexA(SITE.gold, 0.6));
    roundRect(ctx, fx, fx, W - 2 * fx, H - 2 * fx, 6 * S);
    ctx.lineWidth = Math.max(1, 1.4 * S);
    ctx.strokeStyle = fr;
    ctx.stroke();
    roundRect(ctx, fx + 7 * S, fx + 7 * S, W - 2 * fx - 14 * S, H - 2 * fx - 14 * S, 4 * S);
    ctx.lineWidth = Math.max(1, 0.8 * S);
    ctx.strokeStyle = hexA(SITE.gold, 0.12);
    ctx.stroke();
    const L = 46 * S;
    const bx = 14 * S;
    ctx.save();
    ctx.lineWidth = Math.max(2, 2.6 * S);
    ctx.lineCap = "square";
    ctx.strokeStyle = foil(ctx, 0, H);
    for (const [cx0, cy0, dx, dy] of [[bx, bx, 1, 1], [W - bx, bx, -1, 1], [bx, H - bx, 1, -1], [W - bx, H - bx, -1, -1]]) {
      ctx.beginPath();
      ctx.moveTo(cx0, cy0 + dy * L);
      ctx.lineTo(cx0, cy0);
      ctx.lineTo(cx0 + dx * L, cy0);
      ctx.stroke();
    }
    ctx.restore();
    // gold keyline across the very top
    const kl = ctx.createLinearGradient(0, 0, W, 0);
    kl.addColorStop(0, hexA(SITE.gold, 0));
    kl.addColorStop(0.5, hexA("#FFF0C0", 0.9));
    kl.addColorStop(1, hexA(SITE.gold, 0));
    ctx.fillStyle = kl;
    ctx.fillRect(0, 0, W, Math.max(2, 3 * S));
  }

  /** A small rotated-square jewel — the ornament's centre stone. */
  function gem(ctx, cx, cy, r, S) {
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(cx, cy - r);
    ctx.lineTo(cx + r, cy);
    ctx.lineTo(cx, cy + r);
    ctx.lineTo(cx - r, cy);
    ctx.closePath();
    ctx.fillStyle = foil(ctx, cy - r, cy + r);
    ctx.shadowColor = hexA(SITE.gold, 0.7);
    ctx.shadowBlur = 12 * S;
    ctx.fill();
    ctx.restore();
  }

  /** The ornament rule: two gold hairlines fading outward, a centre stone. */
  function ornament(ctx, cx, y, half, S) {
    for (const dir of [-1, 1]) {
      const g = ctx.createLinearGradient(cx + dir * 22 * S, 0, cx + dir * half, 0);
      g.addColorStop(0, hexA(SITE.gold, 0.9));
      g.addColorStop(1, hexA(SITE.gold, 0));
      ctx.fillStyle = g;
      const x0 = dir < 0 ? cx - half : cx + 22 * S;
      ctx.fillRect(x0, y - 0.75 * S, half - 22 * S, Math.max(1, 1.5 * S));
      ctx.beginPath();
      ctx.arc(cx + dir * 15 * S, y, 2 * S, 0, Math.PI * 2);
      ctx.fillStyle = SITE.gold;
      ctx.fill();
    }
    gem(ctx, cx, y, 6.5 * S, S);
  }

  function header(ctx, S, spec, { n, dateText }) {
    const W = REF_W * S;
    const x = PAD * S;
    const right = W - PAD * S;
    drawBrandMark(ctx, x, 46 * S, 56 * S);
    ctx.save();
    ctx.font = `700 ${32 * S}px ${F.d7}`;
    ctx.fillStyle = SITE.text;
    ctx.textBaseline = "alphabetic";
    ctx.fillText("Dexvra", x + 72 * S, 82 * S);
    ctx.restore();
    microLabel(ctx, x + 74 * S, 104 * S, "Premium board", { size: 10.5 * S, color: SITE.gold, track: 0.3 });

    let rx = right;
    if (dateText) rx -= chip(ctx, rx, 74 * S, dateText, 12.5 * S, S, { align: "right", color: "#D9C8A0", border: hexA(SITE.gold, 0.22), bg: "rgba(255,255,255,.02)" }) + 14 * S;
    const liveW = chip(ctx, rx, 74 * S, "   Live · 24H", 12.5 * S, S, {
      align: "right", color: SITE.gold, border: hexA(SITE.gold, 0.5), bg: hexA(SITE.gold, 0.08),
    });
    const dotX = rx - liveW + 17 * S;
    radial(ctx, dotX, 71.5 * S, 12 * S, SITE.mint, 0.55);
    ctx.beginPath();
    ctx.arc(dotX, 71.5 * S, 3.4 * S, 0, Math.PI * 2);
    ctx.fillStyle = SITE.mint;
    ctx.fill();

    const cx = W / 2;
    microLabel(ctx, cx, 150 * S, "Ranked by 24h change · live from dexvra.io", { size: 12 * S, color: "#D9C8A0", track: 0.3, align: "center" });

    // the title, stamped in gold foil
    const title = String(spec.title(n) || "").toUpperCase();
    let size = 78 * S;
    const track = () => size * 0.09;
    const runW = () => {
      ctx.font = `800 ${size}px ${F.x}`;
      return ctx.measureText(title).width + track() * Math.max(0, title.length - 1);
    };
    while (size > 40 * S && runW() > W - 2 * PAD * S - 120 * S) size -= 2 * S;
    const baseline = 232 * S;
    ctx.save();
    ctx.font = `800 ${size}px ${F.x}`;
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = "rgba(0,0,0,.65)";
    trackedCenter(ctx, cx + 2 * S, baseline + 4 * S, title, track());
    ctx.fillStyle = "#6E4A12";
    trackedCenter(ctx, cx, baseline + 2 * S, title, track());
    ctx.fillStyle = foil(ctx, baseline - size * 0.8, baseline + size * 0.05);
    ctx.shadowColor = hexA(SITE.gold, 0.45);
    ctx.shadowBlur = 26 * S;
    const tw = trackedCenter(ctx, cx, baseline, title, track());
    ctx.restore();
    ornament(ctx, cx, 256 * S, Math.min(tw * 0.62, W * 0.3), S);
  }

  function footer(ctx, S) {
    const W = REF_W * S;
    const x = PAD * S;
    const y = 820 * S;
    const frameBottom = (REF_H - 22) * S;
    const rg = ctx.createLinearGradient(x, 0, W - x, 0);
    rg.addColorStop(0, hexA(SITE.gold, 0));
    rg.addColorStop(0.5, hexA(SITE.gold, 0.35));
    rg.addColorStop(1, hexA(SITE.gold, 0));
    ctx.fillStyle = rg;
    ctx.fillRect(x, y, W - 2 * PAD * S, Math.max(1, 1 * S));
    const midY = (y + frameBottom) / 2;
    const bw0 = microLabel(ctx, x, midY + 4.5 * S, "Dexvra · Premium", { size: 12 * S, color: SITE.faint, track: 0.24 });
    microLabel(ctx, x + bw0 + 24 * S, midY + 4.5 * S, "Find the next Moonshot", { size: 12 * S, color: "#D9C8A0", track: 0.24 });
    const label = "dexvra.io";
    ctx.save();
    ctx.font = `800 ${16 * S}px ${F.x}`;
    const tw = ctx.measureText(label).width;
    const bh = 40 * S;
    const bw = tw + 52 * S;
    const bx = W - PAD * S - bw;
    const by = midY - bh / 2;
    roundRect(ctx, bx, by, bw, bh, bh / 2);
    ctx.fillStyle = foil(ctx, by, by + bh);
    ctx.shadowColor = hexA(SITE.gold, 0.35);
    ctx.shadowBlur = 14 * S;
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle = "#1C1305";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(label, bx + bw / 2, by + bh / 2 + 1 * S);
    ctx.restore();
  }

  return { TEMPLATES, LAYOUTS, MOODS, PATTERNS, IDS: Object.keys(TEMPLATES), chrome: { backdrop, header, footer } };
};
