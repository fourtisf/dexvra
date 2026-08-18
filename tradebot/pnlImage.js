'use strict';
/*
 * pnlImage.js — the PnL card as a PICTURE.
 *
 * WHY AN IMAGE AT ALL
 * A PnL card is a thing traders SHARE. The text card answers the question; a
 * screenshot of a wall of numbers is not what anybody posts. This draws the
 * same figures — from the same `pnl.pnlStats()` — as a card with one number on
 * it big enough to read at thumbnail size.
 *
 * WHY IT DRAWS THROUGH bot/src/helpers/canvasKit
 * That module already owns the brand palette, the primitives, and — the part
 * that matters — the FONT FALLBACK CHAIN and `warnBoxes()`. A token called 牛来
 * went out to 12,607 subscribers as "$???" because a face without the glyph
 * draws a box instead of throwing; the fix lives there and every renderer in
 * this repo is required to go through it. A second copy of the font logic in
 * tradebot would be the same outage waiting on a second process.
 *
 * IT IS OPTIONAL, AND FAILURE IS FREE
 * The native canvas binary lives in bot/node_modules. If it is missing, or the
 * kit cannot be reached, or a draw throws, `render()` returns null and the
 * caller sends the text card it already had. A picture is an upgrade; it may
 * never be the reason a user cannot see their PnL.
 */
const path = require('node:path');
const pnl = require('./pnl');

let KIT = null;   // null = not tried, undefined = tried and unavailable
function kit() {
  if (KIT !== null) return KIT;
  try {
    const k = require(path.join(__dirname, '..', 'bot', 'src', 'helpers', 'canvasKit'));
    KIT = (k && typeof k.available === 'function' && k.available()) ? k : undefined;
  } catch (_) { KIT = undefined; }
  return KIT;
}
/** Is the picture available at all? Callers use it only to decide whether to
 *  bother; `render()` is still allowed to return null. */
function available() { return !!kit(); }

const W = 1200, H = 675;
const BAR = 118;               // the brand strip along the foot
const ART = 470;               // the artwork column on the left

/** A short, human amount for a stat row. */
function short(v, native) {
  const n = Math.abs(Number(v) || 0);
  const s = n >= 1000 ? n.toFixed(1) : n >= 1 ? n.toFixed(3) : n.toFixed(4);
  return `${s} ${native}`;
}
const usdShort = (v) => {
  const n = Math.abs(Number(v) || 0);
  if (!(n > 0)) return '';
  if (n >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
  return '$' + n.toFixed(n >= 1 ? 2 : 4);
};
/** "0d 0h 13m", the way a trading bot states a hold. */
function heldFor(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

/**
 * Fetch bytes for a picture we want to draw INTO the card.
 *
 * Bounded and best-effort in every direction: a short timeout, a size cap (a
 * card must not be held up by somebody's 8 MB PNG), and null on anything at
 * all. The card is drawn either way — the logo is decoration, and decoration
 * may never be the reason a PnL is late or missing.
 */
const _bytes = new Map();
const BYTES_TTL_MS = 6 * 3600 * 1000;
const BYTES_MAX = 4 * 1024 * 1024;
async function fetchBytes(url, ms = 4000) {
  if (!url) return null;
  const hit = _bytes.get(url);
  if (hit && Date.now() - hit.at < BYTES_TTL_MS) return hit.buf;
  let buf = null;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(ms) });
    if (r.ok) {
      const len = Number(r.headers.get('content-length') || 0);
      if (!len || len <= BYTES_MAX) {
        const ab = await r.arrayBuffer();
        if (ab.byteLength <= BYTES_MAX) buf = Buffer.from(ab);
      }
    }
  } catch (_) { buf = null; }
  if (_bytes.size >= 200) _bytes.delete(_bytes.keys().next().value);
  _bytes.set(url, { at: Date.now(), buf });
  return buf;
}

/** Draw `img` cropped to a circle at (cx,cy,r) — a token logo is any aspect
 *  ratio and a squashed one looks like a bug in the card. */
function circleImage(ctx, img, cx, cy, r) {
  const side = Math.min(img.width, img.height);
  const sx = (img.width - side) / 2, sy = (img.height - side) / 2;
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.closePath();
  ctx.clip();
  ctx.drawImage(img, sx, sy, side, side, cx - r, cy - r, r * 2, r * 2);
  ctx.restore();
}

/**
 * Draw the card. `p` is core.tokenPnl()'s return — RAW, not HTML-escaped: this
 * draws glyphs, and `&amp;` on a canvas is four characters of nonsense.
 *
 * Returns a PNG Buffer, or null when there is nothing honest to draw (no
 * canvas, or a total we could not compute — an image is a claim, and an image
 * of an unknown is a claim nobody can qualify).
 */
async function render(p, { native = 'ETH', rate = 0, chainName = '', logoUrl = '', refLink = '', qrApi = '' } = {}) {
  const K = kit();
  if (!K) return null;
  const s = pnl.pnlStats(p);
  // A picture cannot carry "we could not read it just now" the way a sentence
  // can — it would be a branded card stating a number that is not known. Those
  // fall back to the text card, which says so in words.
  if (s.unknown || s.status === 'none' || !(s.ethIn > 0)) return null;
  const C = K.canvasLib();
  if (!C) return null;
  // The glyph guard every renderer in this repo is required to call. It warns
  // and draws anyway: a card with a box in it still beats no card.
  try { K.warnBoxes('pnl card', { symbol: p.sym, name: p.name }); } catch (_) {}

  // The two pictures, fetched TOGETHER and never awaited one after the other —
  // and both are allowed to fail.
  const [logoBuf, qrBuf] = await Promise.all([
    fetchBytes(logoUrl, 4000),
    refLink && qrApi ? fetchBytes(`${qrApi}/?size=240x240&margin=0&data=${encodeURIComponent(refLink)}`, 4000) : Promise.resolve(null),
  ]);
  let logo = null, qr = null;
  try { if (logoBuf) logo = await C.loadImage(logoBuf); } catch (_) { logo = null; }
  try { if (qrBuf) qr = await C.loadImage(qrBuf); } catch (_) { qr = null; }

  const cv = C.createCanvas(W, H);
  const ctx = cv.getContext('2d');
  const win = s.pnl > 0;
  const flat = s.pnl === 0;
  const ACC = win ? K.SITE.upFrom : flat ? K.MUTE : K.SITE.downTo;
  const ACC2 = win ? K.SITE.upTo : flat ? K.FAINT : K.SITE.downFrom;

  // ── ground ────────────────────────────────────────────────────────────────
  const bg = ctx.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, '#0A0E1A');
  bg.addColorStop(0.55, win ? '#0B1524' : '#140B1C');
  bg.addColorStop(1, win ? '#07131C' : '#1B0C1A');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);
  K.radial(ctx, ART * 0.52, (H - BAR) * 0.46, 420, ACC, win ? 0.20 : 0.16);
  K.radial(ctx, W * 0.88, 90, 380, K.CYAN, 0.10);
  ctx.strokeStyle = K.hexA('#FFFFFF', 0.028);
  ctx.lineWidth = 1;
  for (let x = 60; x < W; x += 60) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H - BAR); ctx.stroke(); }
  for (let y = 60; y < H - BAR; y += 60) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }

  // ── the artwork: the token's own face, or the Dexvra gem wearing its ticker
  const cx = ART * 0.52, cy = (H - BAR) * 0.47, R = 156;
  // Two arcs sweeping around the art — the "in motion" figure Maestro draws
  // with a swoosh, in the accent so a win and a loss are different at a glance.
  ctx.save();
  ctx.strokeStyle = K.hexA(ACC, 0.55);
  ctx.lineWidth = 3;
  ctx.beginPath(); ctx.arc(cx, cy, R + 34, -0.9, 1.4); ctx.stroke();
  ctx.strokeStyle = K.hexA(K.CYAN, 0.3);
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(cx, cy, R + 56, 1.9, 3.6); ctx.stroke();
  ctx.restore();
  // The halo, then the disc, then the art.
  ctx.save();
  ctx.shadowColor = K.hexA(ACC, 0.75);
  ctx.shadowBlur = 60;
  ctx.beginPath(); ctx.arc(cx, cy, R + 6, 0, Math.PI * 2);
  ctx.fillStyle = K.hexA(ACC, 0.16);
  ctx.fill();
  ctx.restore();
  ctx.save();
  ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.fillStyle = '#0D1119';
  ctx.fill();
  ctx.restore();
  if (logo) {
    circleImage(ctx, logo, cx, cy, R - 8);
  } else {
    // NO LOGO IS THE COMMON CASE for a launch this bot snipes, so the fallback
    // is the design and not an apology: the brand gem, with the ticker's
    // monogram set on it.
    // ⚠️ drawGem's (x,y) is the TOP-LEFT of a 48-unit box, not the centre — the
    // first cut passed the centre and the gem landed half a diameter down and
    // right, straight through the monogram.
    const GS = 104;
    try { K.drawGem(ctx, cx - GS / 2, cy - 52 - GS * 0.51, GS); } catch (_) {}
    const mono = String(p.sym || '?').replace(/[^A-Za-z0-9]/g, '').slice(0, 4).toUpperCase() || '?';
    ctx.textAlign = 'center';
    ctx.fillStyle = K.INK;
    const mt = K.fitText(ctx, mono, R * 1.35, { weight: 800, size: 66, min: 24, family: K.F.x });
    ctx.save();
    ctx.shadowColor = K.hexA('#000000', 0.6);
    ctx.shadowBlur = 18;
    ctx.fillText(mt, cx, cy + 74);
    ctx.restore();
  }
  // The ring, in the accent, over whichever of the two was drawn.
  ctx.save();
  ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2);
  const rg = ctx.createLinearGradient(cx - R, cy - R, cx + R, cy + R);
  rg.addColorStop(0, ACC);
  rg.addColorStop(1, ACC2);
  ctx.strokeStyle = rg;
  ctx.lineWidth = 6;
  ctx.stroke();
  ctx.restore();

  // ── the stats column ──────────────────────────────────────────────────────
  const RX = ART + 44;                       // left edge of the stats
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  // $TICKER + the multiple badge, on one line — the badge is the headline the
  // eye lands on second, so it sits beside the name and not under it.
  const tick = '$' + String(p.sym || '').toUpperCase().slice(0, 12);
  ctx.fillStyle = K.INK;
  const tickTxt = K.fitText(ctx, tick, 300, { weight: 800, size: 58, min: 26, family: K.F.x });
  ctx.fillText(tickTxt, RX, 138);
  const tickW = ctx.measureText(tickTxt).width;
  const multTxt = s.mult == null ? '—' : `${s.mult >= 100 ? Math.round(s.mult) : s.mult.toFixed(2)}X`;
  ctx.font = `800 44px ${K.F.d7}`;
  const badgeW = ctx.measureText(multTxt).width + 96;
  const bx = Math.min(RX + tickW + 26, W - 62 - badgeW);
  ctx.save();
  K.roundRect(ctx, bx, 96, badgeW, 58, 12);
  const bgd = ctx.createLinearGradient(bx, 0, bx + badgeW, 0);
  bgd.addColorStop(0, ACC);
  bgd.addColorStop(1, ACC2);
  ctx.fillStyle = bgd;
  ctx.fill();
  ctx.restore();
  ctx.fillStyle = win ? K.SITE.upInk : '#FFFFFF';
  ctx.fillText(multTxt, bx + 24, 139);
  // The arrow — the one mark that says up or down without a number.
  const ax = bx + badgeW - 46, ay = 125;
  ctx.save();
  ctx.strokeStyle = win ? K.SITE.upInk : '#FFFFFF';
  ctx.fillStyle = win ? K.SITE.upInk : '#FFFFFF';
  ctx.lineWidth = 7;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(ax, ay - (win ? 16 : 18));
  ctx.lineTo(ax, ay + (win ? 18 : 16));
  ctx.stroke();
  ctx.beginPath();
  if (win) { ctx.moveTo(ax - 15, ay - 4); ctx.lineTo(ax, ay - 22); ctx.lineTo(ax + 15, ay - 4); }
  else { ctx.moveTo(ax - 15, ay + 4); ctx.lineTo(ax, ay + 22); ctx.lineTo(ax + 15, ay + 4); }
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  // Held for — and the state, because a card that says nothing about whether
  // this is over reads as though it is.
  ctx.fillStyle = K.MUTE;
  ctx.font = `600 24px ${K.F.m6}`;
  const held = (p.trades && p.trades.firstAt) ? `Held for: ${heldFor(Date.now() - p.trades.firstAt)}` : '';
  const state = s.status === 'closed' ? 'Closed' : s.status === 'partial' ? 'Partly sold' : 'Still holding';
  ctx.fillText([held, state].filter(Boolean).join('   ·   '), RX, 180);

  // THE NUMBER. Nothing on the card competes with it.
  const pctTxt = s.pct == null ? '—' : `${s.pct > 0 ? '+' : s.pct < 0 ? '-' : ''}${Math.abs(s.pct) >= 1000 ? Math.round(Math.abs(s.pct)) : Math.abs(s.pct).toFixed(0)}%`;
  ctx.save();
  ctx.shadowColor = K.hexA(ACC, 0.6);
  ctx.shadowBlur = 46;
  const pg = ctx.createLinearGradient(RX, 210, RX + 520, 330);
  pg.addColorStop(0, ACC);
  pg.addColorStop(1, ACC2);
  ctx.fillStyle = pg;
  const pTxt = K.fitText(ctx, pctTxt, W - RX - 62, { weight: 800, size: 138, min: 56, family: K.F.x });
  ctx.fillText(pTxt, RX, 330);
  ctx.restore();

  // INVESTED / PAYOUT — Maestro's two rows, which is all a shared card needs:
  // what went in, what came back. "Payout" is what is realised on a closed
  // trade and what the bag is worth on an open one, and the label says which.
  const rows = [
    ['INVESTED', short(s.ethIn, native), rate > 0 ? usdShort(s.ethIn * rate) : ''],
    [s.status === 'closed' ? 'PAYOUT' : 'VALUE NOW', short(s.status === 'closed' ? s.ethOut : s.ethOut + s.value, native), rate > 0 ? usdShort((s.status === 'closed' ? s.ethOut : s.ethOut + s.value) * rate) : ''],
  ];
  let ry = 404;
  for (const [label, val, sub] of rows) {
    ctx.fillStyle = K.FAINT;
    ctx.font = `700 22px ${K.F.m7}`;
    ctx.fillText(label, RX, ry);
    ctx.fillStyle = K.INK;
    const vt = K.fitText(ctx, val, 360, { weight: 700, size: 40, min: 20, family: K.F.d7 });
    ctx.textAlign = 'right';
    ctx.fillText(vt, W - 62, ry + 2);
    if (sub) {
      ctx.fillStyle = K.MUTE;
      ctx.font = `600 20px ${K.F.m6}`;
      ctx.fillText(sub, W - 62, ry + 32);
    }
    ctx.textAlign = 'left';
    ry += 74;
  }

  // ── the brand strip ───────────────────────────────────────────────────────
  ctx.save();
  ctx.fillStyle = K.hexA('#000000', 0.55);
  ctx.fillRect(0, H - BAR, W, BAR);
  const line = ctx.createLinearGradient(0, 0, W, 0);
  line.addColorStop(0, K.hexA(ACC, 0));
  line.addColorStop(0.35, K.hexA(ACC, 0.8));
  line.addColorStop(1, K.hexA(K.CYAN, 0));
  ctx.fillStyle = line;
  ctx.fillRect(0, H - BAR, W, 2);
  ctx.restore();
  K.drawBrandMark(ctx, 54, H - BAR + 30, 58);
  ctx.textAlign = 'left';
  ctx.fillStyle = K.INK;
  ctx.font = `800 36px ${K.F.d7}`;
  ctx.fillText('DEXVRA', 130, H - BAR + 60);
  ctx.fillStyle = K.MUTE;
  ctx.font = `600 17px ${K.F.m6}`;
  ctx.fillText('TRADE  ·  SNIPE  ·  COPY', 132, H - BAR + 88);
  // The referral, and its QR — the reason a shared card is worth sharing.
  if (qr) {
    const q = 84, qx = W - 54 - q, qy = H - BAR + (BAR - q) / 2;
    ctx.save();
    K.roundRect(ctx, qx - 6, qy - 6, q + 12, q + 12, 10);
    ctx.fillStyle = '#FFFFFF';
    ctx.fill();
    ctx.restore();
    ctx.drawImage(qr, qx, qy, q, q);
    ctx.textAlign = 'right';
    ctx.fillStyle = K.SOFT;
    ctx.font = `600 19px ${K.F.m6}`;
    ctx.fillText('Scan to trade with Dexvra', qx - 22, H - BAR + 52);
    ctx.fillStyle = K.FAINT;
    ctx.font = `600 17px ${K.F.m6}`;
    ctx.fillText('and earn from every referral', qx - 22, H - BAR + 78);
  } else {
    ctx.textAlign = 'right';
    ctx.fillStyle = K.SOFT;
    ctx.font = `700 22px ${K.F.m7}`;
    ctx.fillText('dexvra.io', W - 54, H - BAR + 58);
    if (chainName) {
      ctx.fillStyle = K.FAINT;
      ctx.font = `600 18px ${K.F.m6}`;
      ctx.fillText(chainName, W - 54, H - BAR + 86);
    }
  }
  // The chain, where the QR did not take the corner.
  if (qr && chainName) {
    ctx.textAlign = 'left';
    ctx.fillStyle = K.FAINT;
    ctx.font = `600 18px ${K.F.m6}`;
    ctx.fillText(chainName, 132, H - BAR + 110);
  }

  try { return cv.toBuffer('image/png'); } catch (_) { return null; }
}

module.exports = { render, available, W, H };
