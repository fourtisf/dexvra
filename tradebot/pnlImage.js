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

/** A short, human amount for a tile — the card has no room for six decimals and
 *  the exact figures are on the message beneath it. */
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

/**
 * Draw the card. `p` is core.tokenPnl()'s return — RAW, not HTML-escaped: this
 * draws glyphs, and `&amp;` on a canvas is four characters of nonsense.
 *
 * Returns a PNG Buffer, or null when there is nothing honest to draw (no
 * canvas, or a total we could not compute — an image is a claim, and an image
 * of an unknown is a claim nobody can qualify).
 */
function render(p, { native = 'ETH', rate = 0, chainName = '', chainEmoji = '' } = {}) {
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

  const cv = C.createCanvas(W, H);
  const ctx = cv.getContext('2d');
  const win = s.pnl > 0;
  const flat = s.pnl === 0;
  const ACC = win ? K.SITE.upFrom : flat ? K.MUTE : K.SITE.downFrom;
  const ACC2 = win ? K.SITE.upTo : flat ? K.FAINT : K.SITE.downTo;

  // ── ground ────────────────────────────────────────────────────────────────
  ctx.fillStyle = K.SITE.bg;
  ctx.fillRect(0, 0, W, H);
  // Two glows in the accent, so a win and a loss are different cards at a
  // glance — before a single digit has been read.
  K.radial(ctx, W * 0.78, H * 0.18, 520, ACC, 0.16);
  K.radial(ctx, W * 0.12, H * 0.92, 460, win ? K.CYAN : K.SITE.violet, 0.12);
  // A faint grid: structure without content.
  ctx.strokeStyle = K.hexA('#FFFFFF', 0.03);
  ctx.lineWidth = 1;
  for (let x = 60; x < W; x += 60) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
  for (let y = 60; y < H; y += 60) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
  // The card body.
  ctx.save();
  K.roundRect(ctx, 28, 28, W - 56, H - 56, 34);
  ctx.fillStyle = K.hexA(K.SITE.card, 0.92);
  ctx.fill();
  ctx.strokeStyle = K.hexA(ACC, 0.28);
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.restore();

  // ── header: brand · status · chain ────────────────────────────────────────
  K.drawBrandMark(ctx, 62, 58, 44);
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  ctx.fillStyle = K.INK;
  ctx.font = `800 26px ${K.F.d7}`;
  ctx.fillText('DEXVRA', 118, 78);
  ctx.fillStyle = K.MUTE;
  ctx.font = `700 15px ${K.F.m7}`;
  ctx.fillText('P&L CARD', 118, 100);

  const badge = s.status === 'closed' ? 'CLOSED' : s.status === 'partial' ? 'PARTLY SOLD' : 'HOLDING';
  ctx.font = `800 17px ${K.F.m8}`;
  const bw = ctx.measureText(badge).width + 40;
  ctx.save();
  K.roundRect(ctx, W - 62 - bw, 52, bw, 40, 20);
  ctx.fillStyle = K.hexA(ACC, 0.18);
  ctx.fill();
  ctx.strokeStyle = K.hexA(ACC, 0.5);
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.restore();
  ctx.fillStyle = ACC;
  ctx.textAlign = 'center';
  ctx.fillText(badge, W - 62 - bw / 2, 78);

  // ── the token ─────────────────────────────────────────────────────────────
  ctx.textAlign = 'left';
  const tick = '$' + String(p.sym || '').toUpperCase().slice(0, 14);
  ctx.fillStyle = K.INK;
  const tickTxt = K.fitText(ctx, tick, 520, { weight: 800, size: 64, min: 30, family: K.F.x });
  ctx.fillText(tickTxt, 62, 190);
  if (p.name) {
    ctx.fillStyle = K.MUTE;
    const nm = K.fitText(ctx, String(p.name), 520, { weight: 500, size: 24, min: 14, family: K.F.m });
    ctx.fillText(nm, 62, 224);
  }

  // ── the hero: the multiple, then the percent ──────────────────────────────
  // ONE number is the headline. The multiple is what a trader repeats out loud
  // ("a 3x"), so it is the biggest thing on the card and the percent sits under
  // it as the precise form of the same fact.
  const multTxt = s.mult == null ? '—' : `${s.mult.toFixed(2)}×`;
  ctx.textAlign = 'right';
  ctx.save();
  ctx.shadowColor = K.hexA(ACC, 0.55);
  ctx.shadowBlur = 42;
  const g = ctx.createLinearGradient(W - 620, 130, W - 62, 260);
  g.addColorStop(0, ACC);
  g.addColorStop(1, ACC2);
  ctx.fillStyle = g;
  const mTxt = K.fitText(ctx, multTxt, 520, { weight: 800, size: 132, min: 60, family: K.F.x });
  ctx.fillText(mTxt, W - 62, 214);
  ctx.restore();
  const pctTxt = s.pct == null ? '' : `${s.pct > 0 ? '+' : s.pct < 0 ? '−' : ''}${Math.abs(s.pct).toFixed(2)}%`;
  ctx.fillStyle = ACC;
  ctx.font = `800 40px ${K.F.m8}`;
  ctx.fillText(pctTxt, W - 62, 268);

  // ── the tiles ─────────────────────────────────────────────────────────────
  const tiles = [
    { k: 'INVESTED', v: short(s.ethIn, native), sub: rate > 0 ? usdShort(s.ethIn * rate) : '' },
    { k: s.status === 'holding' ? 'HOLDING NOW' : 'TAKEN OUT', v: short(s.status === 'holding' ? s.value : s.ethOut, native), sub: rate > 0 ? usdShort((s.status === 'holding' ? s.value : s.ethOut) * rate) : '' },
    // The label states WHAT the number is, and it may not contradict its sign:
    // a tile headed PROFIT showing −1.58 is the buy card's two ideas of "whale"
    // in miniature. On a bag still held it also says the money is not banked.
    {
      k: (s.pnl < 0 ? 'LOSS' : 'PROFIT') + (s.status === 'closed' ? '' : ' · OPEN'),
      v: (s.pnl > 0 ? '+' : s.pnl < 0 ? '−' : '') + short(s.pnl, native),
      sub: rate > 0 ? ((s.pnl < 0 ? '−' : '') + usdShort(s.pnl * rate)) : '', accent: true,
    },
  ];
  const tw = (W - 124 - 2 * 22) / 3;
  tiles.forEach((t, i) => {
    const x = 62 + i * (tw + 22), y = 320, h = 132;
    ctx.save();
    K.roundRect(ctx, x, y, tw, h, 20);
    ctx.fillStyle = K.hexA('#FFFFFF', 0.04);
    ctx.fill();
    ctx.strokeStyle = t.accent ? K.hexA(ACC, 0.45) : K.hexA('#FFFFFF', 0.09);
    ctx.lineWidth = t.accent ? 2 : 1;
    ctx.stroke();
    ctx.restore();
    ctx.textAlign = 'left';
    ctx.fillStyle = K.FAINT;
    ctx.font = `700 15px ${K.F.m7}`;
    ctx.fillText(t.k, x + 22, y + 36);
    ctx.fillStyle = t.accent ? ACC : K.INK;
    const vt = K.fitText(ctx, t.v, tw - 44, { weight: 800, size: 38, min: 18, family: K.F.d7 });
    ctx.fillText(vt, x + 22, y + 86);
    if (t.sub) {
      ctx.fillStyle = K.MUTE;
      ctx.font = `600 18px ${K.F.m6}`;
      ctx.fillText(t.sub, x + 22, y + 114);
    }
  });

  // ── the footer: the facts that qualify the headline ───────────────────────
  const foot = [];
  if (p.trades && p.trades.buys) foot.push(`${p.trades.buys} buy${p.trades.buys > 1 ? 's' : ''}`);
  if (p.trades && p.trades.sells) foot.push(`${p.trades.sells} sell${p.trades.sells > 1 ? 's' : ''}`);
  if (p.trades && p.trades.firstAt) foot.push(`held ${pnl.since(Date.now() - p.trades.firstAt)}`);
  if (p.holders && p.holders.length > 1) foot.push(`${p.holders.length} wallets`);
  ctx.textAlign = 'left';
  ctx.fillStyle = K.MUTE;
  ctx.font = `600 20px ${K.F.m6}`;
  ctx.fillText(foot.join('  ·  '), 62, 522);
  if (chainName) {
    ctx.fillStyle = K.FAINT;
    ctx.font = `600 19px ${K.F.m6}`;
    ctx.fillText(`${chainEmoji ? chainEmoji + ' ' : ''}${chainName}`, 62, 556);
  }
  // Entry → now, the two prices the percentage is the ratio of. Only when both
  // are known: half of a ratio is not a fact.
  if (s.entryEth != null && s.priceEth > 0) {
    ctx.textAlign = 'right';
    ctx.fillStyle = K.MUTE;
    ctx.font = `600 20px ${K.F.m6}`;
    ctx.fillText(`entry ${pnl.px(s.entryEth)}  →  now ${pnl.px(s.priceEth)}`, W - 62, 522);
  }
  ctx.textAlign = 'right';
  ctx.fillStyle = K.FAINT;
  ctx.font = `700 19px ${K.F.m7}`;
  ctx.fillText('dexvra.io', W - 62, 556);

  // A hairline in the accent along the foot — the card's only decoration that
  // carries meaning: it is the win/loss colour, repeated.
  const hg = ctx.createLinearGradient(62, 0, W - 62, 0);
  hg.addColorStop(0, K.hexA(ACC, 0));
  hg.addColorStop(0.5, K.hexA(ACC, 0.7));
  hg.addColorStop(1, K.hexA(ACC, 0));
  ctx.fillStyle = hg;
  ctx.fillRect(62, 596, W - 124, 2);

  try { return cv.toBuffer('image/png'); } catch (_) { return null; }
}

module.exports = { render, available, W, H };
