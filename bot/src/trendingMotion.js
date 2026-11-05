/**
 * The TRENDING clip, one design per length of run (DESIGNS, at the bottom):
 * 6H a chronograph, 12H a trophy, 24H the "Blue Flame", 48H a crown. The
 * flame — a 3D flame in satin blue metal with a chrome ring, the token's own
 * logo set into its bulb — is concept A of three (flame · trophy · crown),
 * picked by the operator ("A. Api"); the other three were added when the
 * operator asked for a different design per run length. Like the pump gauge,
 * each look is a decision: change it only with a new approval.
 *
 * What is drawn, and where each figure comes from (postMedia → bannerCoin):
 *   pill        "TRENDING NH" from the post's own badge ("Trending 24H"); a
 *               badge that does not name a trending run reads "TRENDING" —
 *               a listing badge never lands on a trending clip
 *   chain chip  bannerCoin.chain (the chain's label)
 *   ticker      bannerCoin.symbol, spelt with exactly one "$"
 *   name        bannerCoin.name
 *   panel       price · market cap · liquidity, fulfillment.bannerFigures'
 *               own spelling. A figure nobody read ("TBA", null) leaves its
 *               cell OUT; no figure at all leaves the panel out — never "$0"
 *   flame bulb  the token's logo (canvasKit.drawLogoDisc), a monogram of the
 *               ticker when it has none or it cannot be read
 *
 * How it is made (the gauge's recipe, pumpMotion.js):
 *   • the flame is ray-marched ONCE (a signed distance field), cached in memory
 *     and in os.tmpdir(), and the march YIELDS every few rows — a synchronous
 *     march would make the whole bot deaf ("bot tidak bisa merespon");
 *   • every frame re-lights the metal from stored reflection vectors while the
 *     studio swings, so highlights travel over the flame like real metal;
 *   • the flame SWAYS: drawn in thin horizontal strips whose offset grows
 *     toward the tips, so the bulb and its logo never move;
 *   • embers rise round it; on the way back in the flame re-IGNITES — a flash
 *     ring off the logo, a burst of sparks, a lens flare.
 *
 * The 6-second loop: HOLD 0–4.0 (the card, embers rising) → OUT 4.0–4.5 (the
 * flame burns low, the type leaves) → IN 4.5–6.0 (ignition, the type returns
 * masked and blur-to-sharp, the figures decode). Frame 0 IS the full card:
 * Telegram makes the thumbnail and the notification preview from it. The loop
 * is exact — t = 6 draws what t = 0 draws — and a test says so.
 *
 * TRENDING_MOTION=0 switches it off (postMedia continues down its ladder: the
 * admin trending clip, then the still). Blank or unset is ON.
 */
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
const { spawn } = require("node:child_process");
const log = require("./helpers/logger");
const kit = require("./helpers/canvasKit");
const { CHANNELS, SITE_URL, X_LISTING_HANDLE } = require("./config/constants");
const { sourceEnabled } = require("./raid/sourceFlag");

const { F, hexA, roundRect, drawBrandMark, warnBoxes } = kit;

const W = 1280;
const H = 640;
const FPS = 25;
const SECONDS = 6;
const FRAMES = FPS * SECONDS;
const TAU = Math.PI * 2;
const CY = "#22D3EE";
const BLUE = "#2F86FF";
const MINT = "#3DF59F";
const ICE = "#D8FAFF";
/** The smallest type drawn: X autoplays a ~0.4× copy of the clip in its
 *  timeline, and anything under this is unreadable there (listingMotion). */
const LABEL_MIN = 15;

const clamp = (v, a = 0, b = 1) => (v < a ? a : v > b ? b : v);
const mix = (a, b, t) => a + (b - a) * t;
const easeOut = (u) => 1 - Math.pow(1 - u, 3);
const easeIn = (u) => u * u * u;
const easeInOut = (u) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2);
const smooth = (a, b, x) => { const u = clamp((x - a) / (b - a)); return u * u * (3 - 2 * u); };
const easeOutBack = (u) => { const c1 = 1.5, c3 = c1 + 1; return 1 + c3 * Math.pow(u - 1, 3) + c1 * Math.pow(u - 1, 2); };
const len2 = (x, y) => Math.sqrt(x * x + y * y);
const len3 = (x, y, z) => Math.sqrt(x * x + y * y + z * z);
const tracked = (ctx, text, x, y, t) => { for (const ch of [...String(text)]) { ctx.fillText(ch, x, y); x += ctx.measureText(ch).width + t; } };
const trackedW = (ctx, text, t) => { const cs = [...String(text)]; return cs.reduce((a, c) => a + ctx.measureText(c).width, 0) + t * Math.max(0, cs.length - 1); };
const tickerOf = (symbol) => `$${String(symbol || "").replace(/^\$+/, "").toUpperCase()}`;
const hostOf = (url) => String(url || "").replace(/^https?:\/\//, "").replace(/\/.*$/, "");
const rand = (seed) => () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

// ─────────────────────────── the 3D objects ───────────────────────────
const FS = 560; // sprite size
const FSS = 2; // supersampling per axis

const smin = (a, b, k) => { const h = clamp(0.5 + (0.5 * (b - a)) / k); return mix(b, a, h) - k * h * (1 - h); };
/** A rounded 2D box (Quilez). */
function rbox2(px, py, bx, by, r) {
  const qx = Math.abs(px) - bx + r, qy = Math.abs(py) - by + r;
  return Math.min(Math.max(qx, qy), 0) + Math.sqrt(Math.max(qx, 0) ** 2 + Math.max(qy, 0) ** 2) - r;
}
/** A polygon's signed distance (Quilez): negative inside. */
function polySd(px, py, V) {
  let d = (px - V[0][0]) ** 2 + (py - V[0][1]) ** 2, s = 1;
  for (let i = 0, j = V.length - 1; i < V.length; j = i, i++) {
    const ex = V[j][0] - V[i][0], ey = V[j][1] - V[i][1], wx = px - V[i][0], wy = py - V[i][1];
    const h = clamp((wx * ex + wy * ey) / (ex * ex + ey * ey));
    const bx = wx - ex * h, by = wy - ey * h;
    d = Math.min(d, bx * bx + by * by);
    const c1 = py >= V[i][1], c2 = py < V[j][1], c3 = ex * wy > ey * wx;
    if ((c1 && c2 && c3) || (!c1 && !c2 && !c3)) s = -s;
  }
  return s * Math.sqrt(d);
}
/** A 2D outline pushed out into a pillow `t` thick with `rr` rounding. */
function pillow(d2, z, t, rr) {
  const wx = d2 + rr, wy = Math.abs(z) - t + rr;
  return Math.min(Math.max(wx, wy), 0) + len2(Math.max(wx, 0), Math.max(wy, 0)) - rr;
}
// 2D uneven capsule (Quilez): from (0,0) radius r1 up to (0,h) radius r2
function uneven(px, py, r1, r2, h) {
  px = Math.abs(px);
  const b = (r1 - r2) / h, a = Math.sqrt(1 - b * b), k = -b * px + a * py;
  if (k < 0) return len2(px, py) - r1;
  if (k > a * h) return len2(px, py - h) - r2;
  return px * a + py * b - r1;
}
function capsule2(px, py, ax, ay, ar, bx, by, br) {
  const dx = bx - ax, dy = by - ay, h = Math.hypot(dx, dy), c = dy / h, s = dx / h;
  const qx = px - ax, qy = py - ay;
  return uneven(qx * c - qy * s, qx * s + qy * c, ar, br, h);
}
/** A logo medallion facing the camera: a rounded disc, the logo set into a
 *  recess on its face. Material 1 the rim, 3 the logo. */
function medallion(x, y, z, cy, R, L, out) {
  const rm = len2(x, y - cy);
  let d = rbox2(rm, z, R, 0.24, 0.12);
  d = Math.max(d, -Math.max(rm - L, -(z - 0.18)));
  let m = 1;
  const disc = Math.max(rm - L, Math.abs(z - 0.17) - 0.012);
  if (disc < d) { d = disc; m = 3; }
  out.m = m;
  return d;
}

// ── 24H: the flame (the approved "Blue Flame") ──
const FL = { cx: 0, cy: -0.62, r: 0.8 }; // the logo disc in the bulb
/** The flame's outline: a bulb, a tall curling tongue and two side tongues. */
function flame2(x, y) {
  const bend = 0.22 * Math.sin(y * 1.1 + 0.4);
  const xb = x - bend * clamp((y + 0.4) / 1.6);
  let d = len2(x, y + 0.62) - 1.18;
  d = smin(d, capsule2(xb, y, 0, -0.5, 0.98, 0.18, 2.15, 0.035), 0.32);
  d = smin(d, capsule2(x, y, -0.62, -0.2, 0.55, -1.12, 1.05, 0.03), 0.28);
  d = smin(d, capsule2(x, y, 0.66, -0.25, 0.5, 1.08, 0.82, 0.03), 0.28);
  return d;
}
// materials: 6 satin metal (the body), 1 chrome (the ring), 3 the logo
function flameSdf(x, y, z, out) {
  const d2 = flame2(x, y);
  const t = 0.34, rr = 0.3;
  const wx = d2 + rr, wy = Math.abs(z) - t + rr;
  let d = Math.min(Math.max(wx, wy), 0) + len2(Math.max(wx, 0), Math.max(wy, 0)) - rr;
  let m = 6;
  const rl = len2(x - FL.cx, y - FL.cy);
  const zf = 0.32; // the front surface round the bulb's centre
  const rec = Math.max(rl - FL.r, -(z - (zf - 0.06)));
  d = Math.max(d, -rec);
  const disc = Math.max(rl - FL.r, Math.abs(z - (zf - 0.06)) - 0.014);
  if (disc < d) { d = disc; m = 3; }
  const ring = len2(rl - (FL.r + 0.03), z - zf) - 0.065;
  if (ring < d) { d = ring; m = 1; }
  if (out) out.m = m;
  return d;
}

// ── 12H: the trophy — the logo on the cup ──
const TR = { ey: 0.7, ex: 1.25, eyR: 1.45, cut: 1.5, lz: 1.36, lr: 0.68, ly: 0.6 };
function trophySdf(x, y, z, out) {
  const r = len2(x, z);
  // base: plinth + step (material 2: the dark plinth)
  let d = rbox2(r, y + 1.88, 1.42, 0.16, 0.06);
  let m = 2;
  const st = rbox2(r, y + 1.62, 1.02, 0.12, 0.05); if (st < d) { d = st; m = 1; }
  // stem with a knot
  const stem = rbox2(r, y + 1.05, 0.2 + 0.12 * clamp((-y - 0.75) / 0.6), 0.48, 0.05);
  const s2 = smin(stem, len3(x, y + 1.0, z) - 0.3, 0.12);
  if (s2 < d) { d = s2; m = 1; }
  // cup: a hollow ellipsoid cut at the top
  const ex = x / TR.ex, ey = (y - TR.ey) / TR.eyR, ez = z / TR.ex;
  const k = len3(ex, ey, ez), e = (k - 1) * Math.min(TR.ex, TR.eyR);
  let cup = Math.abs(e) - 0.07;
  cup = Math.max(cup, y - TR.cut);
  cup = smin(cup, s2, 0.18);
  if (cup < d) { d = cup; m = 1; }
  const rimR = TR.ex * Math.sqrt(1 - ((TR.cut - TR.ey) / TR.eyR) ** 2);
  const rim = len2(r - rimR, y - TR.cut) - 0.085; if (rim < d) { d = rim; m = 1; }
  for (const sx of [-1, 1]) {
    const hx = sx * x - 1.32, hy = y - 0.78;
    let h = len2(len2(hx, hy) - 0.46, z) - 0.1;
    h = Math.max(h, -(sx * x - 1.05));
    if (h < d) { d = h; m = 1; }
  }
  // the logo's emblem on the front of the cup
  const rl = len2(x, y - TR.ly);
  const em = rbox2(rl, z - TR.lz, TR.lr + 0.06, 0.08, 0.04);
  if (em < d) { d = em; m = 1; }
  const disc = Math.max(rl - TR.lr, Math.abs(z - (TR.lz + 0.08)) - 0.012);
  if (disc < d) { d = disc; m = 3; }
  if (out) out.m = m;
  return d;
}

// ── 48H: the crown — a crown on a logo medallion ──
const CR = { R: 1.0, y0: 0.55, bandH: 0.42, ph: 0.8, N: 5, mr: 1.3, mc: -0.55 };
function crownPoint(u, rr, v, w, h, k, th) {
  const tri = Math.max((Math.abs(u) * h + v * w - w * h) / Math.hypot(h, w), -v);
  const a1 = tri + th, b1 = Math.abs(rr - CR.R) - (th + k * clamp(-tri * (th > 0.028 ? 4 : 5)));
  return len2(Math.max(a1, 0), Math.max(b1, 0)) + Math.min(Math.max(a1, b1), 0) - th;
}
const SCRATCH = { m: 0 }; // the march's hot loop passes no `out`: no allocation per call
function crownSdf(x, y, z, out) {
  const o = out || SCRATCH;
  let d = medallion(x, y, z, CR.mc, CR.mr, CR.mr - 0.2, o);
  let m = o.m;
  // the crown: a ring round the vertical axis, five tall points and five short
  const r = len2(x, z), a = Math.atan2(x, z), sec = TAU / CR.N;
  const as = ((a % sec) + sec * 1.5) % sec - sec / 2;
  const u = r * Math.sin(as), rr = r * Math.cos(as);
  const ym = CR.y0 + CR.bandH / 2, top = CR.y0 + CR.bandH;
  const band = rbox2(r - CR.R, y - ym, 0.075, CR.bandH / 2, 0.05);
  if (band < d) { d = band; m = 1; }
  const v = y - top + 0.06;
  const pt = crownPoint(u, rr, v, 0.42, CR.ph, 0.09, 0.03);
  if (pt < d) { d = pt; m = 1; }
  const ball = len3(u, y - (top + CR.ph + 0.05), rr - CR.R) - 0.13;
  if (ball < d) { d = ball; m = 1; }
  const as3 = ((a % sec) + sec) % sec - sec / 2, u3 = r * Math.sin(as3), rr3 = r * Math.cos(as3);
  const pt2 = crownPoint(u3, rr3, v, 0.3, CR.ph * 0.45, 0.06, 0.025);
  if (pt2 < d) { d = pt2; m = 1; }
  const ball2 = len3(u3, y - (top + CR.ph * 0.45 + 0.02), rr3 - CR.R) - 0.08;
  if (ball2 < d) { d = ball2; m = 1; }
  // gems on the band (material 4)
  const gem = len3(u, y - ym, rr - (CR.R + 0.07)) - 0.12;
  if (gem < d) { d = gem; m = 4; }
  o.m = m;
  return d;
}

// ── 6H: the chronograph — the logo is its dial ──
function seg3(x, y, z, ax, ay, az, bx, by, bz, r) {
  const px = x - ax, py = y - ay, pz = z - az, ex = bx - ax, ey = by - ay, ez = bz - az;
  const h = clamp((px * ex + py * ey + pz * ez) / (ex * ex + ey * ey + ez * ez));
  return len3(px - ex * h, py - ey * h, pz - ez * h) - r;
}
// a polished case, a blue bezel, a sunray dial with a minute track, a crown and a bow
const WT = { cy: -0.45, R: 1.45, dial: 1.17, L: 0.84, zf: 0.3, zd: 0.12, slope: 0.09 };
function watchSdf(x, y, z, out) {
  const o = out || SCRATCH;
  const yy = y - WT.cy, rm = len2(x, yy), a = Math.atan2(x, yy);
  // the case: a thick rounded puck in polished steel, its dial dished in — the
  // dial (material 2) is the blue metal, deep where it faces the camera
  // The dial falls away gently toward its rim: a shallow cone, so its light
  // turns with the studio — the sheen of a sunray dial.
  const floor = (r) => WT.zd - WT.slope * clamp((r - WT.L) / (WT.dial - WT.L));
  const fz = floor(rm);
  let d = rbox2(rm, z, WT.R, WT.zf, 0.25);
  d = Math.max(d, -Math.max(rm - WT.dial, -(z - fz)));
  let m = rm < WT.dial - 0.02 && z < fz + 0.03 ? 2 : 1;
  // a blue anodised bezel round the dial
  const bez = len2(rm - (WT.dial + 0.12), z - (WT.zf - 0.01)) - 0.125;
  if (bez < d) { d = bez; m = 2; }
  // the minute track: sixty marks, every fifth a bold index, the quarters bolder
  const sec = TAU / 60;
  const as = ((a % sec) + sec * 1.5) % sec - sec / 2;
  const k = ((Math.round(a / sec) % 60) + 60) % 60;
  const u = rm * Math.sin(as), rr = rm * Math.cos(as);
  // (twelve o'clock carries the Dexvra gem, drawn over the dial — no index)
  const tick = k % 5 !== 0 || k === 0
    ? Math.max(rbox2(u, rr - 1.09, 0.013, 0.035, 0.006), Math.abs(z - (floor(1.09) + 0.016)) - 0.016)
    : Math.max(rbox2(u, rr - 1.02, k % 15 === 0 ? 0.05 : 0.032, 0.1, 0.015), Math.abs(z - (floor(1.02) + 0.035)) - 0.035);
  if (tick < d) { d = tick; m = 1; }
  // the logo, ringed
  const lring = len2(rm - (WT.L + 0.035), z - (WT.zd + 0.03)) - 0.035;
  if (lring < d) { d = lring; m = 1; }
  const disc = Math.max(rm - WT.L, Math.abs(z - (WT.zd + 0.012)) - 0.012);
  if (disc < d) { d = disc; m = 3; }
  // the crown: a stem, a knurled knob, a bow
  const rc = len2(x, z), ac = Math.atan2(x, z);
  const stem = rbox2(rc, yy - (WT.R + 0.12), 0.12, 0.2, 0.03);
  if (stem < d) { d = stem; m = 1; }
  const knob = rbox2(rc + 0.016 * Math.cos(24 * ac), yy - (WT.R + 0.38), 0.27, 0.12, 0.05);
  if (knob < d) { d = knob; m = 1; }
  const bow = len2(len2(x, yy - (WT.R + 0.86)) - 0.34, z) - 0.075;
  if (bow < d) { d = bow; m = 1; }
  // two pushers, at ten and two, their caps knurled
  for (const sgn of [-1, 1]) {
    const sa = Math.sin(sgn * 0.72), ca = Math.cos(0.72);
    const st = seg3(x, yy, z, sa * (WT.R - 0.1), ca * (WT.R - 0.1), 0, sa * (WT.R + 0.22), ca * (WT.R + 0.22), 0, 0.085);
    if (st < d) { d = st; m = 1; }
    // the cap, in its own frame: along the pusher's axis
    const px = x - sa * (WT.R + 0.29), py = yy - ca * (WT.R + 0.29);
    const along = px * sa + py * ca, across = len2(-px * ca + py * sa, z);
    const cap = rbox2(across + 0.01 * Math.cos(16 * Math.atan2(z, -px * ca + py * sa)), along, 0.15, 0.08, 0.035);
    if (cap < d) { d = cap; m = 1; }
  }
  o.m = m;
  return d;
}
/** The rotation that turns a model a little toward the copy (right). */
function rotator(rx, ry, rz) {
  const cX = Math.cos(rx), sX = Math.sin(rx), cYr = Math.cos(ry), sYr = Math.sin(ry), cZ = Math.cos(rz), sZ = Math.sin(rz);
  return (x, y, z) => {
    const x1 = cZ * x + sZ * y, y1 = -sZ * x + cZ * y, z1 = z;
    const x2 = cYr * x1 - sYr * z1, z2 = sYr * x1 + cYr * z1, y2 = y1;
    const y3 = cX * y2 + sX * z2, z3 = -sX * y2 + cX * z2;
    return [x2, y3, z3];
  };
}
const CAM = 24;

/** A design's object, posed: the SDF in world space and the way back to its
 *  own coordinates (the logo's uv is read in those). */
function posed(D) {
  const toLocal = rotator(...D.rot);
  const sdfW = (x, y, z, out) => { const p = toLocal(x, y, z); return D.sdf(p[0], p[1], p[2], out); };
  return { toLocal, sdfW };
}
/** A point in the object's own coordinates → where the march drew it in the
 *  sprite (px, py) and how near the camera it is (wz). The rotation is
 *  orthonormal, so the way back is its transpose. */
function projector(D) {
  const tl = rotator(...D.rot);
  const c0 = tl(1, 0, 0), c1 = tl(0, 1, 0), c2 = tl(0, 0, 1);
  return (x, y, z) => {
    const wx = c0[0] * x + c0[1] * y + c0[2] * z, wy = c1[0] * x + c1[1] * y + c1[2] * z, wz = c2[0] * x + c2[1] * y + c2[2] * z;
    const k = CAM / (D.view * (CAM - wz));
    return [((wx * k + 1) / 2) * FS, ((1 - wy * k) / 2) * FS, wz];
  };
}
function normal(sdfW, x, y, z) {
  const e = 0.0015;
  const a = sdfW(x + e, y - e, z - e), b = sdfW(x - e, y - e, z + e), c = sdfW(x - e, y + e, z - e), d = sdfW(x + e, y + e, z + e);
  const nx = a - b - c + d, ny = -a - b + c + d, nz = -a + b - c + d, l = len3(nx, ny, nz) || 1;
  return [nx / l, ny / l, nz / l];
}
function occlusion(sdfW, x, y, z, n) {
  let o = 0, w = 1;
  for (let i = 1; i <= 5; i++) { const h = 0.05 * i; o += w * (h - sdfW(x + n[0] * h, y + n[1] * h, z + n[2] * h)); w *= 0.6; }
  return clamp(1 - 2.5 * o);
}
/** The studio the metal reflects: a softbox overhead, a coloured kicker on the
 *  right (S.side), a fill on the left (S.left), a hard little sun and a thin
 *  strip light. The kickers are the design's: a cyan kicker on gold reads green. */
function env(rx, ry, rz, out, S) {
  let r = 0.01, g = 0.015, b = 0.03;
  const top = clamp((ry - 0.56) / 0.16) * clamp((0.95 - ry) / 0.1);
  r += 1.8 * top; g += 1.9 * top; b += 2.05 * top;
  const side = clamp((rx - 0.6) / 0.12) * clamp(1 - Math.abs(ry - 0.05) / 0.5); r += S.side[0] * side; g += S.side[1] * side; b += S.side[2] * side;
  const left = clamp((-rx - 0.55) / 0.15) * clamp(1 - Math.abs(ry - 0.2) / 0.5); r += S.left[0] * left; g += S.left[1] * left; b += S.left[2] * left;
  const fl = clamp((-ry - 0.3) / 0.5); r += 0.02 * fl; g += 0.07 * fl; b += 0.15 * fl;
  const sd = rx * -0.42 + ry * 0.62 + rz * 0.66;
  if (sd > 0.97) { const sun = Math.pow(sd, 260) * 6; r += sun; g += sun; b += sun; }
  const strip = clamp((rx - 0.27) / 0.025) * clamp((0.31 - rx) / 0.025) * clamp((ry - 0.05) / 0.3);
  r += 0.7 * strip; g += 0.8 * strip; b += 0.9 * strip;
  out[0] = r; out[1] = g; out[2] = b;
  return out;
}
const nrm = (v) => { const l = len3(...v); return v.map((c) => c / l); };
const L1 = nrm([-0.5, 0.8, 0.6]), L2 = nrm([0.85, 0.1, -0.2]);
function tone(c) {
  c *= 1.1;
  const a = (c * (2.51 * c + 0.03)) / (c * (2.43 * c + 0.59) + 0.14);
  return clamp(Math.pow(clamp(a), 1 / 2.2));
}
// the per-frame re-light tones ~150k samples a frame: a table, not a pow
const TONE_N = 4096, TONE_MAX = 16;
const TONE_LUT = (() => { const t = new Float32Array(TONE_N + 1); for (let i = 0; i <= TONE_N; i++) t[i] = tone((i / TONE_N) * TONE_MAX); return t; })();
const toneFast = (c) => TONE_LUT[c <= 0 ? 0 : c >= TONE_MAX ? TONE_N : ((c * (TONE_N / TONE_MAX)) | 0)];

// per metal sample: R (3), occ, ndv, the fixed lamps' specular (3), count —
// two metals a design (D.q maps a material to 0 or 1; 3 is always the logo)
const MS = 9;

/** March a design's object. Async: it yields every few rows so the bot keeps answering. */
async function marchBody(D) {
  const { toLocal, sdfW } = posed(D);
  const N = FS * FSS, VIEW = D.view, LG = D.logo;
  const metal = new Float32Array(FS * FS * 2 * MS);
  const lA = new Float32Array(FS * FS * 5);
  const hit = { m: 0 }, ev = [0, 0, 0];
  for (let j = 0; j < N; j++) {
    if (j % 12 === 0) await new Promise((r) => setImmediate(r));
    for (let i = 0; i < N; i++) {
      const sx = ((i + 0.5) / N) * 2 - 1, sy = 1 - ((j + 0.5) / N) * 2;
      let dx = sx * VIEW, dy = sy * VIEW, dz = -CAM;
      const dl = len3(dx, dy, dz); dx /= dl; dy /= dl; dz /= dl;
      let t = CAM - 8, ok = false, px = 0, py = 0, pz = 0;
      for (let k = 0; k < 160; k++) {
        px = dx * t; py = dy * t; pz = CAM + dz * t;
        const d = sdfW(px, py, pz, null);
        if (d < 0.0006 * t) { ok = true; break; }
        t += d * 0.85;
        if (t > CAM + 10) break;
      }
      if (!ok) continue;
      const oi = Math.floor(j / FSS) * FS + Math.floor(i / FSS);
      sdfW(px, py, pz, hit);
      const m = hit.m;
      const n = normal(sdfW, px, py, pz), occ = occlusion(sdfW, px, py, pz, n);
      const vx = -dx, vy = -dy, vz = -dz;
      const ndv = clamp(n[0] * vx + n[1] * vy + n[2] * vz);
      const kk = 2 * (n[0] * dx + n[1] * dy + n[2] * dz);
      const R = [dx - kk * n[0], dy - kk * n[1], dz - kk * n[2]];
      const sp = (L) => { const hx = L[0] + vx, hy = L[1] + vy, hz = L[2] + vz, hl = len3(hx, hy, hz) || 1; return clamp((n[0] * hx + n[1] * hy + n[2] * hz) / hl); };
      if (m === 3) {
        const p = toLocal(px, py, pz);
        const d1 = clamp(n[0] * L1[0] + n[1] * L1[1] + n[2] * L1[2]), d2 = clamp(n[0] * L2[0] + n[1] * L2[1] + n[2] * L2[2]);
        const fres = 0.04 + 0.96 * Math.pow(1 - ndv, 5);
        env(R[0], R[1], R[2], ev, D.studio);
        lA[oi * 5] += ((p[0] - LG.cx) / LG.r) * 0.5 + 0.5;
        lA[oi * 5 + 1] += 0.5 - ((p[1] - LG.cy) / LG.r) * 0.5;
        lA[oi * 5 + 2] += 1;
        lA[oi * 5 + 3] += Math.min(1.25, 0.35 + occ * (0.55 + 0.6 * d1 + 0.15 * d2) * 1.15);
        lA[oi * 5 + 4] += (1.1 * Math.pow(sp(L1), 120) + ev[1] * fres * 0.8) * 0.55;
        continue;
      }
      const q = D.q(m), rough = D.mats[q].rough;
      const p1 = Math.pow(sp(L1), mix(240, 30, rough)), p2 = Math.pow(sp(L2), mix(150, 20, rough));
      const o = (oi * 2 + q) * MS;
      metal[o] += R[0]; metal[o + 1] += R[1]; metal[o + 2] += R[2];
      metal[o + 3] += occ; metal[o + 4] += ndv;
      metal[o + 5] += 0.5 * p1 + 0.1 * p2; metal[o + 6] += 0.5 * p1 + 0.35 * p2; metal[o + 7] += 0.55 * p1 + 0.45 * p2;
      metal[o + 8] += 1;
    }
  }
  // the logo's 7 bytes a pixel: u, v as 16-bit, coverage, light, coat
  const n2 = FSS * FSS;
  const logo = Buffer.alloc(FS * FS * 7);
  for (let p = 0; p < FS * FS; p++) {
    const w = lA[p * 5 + 2]; if (!w) continue;
    logo.writeUInt16LE(Math.round(clamp(lA[p * 5] / w) * 65535), p * 7);
    logo.writeUInt16LE(Math.round(clamp(lA[p * 5 + 1] / w) * 65535), p * 7 + 2);
    logo[p * 7 + 4] = Math.round((w / n2) * 255);
    logo[p * 7 + 5] = Math.round(clamp(lA[p * 5 + 3] / w / 1.4) * 255);
    logo[p * 7 + 6] = Math.round(clamp(lA[p * 5 + 4] / w) * 255);
  }
  return { metal, logo };
}

const CACHE_MAGIC = "DXTF";
/** One cache file per design and version: `dexvra-trendflame-v1-560x2.bin`. */
const cacheFile = (key = "flame") => {
  const D = DESIGNS[key] || DESIGNS.flame;
  return path.join(os.tmpdir(), `dexvra-trend${D.key}-v${D.version}-${FS}x${FSS}.bin`);
};
const serialise = (g) => Buffer.concat([Buffer.from(CACHE_MAGIC), Buffer.from(g.metal.buffer), g.logo]);
function deserialise(b) {
  const nMetal = FS * FS * 2 * MS * 4, nLogo = FS * FS * 7;
  if (b.length !== 4 + nMetal + nLogo || b.toString("latin1", 0, 4) !== CACHE_MAGIC) return null;
  const metal = new Float32Array(b.buffer.slice(b.byteOffset + 4, b.byteOffset + 4 + nMetal));
  return { metal, logo: Buffer.from(b.subarray(4 + nMetal)) };
}
/** The prepared object, for the per-frame passes:
 *   metalPx/mets  every pixel the metal touches, per kind the reflection vector
 *                 with the material's constants folded in (only the studio
 *                 swings, so only env() is per frame);
 *   logoL         every pixel the logo touches: uv, coverage, light, coat;
 *   bulb          where the logo sits in the sprite (the flame's sway leaves it
 *                 be; every design's effects start from it). */
function prepare(g, D) {
  const { metal } = g;
  const metalPx = [], mets = [];
  for (let p = 0; p < FS * FS; p++) {
    const c0 = metal[(p * 2) * MS + 8], c1 = metal[(p * 2 + 1) * MS + 8];
    if (!(c0 + c1)) continue;
    metalPx.push(p);
    for (let q = 0; q < 2; q++) {
      const o = (p * 2 + q) * MS, cnt = metal[o + 8];
      if (!cnt) { mets.push(0, 0, 0, 0, 0, 0, 0, 0, 0, 0); continue; }
      let rx = metal[o] / cnt, ry = metal[o + 1] / cnt, rz = metal[o + 2] / cnt;
      const rl = Math.hypot(rx, ry, rz) || 1; rx /= rl; ry /= rl; rz /= rl;
      const occ = metal[o + 3] / cnt, ndv = metal[o + 4] / cnt;
      const fres = 0.04 + 0.96 * Math.pow(1 - ndv, 5);
      const { c: mat, rough } = D.mats[q];
      const refl = (0.95 * (1 - rough * 0.6) + fres * 0.5);
      const rim = Math.pow(1 - ndv, 3) * 0.36;
      const k = [0, 1, 2].map((c) => refl * mat[c] * occ);
      const ad = [0, 1, 2].map((c) => D.rim[c] * rim + metal[o + 5 + c] / cnt);
      mets.push(rx, ry, rz, k[0], k[1], k[2], ad[0], ad[1], ad[2], cnt);
    }
  }
  const logoL = [];
  let sx = 0, sy = 0, sn = 0, top = FS;
  for (let p = 0; p < FS * FS; p++) {
    const cov = g.logo[p * 7 + 4]; if (!cov) continue;
    logoL.push(p, g.logo.readUInt16LE(p * 7) / 65535, g.logo.readUInt16LE(p * 7 + 2) / 65535, cov / 255,
      Math.min(1.25, (g.logo[p * 7 + 5] / 255) * 1.4), g.logo[p * 7 + 6] / 255);
    const x = p % FS, y = (p / FS) | 0;
    sx += x; sy += y; sn++; if (y < top) top = y;
  }
  const bulb = sn ? { x: sx / sn, y: sy / sn, top, r: Math.sqrt(sn / Math.PI) } : { x: FS / 2, y: FS * 0.62, top: FS * 0.45, r: FS * 0.15 };
  // how far the object reaches up and down the sprite (the spotlights land on
  // its foot, the crown's sunburst rises from its top)
  const yTop = metalPx.length ? (metalPx[0] / FS) | 0 : 0, yBot = metalPx.length ? (metalPx[metalPx.length - 1] / FS) | 0 : FS - 1;
  return { metalPx: Int32Array.from(metalPx), mets: Float32Array.from(mets), logoL: Float32Array.from(logoL), bulb, yTop, yBot };
}
const bodies = new Map();
/** A design's object, prepared: from memory, else the tmp cache, else a fresh
 *  march (once per design per box, then cached on disk). */
function bodyFor(key = "flame") {
  const D = DESIGNS[key] || DESIGNS.flame;
  if (!bodies.has(D.key)) {
    const p = (async () => {
      const file = cacheFile(D.key);
      let g = null;
      try { g = deserialise(await fss.promises.readFile(file)); } catch { g = null; }
      if (!g) {
        const t0 = Date.now();
        g = await marchBody(D);
        log.info(`[trendingMotion] ${D.key} ray-marched in ${Date.now() - t0}ms`);
        const tmp = `${file}.${process.pid}.tmp`;
        fss.promises.writeFile(tmp, serialise(g)).then(() => fss.promises.rename(tmp, file)).catch(() => fss.promises.unlink(tmp).catch(() => {}));
      }
      return prepare(g, D);
    })().catch((e) => { bodies.delete(D.key); throw e; });
    bodies.set(D.key, p);
  }
  return bodies.get(D.key);
}

/** The logo texture for the bulb. The bulb shows the circle inscribed in it;
 *  canvasKit owns the rule — a wide logo whole, a dark logo on a clear
 *  background visible. No logo (or one that cannot be read): a monogram. */
function logoTexture(cv, img, symbol) {
  const LT = 256, c = cv.createCanvas(LT, LT), x = c.getContext("2d");
  if (img) {
    kit.drawLogoDisc(x, img, LT / 2, LT / 2, LT / 2, { backdrop: "#0A2340" });
  } else {
    const g = x.createRadialGradient(LT / 2, LT * 0.4, 10, LT / 2, LT / 2, LT / 2);
    g.addColorStop(0, "#1E5A8C"); g.addColorStop(1, "#0A2340");
    x.fillStyle = g; x.fillRect(0, 0, LT, LT);
    const mono = [...String(symbol || "").replace(/^\$+/, "").toUpperCase()].slice(0, 2).join("") || "?";
    x.font = `800 ${mono.length > 1 ? 104 : 128}px ${F.x}`; x.textAlign = "center"; x.textBaseline = "middle";
    x.fillStyle = "#EAF8FF"; x.fillText(mono, LT / 2, LT / 2 + 6);
  }
  return x.getImageData(0, 0, LT, LT).data;
}

// ─────────────────────────── the timeline ───────────────────────────
const HOLD = 4.0;
const OUTE = 4.5;
const IN0 = 4.5;
const IGN = IN0 + 0.05; // the flame re-ignites
const at = (t, a, d) => clamp((t - (IN0 + a)) / d);
/** How big the flame is (it burns low on the way out, re-ignites with an overshoot). */
function flameScale(t) {
  if (t < HOLD) return 1 + 0.012 * Math.sin((TAU * t) / HOLD);
  if (t < OUTE) return 1 - 0.1 * easeIn((t - HOLD) / (OUTE - HOLD));
  return 0.9 + 0.1 * easeOutBack(clamp((t - IGN) / 0.7));
}
/** How dark it is: dimmed as it burns low, back to full at ignition. */
function flameDim(t) {
  if (t < HOLD) return 0;
  if (t < OUTE) return 0.5 * easeIn((t - HOLD) / (OUTE - HOLD));
  return 0.5 * (1 - easeOut(clamp((t - IGN) / 0.35)));
}
/** The ignition's afterglow: 0 until it fires, EXACTLY 0 again before the wrap. */
const boostAt = (t) => (t >= IGN ? Math.exp(-(t - IGN) * 2.6) * (1 - smooth(5.55, 5.95, t)) : 0);
/** Every ambient motion completes whole periods a loop, so the seam is exact. */
const flicker = (t) => 0.5 + 0.3 * Math.sin((TAU * 5 * t) / SECONDS) + 0.2 * Math.sin((TAU * 11 * t) / SECONDS + 1.3);
const envYaw = (t) => 0.13 * Math.sin((TAU * t) / SECONDS) + 0.35 * boostAt(t);
function camera(t) {
  return { s: 1 + 0.01 * Math.sin((TAU * t) / SECONDS), dx: 6 * Math.sin((TAU * t) / SECONDS), dy: 3 * Math.sin((TAU * 2 * t) / SECONDS) };
}
function reveal(t, a, d) {
  if (t < HOLD) return 1;
  if (t < OUTE) return 1 - easeIn((t - HOLD) / (OUTE - HOLD));
  return easeOut(at(t, a, d));
}

// ─────────────────────────── the scene ───────────────────────────
const OX = 50; // the object sprite's place
const OY = 40;
const OC = { x: OX + FS / 2, y: OY + FS / 2 };
const EMBERS = (() => {
  const r = rand(11);
  return Array.from({ length: 64 }, () => ({
    x: OC.x + (r() - 0.5) * 470, y0: OY + FS * 0.82 + r() * 90, rise: 360 + r() * 260, cyc: 1 + Math.floor(r() * 2), ph: r(),
    sway: 10 + r() * 22, s: 1.1 + r() * 2.2, br: 0.35 + r() * 0.65, mint: r() < 0.25, tail: 12 + r() * 24,
  }));
})();
const SPARKS = (() => {
  const r = rand(29);
  return Array.from({ length: 70 }, () => ({ a: -Math.PI / 2 + (r() - 0.5) * 2.6, v: 180 + r() * 340, d: r() * 0.25, life: 0.55 + r() * 0.4, mint: r() < 0.3, w: 0.8 + r() * 1.6 }));
})();
const MIDBOK = (() => { const r = rand(7); return Array.from({ length: 12 }, () => ({ x: r() * 640, y: r() * H, s: 30 + r() * 60, a: 0.05 + r() * 0.08, ph: r(), k: 1 + Math.floor(r() * 2) })); })();
const FGBOK = [[120, 560, 120, 0.1, 0.0], [560, 600, 80, 0.07, 0.35], [40, 120, 90, 0.08, 0.6], [470, 50, 70, 0.06, 0.8]];

function baseLayer(cv, P) {
  const c = cv.createCanvas(W + 160, H + 80), x = c.getContext("2d");
  const g = x.createRadialGradient(OC.x + 80, OC.y + 40, 20, OC.x + 200, OC.y + 40, 1040);
  g.addColorStop(0, P.base[0]); g.addColorStop(0.28, P.base[1]); g.addColorStop(0.62, P.base[2]); g.addColorStop(1, P.base[3]);
  x.fillStyle = g; x.fillRect(0, 0, W + 160, H + 80);
  return c;
}
/** The flame's own light on the room: a heat glow behind it that breathes. */
function drawBacklight(ctx, t, boost, G, P) {
  ctx.save(); ctx.globalCompositeOperation = "lighter";
  const k = 0.85 + 0.15 * flicker(t) + 0.8 * boost;
  const hg = ctx.createRadialGradient(OC.x, OC.y + 30, 10, OC.x, OC.y - 40, 380);
  hg.addColorStop(0, hexA(P.accent, 0.3 * k)); hg.addColorStop(0.5, hexA(P.accent2, 0.11 * k)); hg.addColorStop(1, hexA(P.accent2, 0));
  ctx.fillStyle = hg; ctx.fillRect(OC.x - 400, OC.y - 440, 800, 880);
  // a soft column of heat rising off the tips
  const cg = ctx.createLinearGradient(0, OY - 40, 0, OC.y);
  cg.addColorStop(0, hexA(P.accent, 0)); cg.addColorStop(1, hexA(P.accent, 0.08 * k));
  ctx.fillStyle = cg; ctx.beginPath(); ctx.ellipse(OC.x + 10, OC.y - 120, 130, 300, 0, 0, TAU); ctx.fill();
  ctx.restore();
}
function drawEmbers(ctx, t) {
  ctx.save(); ctx.globalCompositeOperation = "lighter"; ctx.lineCap = "round";
  for (const e of EMBERS) {
    // each ember completes whole climbs a loop
    const ph = (e.ph + (e.cyc * t) / SECONDS) % 1;
    const y = e.y0 - e.rise * ph;
    const x = e.x + e.sway * Math.sin(TAU * (ph * 1.5 + e.ph));
    // away from the copy column, alive in the middle of its climb
    const a = e.br * Math.sin(Math.PI * ph) * clamp((660 - x) / 90);
    if (a <= 0.01) continue;
    const col = e.mint ? "61,245,159" : "170,235,255";
    const yb = y + e.tail, xb = x - e.sway * 0.25 * Math.cos(TAU * (ph * 1.5 + e.ph));
    const g = ctx.createLinearGradient(xb, yb, x, y);
    g.addColorStop(0, `rgba(${col},0)`); g.addColorStop(1, `rgba(${col},${a * 0.45})`);
    ctx.strokeStyle = g; ctx.lineWidth = e.s * 0.8;
    ctx.beginPath(); ctx.moveTo(xb, yb); ctx.lineTo(x, y); ctx.stroke();
    const sg = ctx.createRadialGradient(x, y, 0, x, y, e.s * 5);
    sg.addColorStop(0, `rgba(${col},${a * 0.6})`); sg.addColorStop(1, `rgba(${col},0)`);
    ctx.fillStyle = sg; ctx.fillRect(x - e.s * 5, y - e.s * 5, e.s * 10, e.s * 10);
    ctx.fillStyle = `rgba(235,252,255,${a})`; ctx.beginPath(); ctx.arc(x, y, e.s, 0, TAU); ctx.fill();
  }
  ctx.restore();
}
function softSprite(cv, blur, rgb) {
  const c = cv.createCanvas(160, 160), x = c.getContext("2d");
  x.filter = `blur(${blur}px)`; x.fillStyle = `rgba(${rgb},1)`; x.beginPath(); x.arc(80, 80, 48, 0, TAU); x.fill(); x.filter = "none";
  return c;
}
function shadeLayer(cv) {
  const c = cv.createCanvas(W, H), x = c.getContext("2d");
  const g = x.createLinearGradient(560, 0, W, 0);
  g.addColorStop(0, "rgba(1,5,12,0)"); g.addColorStop(0.35, "rgba(1,5,12,0.55)"); g.addColorStop(1, "rgba(1,5,12,0.8)");
  x.fillStyle = g; x.fillRect(560, 0, W - 560, H);
  const v = x.createRadialGradient(W / 2, H / 2, 300, W / 2, H / 2, 820);
  v.addColorStop(0, "rgba(0,0,0,0)"); v.addColorStop(1, "rgba(0,0,0,0.45)");
  x.fillStyle = v; x.fillRect(0, 0, W, H);
  return c;
}
function footerIcon(ctx, kind, x, y, s) {
  ctx.save();
  ctx.strokeStyle = hexA(ICE, 0.75); ctx.lineWidth = 1.6; ctx.lineJoin = "round";
  if (kind === "web") {
    ctx.beginPath(); ctx.arc(x, y, s, 0, TAU); ctx.stroke();
    ctx.beginPath(); ctx.ellipse(x, y, s * 0.45, s, 0, 0, TAU); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x - s, y); ctx.lineTo(x + s, y); ctx.stroke();
  } else if (kind === "tg") {
    ctx.beginPath(); ctx.moveTo(x - s, y - s * 0.1); ctx.lineTo(x + s, y - s * 0.85); ctx.lineTo(x + s * 0.55, y + s * 0.9); ctx.lineTo(x - s * 0.15, y + s * 0.3); ctx.closePath(); ctx.stroke();
  } else {
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(x - s * 0.8, y - s * 0.85); ctx.lineTo(x + s * 0.8, y + s * 0.85); ctx.moveTo(x + s * 0.8, y - s * 0.85); ctx.lineTo(x - s * 0.8, y + s * 0.85); ctx.stroke();
  }
  ctx.restore();
}
/** A small flame for the pill: the clip's subject, in the pill's own voice. */
function flameIcon(ctx, x, y, s, col) {
  ctx.save(); ctx.fillStyle = col; ctx.beginPath();
  ctx.moveTo(x + s * 0.05, y - s * 1.05);
  ctx.bezierCurveTo(x + s * 0.55, y - s * 0.55, x + s * 0.85, y - s * 0.05, x + s * 0.72, y + s * 0.42);
  ctx.bezierCurveTo(x + s * 0.6, y + s * 0.9, x - s * 0.6, y + s * 0.92, x - s * 0.74, y + s * 0.4);
  ctx.bezierCurveTo(x - s * 0.84, y + s * 0.02, x - s * 0.62, y - s * 0.3, x - s * 0.42, y - s * 0.52);
  ctx.bezierCurveTo(x - s * 0.38, y - s * 0.22, x - s * 0.26, y - s * 0.06, x - s * 0.14, y - s * 0.02);
  ctx.bezierCurveTo(x - s * 0.24, y - s * 0.45, x - s * 0.12, y - s * 0.8, x + s * 0.05, y - s * 1.05);
  ctx.fill();
  ctx.globalCompositeOperation = "destination-out"; ctx.beginPath();
  ctx.moveTo(x + s * 0.02, y - s * 0.12); ctx.bezierCurveTo(x + s * 0.34, y + s * 0.12, x + s * 0.36, y + s * 0.62, x, y + s * 0.62);
  ctx.bezierCurveTo(x - s * 0.36, y + s * 0.62, x - s * 0.34, y + s * 0.2, x + s * 0.02, y - s * 0.12); ctx.fill();
  ctx.restore();
}
/** The trophy for the pill. */
function trophyIcon(ctx, x, y, s, col) {
  ctx.save(); ctx.fillStyle = col; ctx.strokeStyle = col;
  ctx.beginPath(); ctx.moveTo(x - 0.62 * s, y - 0.92 * s); ctx.lineTo(x + 0.62 * s, y - 0.92 * s);
  ctx.quadraticCurveTo(x + 0.62 * s, y + 0.2 * s, x, y + 0.24 * s); ctx.quadraticCurveTo(x - 0.62 * s, y + 0.2 * s, x - 0.62 * s, y - 0.92 * s); ctx.fill();
  ctx.fillRect(x - 0.12 * s, y + 0.18 * s, 0.24 * s, 0.46 * s);
  roundRect(ctx, x - 0.52 * s, y + 0.62 * s, 1.04 * s, 0.3 * s, 0.08 * s); ctx.fill();
  ctx.lineWidth = 0.17 * s;
  for (const sx of [-1, 1]) { ctx.beginPath(); ctx.arc(x + sx * 0.6 * s, y - 0.48 * s, 0.3 * s, sx < 0 ? Math.PI / 2 : -Math.PI / 2, sx < 0 ? Math.PI * 1.5 : Math.PI / 2); ctx.stroke(); }
  ctx.restore();
}
/** The crown for the pill. */
function crownIcon(ctx, x, y, s, col) {
  ctx.save(); ctx.fillStyle = col; ctx.beginPath();
  const P = [[-0.95, 0.55], [-0.95, -0.5], [-0.46, 0.02], [0, -0.82], [0.46, 0.02], [0.95, -0.5], [0.95, 0.55]];
  P.forEach(([px, py], i) => (i ? ctx.lineTo(x + px * s, y + py * s) : ctx.moveTo(x + px * s, y + py * s)));
  ctx.closePath(); ctx.fill();
  roundRect(ctx, x - 0.95 * s, y + 0.66 * s, 1.9 * s, 0.26 * s, 0.08 * s); ctx.fill();
  for (const [px, py] of [[-0.95, -0.62], [0, -0.96], [0.95, -0.62]]) { ctx.beginPath(); ctx.arc(x + px * s, y + py * s, 0.15 * s, 0, TAU); ctx.fill(); }
  ctx.restore();
}

/** A soft halo behind the object that breathes (every design but the flame,
 *  whose heat glow is drawBacklight). */
function drawHalo(ctx, t, boost, G, P) {
  ctx.save(); ctx.globalCompositeOperation = "lighter";
  const k = 0.9 + 0.1 * Math.sin((TAU * 2 * t) / SECONDS) + 0.8 * boost;
  const hg = ctx.createRadialGradient(G.bulbX, G.bulbY - 30, 10, G.bulbX, G.bulbY - 60, 400);
  hg.addColorStop(0, hexA(P.accent, 0.26 * k)); hg.addColorStop(0.5, hexA(P.accent2, 0.1 * k)); hg.addColorStop(1, hexA(P.accent2, 0));
  ctx.fillStyle = hg; ctx.fillRect(G.bulbX - 420, G.bulbY - 480, 840, 900);
  ctx.restore();
}

// ── 12H: spotlights, a pool of light, twinkling stars, confetti ──
const TWINKLES = (() => {
  const r = rand(61);
  return Array.from({ length: 26 }, () => ({ x: 30 + r() * 600, y: 30 + r() * 570, s: 6 + r() * 10, cyc: 1 + Math.floor(r() * 3), ph: r() }));
})();
function sparkle(ctx, x, y, s, a, P) {
  const g = ctx.createRadialGradient(x, y, 0, x, y, s * 2.2);
  g.addColorStop(0, hexA(P.accent, 0.55 * a)); g.addColorStop(1, hexA(P.accent, 0));
  ctx.fillStyle = g; ctx.fillRect(x - s * 2.2, y - s * 2.2, s * 4.4, s * 4.4);
  ctx.fillStyle = `rgba(255,255,255,${a})`;
  ctx.beginPath(); ctx.ellipse(x, y, s, s * 0.09 + 0.6, 0, 0, TAU); ctx.fill();
  ctx.beginPath(); ctx.ellipse(x, y, s * 0.09 + 0.6, s, 0, 0, TAU); ctx.fill();
}
function drawTwinkles(ctx, t, G, P) {
  ctx.save(); ctx.globalCompositeOperation = "lighter";
  for (const s of TWINKLES) {
    const v = Math.sin(TAU * (s.ph + (s.cyc * t) / SECONDS)); // whole periods a loop
    if (v <= 0) continue;
    const a = Math.pow(v, 3) * clamp((640 - s.x) / 80);
    if (a < 0.02) continue;
    sparkle(ctx, s.x, s.y, s.s * (0.6 + 0.4 * v), a, P);
  }
  ctx.restore();
}
function drawSpots(ctx, t, boost, G, P) {
  drawHalo(ctx, t, boost, G, P);
  ctx.save(); ctx.globalCompositeOperation = "lighter";
  for (const side of [-1, 1]) {
    const ax = G.cx + side * 250, ay = -90;
    const sw = Math.sin((TAU * t) / SECONDS + (side > 0 ? 1.4 : 0)); // a slow sweep, one a loop
    const tx = G.bulbX + side * 20 + 60 * sw, ty = G.bottomY + 40;
    const ang = Math.atan2(ty - ay, tx - ax), len = Math.hypot(tx - ax, ty - ay) * 1.15, hw = 0.17;
    const k = 0.85 + 0.15 * sw + 0.9 * boost;
    const g = ctx.createLinearGradient(ax, ay, ax + Math.cos(ang) * len, ay + Math.sin(ang) * len);
    g.addColorStop(0, hexA(P.accent, 0.24 * k)); g.addColorStop(0.75, hexA(P.accent, 0.07 * k)); g.addColorStop(1, hexA(P.accent, 0));
    ctx.fillStyle = g; ctx.beginPath(); ctx.moveTo(ax, ay);
    ctx.lineTo(ax + Math.cos(ang - hw) * len, ay + Math.sin(ang - hw) * len);
    ctx.lineTo(ax + Math.cos(ang + hw) * len, ay + Math.sin(ang + hw) * len);
    ctx.closePath(); ctx.fill();
  }
  // the pool of light it stands in
  const k = 0.85 + 0.15 * Math.sin((TAU * 2 * t) / SECONDS) + boost;
  ctx.translate(G.bulbX, G.bottomY); ctx.scale(1, 0.2);
  const pg = ctx.createRadialGradient(0, 0, 0, 0, 0, 300);
  pg.addColorStop(0, hexA(P.accent, 0.42 * k)); pg.addColorStop(0.5, hexA(P.accent2, 0.14 * k)); pg.addColorStop(1, hexA(P.accent2, 0));
  ctx.fillStyle = pg; ctx.fillRect(-300, -300, 600, 600);
  ctx.restore();
}
const CONFETTI = (() => {
  const r = rand(71);
  return Array.from({ length: 96 }, () => ({ a: -Math.PI / 2 + (r() - 0.5) * 2.3, v: 300 + r() * 420, d: r() * 0.12, spin: (r() - 0.5) * 16, w: 7 + r() * 7, h: 3.5 + r() * 3, c: Math.floor(r() * 4), ph: r() * TAU }));
})();
/** On the way back in, the trophy bursts confetti (gone well before the wrap). */
function drawConfetti(ctx, t, boost, G, P) {
  const cols = [P.accent, "#FFFFFF", MINT, P.accent2];
  for (const c of CONFETTI) {
    const age = t - IGN - c.d;
    if (age < 0 || age > 1.2) continue;
    const x = G.bulbX + Math.cos(c.a) * c.v * age * 0.9, y = G.bulbY - 50 + Math.sin(c.a) * c.v * age + 560 * age * age;
    if (x > 650) continue;
    ctx.save(); ctx.translate(x, y); ctx.rotate(c.ph + c.spin * age); ctx.scale(1, Math.cos(c.ph + c.spin * 0.7 * age));
    ctx.globalAlpha = 1 - age / 1.2; ctx.fillStyle = cols[c.c]; ctx.fillRect(-c.w / 2, -c.h / 2, c.w, c.h);
    ctx.restore();
  }
}

// ── 48H: a sunburst behind the crown, gold dust rising, stars ──
function drawRays(ctx, t, boost, G, P) {
  drawHalo(ctx, t, boost, G, P);
  const N = 24, step = TAU / N;
  // wide and narrow rays alternate, so the pattern repeats every TWO rays: the
  // burst turns exactly two steps a loop, and the seam is exact
  const rot = (2 * step * t) / SECONDS;
  const cx = G.bulbX, cy = G.topY + 70, R = 1000;
  ctx.save(); ctx.globalCompositeOperation = "lighter";
  const k = 1 + 1.6 * boost;
  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, 760);
  g.addColorStop(0, hexA(P.accent, 0.2 * k)); g.addColorStop(0.4, hexA(P.accent2, 0.09 * k)); g.addColorStop(1, hexA(P.accent2, 0));
  ctx.fillStyle = g; ctx.beginPath();
  for (let i = 0; i < N; i++) {
    const a = rot + i * step, w = i % 2 ? 0.032 : 0.075;
    ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.cos(a - w) * R, cy + Math.sin(a - w) * R); ctx.lineTo(cx + Math.cos(a + w) * R, cy + Math.sin(a + w) * R); ctx.closePath();
  }
  ctx.fill(); ctx.restore();
}
const DUST = (() => {
  const r = rand(83);
  return Array.from({ length: 50 }, () => ({ x: OC.x + (r() - 0.5) * 520, y0: OY + FS * 0.92 + r() * 60, rise: 320 + r() * 320, ph: r(), sway: 8 + r() * 18, s: 0.9 + r() * 1.9, br: 0.3 + r() * 0.6 }));
})();
function drawDust(ctx, t, G, P) {
  drawTwinkles(ctx, t, G, P);
  ctx.save(); ctx.globalCompositeOperation = "lighter";
  for (const e of DUST) {
    const ph = (e.ph + t / SECONDS) % 1; // one climb a loop
    const y = e.y0 - e.rise * ph, x = e.x + e.sway * Math.sin(TAU * (ph * 1.5 + e.ph));
    const a = e.br * Math.sin(Math.PI * ph) * clamp((650 - x) / 90);
    if (a <= 0.01) continue;
    const sg = ctx.createRadialGradient(x, y, 0, x, y, e.s * 5);
    sg.addColorStop(0, `rgba(${P.bokeh},${a * 0.6})`); sg.addColorStop(1, `rgba(${P.bokeh},0)`);
    ctx.fillStyle = sg; ctx.fillRect(x - e.s * 5, y - e.s * 5, e.s * 10, e.s * 10);
    ctx.fillStyle = `rgba(255,248,225,${a})`; ctx.beginPath(); ctx.arc(x, y, e.s, 0, TAU); ctx.fill();
  }
  ctx.restore();
}

// ── 6H: a ghost dial turning behind, the timer and the crystal on the face ──
/** The stopwatch for the pill. */
function watchIcon(ctx, x, y, s, col) {
  ctx.save(); ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = 0.2 * s; ctx.lineCap = "round";
  ctx.beginPath(); ctx.arc(x, y + 0.15 * s, 0.78 * s, 0, TAU); ctx.stroke();
  ctx.fillRect(x - 0.12 * s, y - 1.0 * s, 0.24 * s, 0.3 * s);
  roundRect(ctx, x - 0.3 * s, y - 1.12 * s, 0.6 * s, 0.18 * s, 0.06 * s); ctx.fill();
  ctx.beginPath(); ctx.moveTo(x, y + 0.15 * s); ctx.lineTo(x + 0.32 * s, y - 0.2 * s); ctx.stroke();
  ctx.restore();
}
/** Behind the watch: a great ghost dial turning slowly (five marks a loop —
 *  every fifth mark is the same as the next fifth, so the seam is exact), and
 *  rings of time rippling out. */
function drawWatchBack(ctx, t, boost, G, P) {
  drawRipples(ctx, t, boost, G, P);
  ctx.save(); ctx.globalCompositeOperation = "lighter";
  const cx = G.bulbX, cy = G.bulbY, rot = (5 * (TAU / 60) * t) / SECONDS, k = 1 + 1.2 * boost;
  ctx.strokeStyle = hexA(P.accent, 0.1 * k); ctx.lineWidth = 1.2;
  for (const r of [300, 352]) { ctx.beginPath(); ctx.arc(cx, cy, r, 0, TAU); ctx.stroke(); }
  for (let i = 0; i < 60; i++) {
    const a = rot + (i * TAU) / 60, major = i % 5 === 0;
    const r0 = major ? 306 : 322, r1 = 346;
    ctx.strokeStyle = hexA(P.accent, (major ? 0.2 : 0.09) * k); ctx.lineWidth = major ? 2.4 : 1.2;
    ctx.beginPath(); ctx.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0); ctx.lineTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1); ctx.stroke();
  }
  ctx.restore();
}
/** The watch's crystal: a domed glass over the dial — a crescent of reflected
 *  light along its upper rim, a bright edge, a faint counter-reflection — that
 *  slides as the studio turns. */
function drawCrystal(ctx, t, boost, G, P) {
  const sh = 0.9 * envYaw(t), r = WT.dial - 0.02, z = WT.zf + 0.03, N = 28;
  const pt = (a, rr) => G.project(rr * Math.sin(a), WT.cy + rr * Math.cos(a), z);
  const crescent = (a0, a1, w) => {
    ctx.beginPath();
    for (let i = 0; i <= N; i++) { const a = a0 + ((a1 - a0) * i) / N, p = pt(a, r); i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]); }
    for (let i = N; i >= 0; i--) { const a = a0 + ((a1 - a0) * i) / N, p = pt(a, r - w * Math.sin((Math.PI * i) / N)); ctx.lineTo(p[0], p[1]); }
    ctx.closePath();
  };
  ctx.save(); ctx.globalCompositeOperation = "lighter";
  const c = G.project(0, WT.cy, z), tl = pt(-1.0 + sh, r);
  const g = ctx.createLinearGradient(tl[0], tl[1], c[0], c[1]);
  g.addColorStop(0, "rgba(225,245,255,0.5)"); g.addColorStop(0.5, "rgba(170,225,255,0.12)"); g.addColorStop(1, "rgba(170,225,255,0)");
  crescent(-2.3 + sh, 0.1 + sh, 0.42); ctx.fillStyle = g; ctx.fill();
  // the bright edge of the glass
  ctx.lineCap = "round";
  for (const [w, al] of [[5, 0.16], [1.6, 0.7]]) {
    ctx.strokeStyle = `rgba(235,250,255,${al})`; ctx.lineWidth = w; ctx.beginPath();
    for (let i = 0; i <= N; i++) { const a = -1.9 + sh + (1.5 * i) / N, p = pt(a, r); i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]); }
    ctx.stroke();
  }
  // a faint counter-reflection low on the right
  crescent(1.75 + sh, 2.85 + sh, 0.12); ctx.fillStyle = "rgba(160,220,255,0.1)"; ctx.fill();
  // a hard little sun on the dome
  const sp = pt(-0.95 + sh, r * 0.72), sg = ctx.createRadialGradient(sp[0], sp[1], 0, sp[0], sp[1], 16);
  sg.addColorStop(0, "rgba(255,255,255,0.75)"); sg.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = sg; ctx.fillRect(sp[0] - 16, sp[1] - 16, 32, 32);
  ctx.restore();
}
/** The Dexvra gem at twelve o'clock, printed on the dial in perspective. */
function drawDialGem(ctx, t, boost, G, P) {
  const r = 1.0, z = WT.zd - WT.slope * ((r - WT.L) / (WT.dial - WT.L)) + 0.02;
  const p0 = G.project(0, WT.cy + r, z), pu = G.project(0.1, WT.cy + r, z), pv = G.project(0, WT.cy + r - 0.1, z);
  const ppu = Math.hypot(pu[0] - p0[0], pu[1] - p0[1]) / 0.1 || 1;
  const ax = (pu[0] - p0[0]) / (0.1 * ppu), ay = (pu[1] - p0[1]) / (0.1 * ppu);
  const bx = (pv[0] - p0[0]) / (0.1 * ppu), by = (pv[1] - p0[1]) / (0.1 * ppu);
  const sz = 0.34 * ppu;
  ctx.save(); ctx.globalCompositeOperation = "lighter";
  const k = 0.75 + 0.25 * Math.sin((TAU * 2 * t) / SECONDS) + boost;
  const g = ctx.createRadialGradient(p0[0], p0[1], 0, p0[0], p0[1], sz * 1.3);
  g.addColorStop(0, hexA(P.accent, 0.45 * k)); g.addColorStop(1, hexA(P.accent, 0));
  ctx.fillStyle = g; ctx.fillRect(p0[0] - sz * 1.3, p0[1] - sz * 1.3, sz * 2.6, sz * 2.6);
  ctx.restore();
  ctx.save(); ctx.transform(ax, ay, bx, by, p0[0], p0[1]);
  kit.drawGem(ctx, -sz / 2, -sz * 0.48, sz);
  ctx.restore();
}
/** The chronograph's face: the gem and the timer under the glass, then the glass. */
function drawWatchFront(ctx, t, boost, G, P) {
  drawDialGem(ctx, t, boost, G, P);
  drawTimer(ctx, t, boost, G, P);
  drawCrystal(ctx, t, boost, G, P);
}
/** Rings of time rippling out from the watch, two a loop. */
function drawRipples(ctx, t, boost, G, P) {
  drawHalo(ctx, t, boost, G, P);
  ctx.save(); ctx.globalCompositeOperation = "lighter";
  for (let i = 0; i < 3; i++) {
    const q = ((2 * t) / SECONDS + i / 3) % 1; // whole passes a loop
    const r = G.logoR * 1.5 + q * 380, a = 0.22 * Math.sin(Math.PI * q) * (1 + boost);
    if (a < 0.01) continue;
    ctx.strokeStyle = hexA(P.accent, a); ctx.lineWidth = 1.5 + 2 * (1 - q);
    ctx.beginPath(); ctx.ellipse(G.bulbX, G.bulbY, r, r * 0.94, 0, 0, TAU); ctx.stroke();
  }
  ctx.restore();
}
/** Where the timer's light is: one turn a loop, and two quick turns on the way
 *  back in (so at t = 6 it is exactly where it was at 0, three turns on). */
const sweepAt = (t) => 1.25 + TAU * (t / SECONDS) + 2 * TAU * easeInOut(clamp((t - IGN) / 0.75));
/** The timer: a light running round the dial over the indices, its tail
 *  fading behind it; the indices it passes glow. */
function drawTimer(ctx, t, boost, G, P) {
  const th = sweepAt(t), fast = t > IGN && t < IGN + 0.75 ? 1 : 0;
  const tail = 1.5 + 2.2 * fast, r = 1.07, z = WT.zd + 0.04, N = 40;
  ctx.save(); ctx.globalCompositeOperation = "lighter"; ctx.lineCap = "round";
  const pt = (a) => G.project(r * Math.sin(a), WT.cy + r * Math.cos(a), z);
  for (const [w, k] of [[16, 0.12], [6, 0.38], [2.2, 0.95]]) {
    for (let i = 0; i < N; i++) {
      const a0 = th - (tail * i) / N, a1 = th - (tail * (i + 1)) / N;
      const al = k * Math.pow(1 - i / N, 1.6);
      const p0 = pt(a0), p1 = pt(a1);
      ctx.strokeStyle = w < 3 ? `rgba(235,250,255,${al})` : hexA(P.accent, al);
      ctx.lineWidth = w; ctx.beginPath(); ctx.moveTo(p0[0], p0[1]); ctx.lineTo(p1[0], p1[1]); ctx.stroke();
    }
  }
  // the head
  const h = pt(th), hg = ctx.createRadialGradient(h[0], h[1], 0, h[0], h[1], 26);
  hg.addColorStop(0, "rgba(255,255,255,0.95)"); hg.addColorStop(0.3, hexA(P.accent, 0.6)); hg.addColorStop(1, hexA(P.accent, 0));
  ctx.fillStyle = hg; ctx.fillRect(h[0] - 26, h[1] - 26, 52, 52);
  // the indices behind the head glow, fading
  for (let k = 0; k < 12; k++) {
    const ak = (k / 12) * TAU, behind = (((th - ak) % TAU) + TAU) % TAU;
    const g = Math.max(0, 1 - behind / 2.2) * (0.7 + 0.3 * fast);
    if (g < 0.02) continue;
    const q = pt(ak), gg = ctx.createRadialGradient(q[0], q[1], 0, q[0], q[1], 14);
    gg.addColorStop(0, hexA(P.accent, 0.55 * g)); gg.addColorStop(1, hexA(P.accent, 0));
    ctx.fillStyle = gg; ctx.fillRect(q[0] - 14, q[1] - 14, 28, 28);
  }
  ctx.restore();
}
const MOTES = (() => {
  const r = rand(97);
  return Array.from({ length: 40 }, () => ({ x: OC.x + (r() - 0.5) * 560, y0: OY + FS * 0.9 + r() * 60, rise: 300 + r() * 300, cyc: 1 + Math.floor(r() * 2), ph: r(), sway: 8 + r() * 16, s: 0.9 + r() * 1.6, br: 0.3 + r() * 0.6 }));
})();
function drawMotes(ctx, t, G, P) {
  ctx.save(); ctx.globalCompositeOperation = "lighter";
  for (const e of MOTES) {
    const ph = (e.ph + (e.cyc * t) / SECONDS) % 1; // whole climbs a loop
    const y = e.y0 - e.rise * ph, x = e.x + e.sway * Math.sin(TAU * (ph + e.ph));
    const a = e.br * Math.sin(Math.PI * ph) * clamp((650 - x) / 90);
    if (a <= 0.01) continue;
    const sg = ctx.createRadialGradient(x, y, 0, x, y, e.s * 5);
    sg.addColorStop(0, `rgba(${P.bokeh},${a * 0.55})`); sg.addColorStop(1, `rgba(${P.bokeh},0)`);
    ctx.fillStyle = sg; ctx.fillRect(x - e.s * 5, y - e.s * 5, e.s * 10, e.s * 10);
    ctx.fillStyle = `rgba(235,250,255,${a})`; ctx.beginPath(); ctx.arc(x, y, e.s, 0, TAU); ctx.fill();
  }
  ctx.restore();
}
const CX = 690; // the copy column
/** The fixed chrome: brand, the network chip, the footer handles. */
function chromeLayer(cv, chain, P) {
  const c = cv.createCanvas(W, H), ctx = c.getContext("2d");
  drawBrandMark(ctx, CX, 44, 38);
  ctx.textBaseline = "alphabetic"; ctx.fillStyle = "#F1F5FB"; ctx.font = `800 27px ${F.x}`; ctx.fillText("Dexvra", CX + 50, 72);
  const ct = String(chain || "").toUpperCase().slice(0, 20);
  if (ct) {
    ctx.font = `700 ${LABEL_MIN}px ${F.m7}`;
    const cw = trackedW(ctx, ct, 2.6) + 40;
    roundRect(ctx, W - 60 - cw, 46, cw, 36, 18); ctx.fillStyle = "rgba(10,30,56,0.6)"; ctx.fill();
    ctx.strokeStyle = hexA(P.accent, 0.5); ctx.lineWidth = 1.2; ctx.stroke();
    ctx.fillStyle = "#D8F4FF"; ctx.textBaseline = "middle"; tracked(ctx, ct, W - 60 - cw + 20, 65, 2.6);
  }
  const tg = String(CHANNELS.trending || "dexvratrending");
  const items = [
    ["web", hostOf(SITE_URL) || "dexvra.io"],
    ["tg", tg.startsWith("@") ? tg : `@${tg}`],
    ["x", `@${X_LISTING_HANDLE}`],
  ];
  let x = CX; const y = 596;
  ctx.font = `600 18px ${F.d6}`; ctx.textBaseline = "middle";
  for (const [k, text] of items) {
    footerIcon(ctx, k, x + 9, y, 9);
    ctx.fillStyle = "#C2CEDD"; ctx.fillText(text, x + 26, y + 1);
    x += 26 + ctx.measureText(text).width + 28;
  }
  return c;
}
function flare(ctx, x, y, f, P) {
  if (f <= 0.01) return;
  const [edge, mid, ring, out] = P.flare;
  ctx.save(); ctx.globalCompositeOperation = "lighter";
  const g = ctx.createLinearGradient(x - 420, 0, x + 420, 0);
  g.addColorStop(0, `rgba(${edge},0)`); g.addColorStop(0.5, `rgba(${mid},${0.8 * f})`); g.addColorStop(1, `rgba(${edge},0)`);
  ctx.fillStyle = g; ctx.fillRect(x - 420, y - 1.5, 840, 3);
  ctx.globalAlpha = 0.35 * f; ctx.fillRect(x - 300, y - 6, 600, 12); ctx.globalAlpha = 1;
  const r = ctx.createRadialGradient(x, y, 0, x, y, 120);
  r.addColorStop(0, `rgba(255,255,255,${f})`); r.addColorStop(0.25, `rgba(${ring},${0.6 * f})`); r.addColorStop(1, `rgba(${out},0)`);
  ctx.fillStyle = r; ctx.fillRect(x - 120, y - 120, 240, 240);
  ctx.fillStyle = `rgba(255,255,255,${0.9 * f})`;
  for (const [w, h] of [[60 * f + 10, 1.6], [1.6, 46 * f + 8]]) { ctx.beginPath(); ctx.ellipse(x, y, w, h, 0, 0, TAU); ctx.fill(); }
  ctx.restore();
}

// ── type: masked, blur-to-sharp ──
function masked(ctx, t, a, d, y0, y1, draw, slide = 34) {
  const k = reveal(t, a, d);
  if (k <= 0.002) return;
  ctx.save();
  ctx.beginPath(); ctx.rect(CX - 20, y0, W - CX + 20, y1 - y0); ctx.clip();
  ctx.translate(0, t >= IN0 ? (1 - k) * slide : -(1 - k) * slide * 0.5);
  ctx.globalAlpha = k;
  const blur = (1 - k) * 8;
  if (blur > 0.3) ctx.filter = `blur(${blur.toFixed(1)}px)`;
  draw(ctx);
  ctx.restore();
  ctx.filter = "none";
}
/** "Trending 24H" → "TRENDING 24H"; anything that is not a trending run's own
 *  badge (a listing tier, nothing at all) → "TRENDING". */
function pillOf(badge) {
  const m = /trending\s*(\d+)\s*h/i.exec(String(badge || ""));
  return m ? `TRENDING ${m[1]}H` : "TRENDING";
}
/** A figure the clip may print: a real spelling, never a placeholder. */
const realFigure = (v) => {
  const s = String(v == null ? "" : v).trim();
  return s && !/^(TBA|—|-|\$?0(\.0+)?|n\/?a|null|undefined|NaN)$/i.test(s) ? s : null;
};
/** Sizes and cells for the copy, decided once per clip from the FINAL strings. */
function copyLayout(cv, coin, badge) {
  const m = cv.createCanvas(10, 10).getContext("2d");
  const sym = tickerOf(coin.symbol);
  let ts = 100; m.font = `800 ${ts}px ${F.x}`;
  while (m.measureText(sym).width > 530 && ts > 44) { ts -= 2; m.font = `800 ${ts}px ${F.x}`; }
  const name = String(coin.name || "").trim();
  let ns = 30;
  if (name) { m.font = `500 ${ns}px ${F.m}`; while (m.measureText(name).width > 530 && ns > 18) { ns -= 1; m.font = `500 ${ns}px ${F.m}`; } }
  const cells = [];
  const price = realFigure(coin.price), mcap = realFigure(coin.mcap), liq = realFigure(coin.liq);
  if (price) cells.push(["PRICE", price]);
  if (mcap) cells.push(["MARKET CAP", mcap]);
  if (liq) cells.push(["LIQUIDITY", liq]);
  const PW = W - 60 - CX, cw = cells.length ? PW / cells.length : PW;
  const vs = cells.map(([, v]) => {
    let s = 30; m.font = `700 ${s}px ${F.d7}`;
    while (m.measureText(v).width > cw - 40 && s > 18) { s -= 1; m.font = `700 ${s}px ${F.d7}`; }
    return s;
  });
  return { sym, ts, name, ns, cells, vs, PW, cw, pill: pillOf(badge) };
}
/** A figure decoding on the way in: digits not yet settled show a scramble. */
function decode(v, k, f) {
  if (k >= 1) return v;
  const cs = [...v];
  return cs.map((ch, i) => (/\d/.test(ch) && k < (i + 1) / cs.length ? String((f * 7 + i * 13) % 10) : ch)).join("");
}
const PANEL_Y = 372;
const PANEL_H = 96;
function drawCopy(ctx, t, L, f, P, icon) {
  // the pill
  masked(ctx, t, 0.25, 0.45, 132, 194, (c) => {
    c.font = `700 18px ${F.m7}`;
    const pw = trackedW(c, L.pill, 4) + 68;
    roundRect(c, CX, 140, pw, 44, 22);
    const pg = c.createLinearGradient(CX, 0, CX + pw, 0); pg.addColorStop(0, hexA(P.accent, 0.28)); pg.addColorStop(1, hexA(P.accent2, 0.18));
    c.fillStyle = pg; c.fill(); c.strokeStyle = hexA(P.accent, 0.7); c.lineWidth = 1.4; c.stroke();
    const pulse = 0.6 + 0.4 * Math.sin((TAU * 3 * t) / SECONDS);
    c.shadowColor = P.accent; c.shadowBlur = 8 + 10 * pulse; icon(c, CX + 28, 163, 13, P.iconCol); c.shadowBlur = 0;
    c.fillStyle = P.pillText; c.textBaseline = "middle"; tracked(c, L.pill, CX + 48, 163, 4);
  });
  // the ticker, letter by letter
  let x = CX - 4;
  [...L.sym].forEach((ch, i) => {
    ctx.font = `800 ${L.ts}px ${F.x}`;
    const w = ctx.measureText(ch).width, cx = x;
    masked(ctx, t, 0.35 + i * 0.045, 0.45, 196, 312, (c) => {
      c.font = `800 ${L.ts}px ${F.x}`; c.textBaseline = "alphabetic";
      const tg = c.createLinearGradient(0, 290 - L.ts * 0.74, 0, 290); tg.addColorStop(0, "#FFFFFF"); tg.addColorStop(1, P.tickerLow);
      c.fillStyle = tg; c.fillText(ch, cx, 290);
    }, 70);
    x += w;
  });
  // a shimmer across the ticker, once a loop
  const sw = (t - 1.3) / 0.9;
  if (sw > 0 && sw < 1) {
    ctx.save(); ctx.font = `800 ${L.ts}px ${F.x}`; ctx.textBaseline = "alphabetic";
    const w = ctx.measureText(L.sym).width, sx = CX - 4 - 120 + (w + 240) * sw;
    const g = ctx.createLinearGradient(sx - 60, 0, sx + 60, 0);
    g.addColorStop(0, "rgba(255,255,255,0)"); g.addColorStop(0.5, "rgba(255,255,255,0.7)"); g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.globalCompositeOperation = "lighter"; ctx.fillStyle = g; ctx.fillText(L.sym, CX - 4, 290); ctx.restore();
  }
  if (L.name) masked(ctx, t, 0.6, 0.45, 304, 350, (c) => { c.font = `500 ${L.ns}px ${F.m}`; c.fillStyle = "#A9B9CE"; c.textBaseline = "alphabetic"; c.fillText(L.name, CX, 334); });
  // the panel
  if (L.cells.length) {
    const kv = t >= IN0 ? at(t, 0.8, 0.45) : 1; // settled by 5.75, well before the wrap
    masked(ctx, t, 0.75, 0.5, 362, 480, (c) => {
      roundRect(c, CX, PANEL_Y, L.PW, PANEL_H, 18);
      const g2 = c.createLinearGradient(0, PANEL_Y, 0, PANEL_Y + PANEL_H); g2.addColorStop(0, "rgba(16,32,58,0.88)"); g2.addColorStop(1, "rgba(6,12,24,0.88)");
      c.fillStyle = g2; c.fill(); c.strokeStyle = hexA(P.accent, 0.3); c.lineWidth = 1.2; c.stroke();
      const run = (t - 2.2) / 1.2; // a light running round the panel, once a loop
      if (run > 0 && run < 1) {
        const cg = c.createConicGradient(TAU * run - Math.PI / 2, CX + L.PW / 2, PANEL_Y + PANEL_H / 2);
        cg.addColorStop(0, hexA(P.accent, 0)); cg.addColorStop(0.06, hexA(P.accent, 0.95)); cg.addColorStop(0.12, hexA(P.accent, 0)); cg.addColorStop(1, hexA(P.accent, 0));
        roundRect(c, CX, PANEL_Y, L.PW, PANEL_H, 18); c.strokeStyle = cg; c.lineWidth = 2; c.stroke();
      }
      L.cells.forEach(([k, v], i) => {
        const cx = CX + i * L.cw + 24;
        if (i) { c.strokeStyle = hexA(P.accent, 0.18); c.lineWidth = 1.2; c.beginPath(); c.moveTo(CX + i * L.cw, PANEL_Y + 20); c.lineTo(CX + i * L.cw, PANEL_Y + PANEL_H - 20); c.stroke(); }
        c.font = `700 ${LABEL_MIN}px ${F.m7}`; c.fillStyle = hexA(ICE, 0.72); c.textBaseline = "alphabetic"; tracked(c, k, cx, PANEL_Y + 36, 1.6);
        c.font = `700 ${L.vs[i]}px ${F.d7}`; c.fillStyle = k === "MARKET CAP" ? "#FFFFFF" : "#DCEBFA";
        c.fillText(decode(v, kv, f), cx, PANEL_Y + 76);
      });
    });
  }
  // the board line, its dot breathing
  masked(ctx, t, 0.9, 0.45, 496, 540, (c) => {
    const pulse = 0.5 + 0.5 * Math.sin((TAU * 3 * t) / SECONDS);
    c.fillStyle = MINT; c.shadowColor = MINT; c.shadowBlur = 6 + 10 * pulse;
    c.beginPath(); c.arc(CX + 7, 514, 6, 0, TAU); c.fill(); c.shadowBlur = 0;
    c.font = `600 19px ${F.d6}`; c.fillStyle = hexA(MINT, 0.95); c.textBaseline = "middle"; c.fillText("Live on the Dexvra trending board", CX + 22, 515);
  });
}

/**
 * Draw the clip. `coin` = bannerCoin { symbol, name, chain, price, mcap, liq }
 * (figures already spelt — see the header); `times` (seconds, UNWRAPPED) is the
 * test seam. Calls onFrame(rgbaBuffer) per frame and awaits it.
 */
async function drawFrames(coin, logoBuffer, { count = FRAMES, times = null, badge = null, design = null, onFrame, cancel = null } = {}) {
  const cv = kit.canvasLib();
  if (!cv) return false;
  coin = coin || {};
  warnBoxes("trending-motion", { symbol: coin.symbol, name: coin.name });
  let img = null;
  if (logoBuffer) { try { img = await cv.loadImage(logoBuffer); } catch { img = null; } } // an unreadable logo draws the monogram
  // the run's length picks the design (24H the flame); a caller may name one
  const D = DESIGNS[design] || DESIGNS[designFor(badge)];
  const P = D.pal;
  const body = await bodyFor(D.key);
  const L = copyLayout(cv, coin, badge);
  const LT = 256, lt = logoTexture(cv, img, coin.symbol);
  const BASE = baseLayer(cv, P), SHADE = shadeLayer(cv), CHROME = chromeLayer(cv, coin.chain, P), MID = softSprite(cv, 6, P.bokeh), FG = softSprite(cv, 22, P.bokeh);
  const sprite = cv.createCanvas(FS, FS), sx = sprite.getContext("2d"), sid = sx.createImageData(FS, FS);
  const warp = cv.createCanvas(FS + 40, FS), wx = warp.getContext("2d");
  const half = cv.createCanvas(FS / 2, FS / 2), hx = half.getContext("2d");
  let shadow = null; // the silhouette barely changes: its drop shadow is made once
  const out = cv.createCanvas(W, H), ctx = out.getContext("2d");
  const { metalPx, mets, logoL, bulb, yTop, yBot } = body;
  const ev = new Float64Array(3);

  // the logo never changes within a clip: bake it, with its coverage
  const n2 = FSS * FSS;
  const logoRGB = new Float32Array(FS * FS * 3), logoA = new Float32Array(FS * FS);
  const base = new Uint8ClampedArray(FS * FS * 4);
  for (let i = 0; i < logoL.length; i += 6) {
    const p = logoL[i], u = logoL[i + 1], v = logoL[i + 2], a = logoL[i + 3], light = logoL[i + 4], coat = 255 * logoL[i + 5];
    const ti = (Math.min(LT - 1, (v * LT) | 0) * LT + Math.min(LT - 1, (u * LT) | 0)) * 4;
    logoA[p] = a;
    for (let c = 0; c < 3; c++) {
      const val = Math.min(255, lt[ti + c] * light + coat);
      logoRGB[p * 3 + c] = val; base[p * 4 + c] = val;
    }
    base[p * 4 + 3] = a * 255;
  }
  // the sway's anchor: nothing at or below the top of the logo moves
  const anchor = Math.max(1, bulb.top - 6);
  const swayAt = (y, t) => {
    const k = Math.pow(clamp((anchor - y) / anchor), 1.4);
    return k * (6 * Math.sin((TAU * 2 * t) / SECONDS + y * 0.012) + 3.5 * Math.sin((TAU * 3 * t) / SECONDS + y * 0.023 + 1.3));
  };
  const bulbX = OX + bulb.x, bulbY = OY + bulb.y;
  // where each design's effects start from (sprite space → canvas)
  const G = { cx: OC.x, cy: OC.y, bulbX, bulbY, logoR: bulb.r, topY: OY + yTop, bottomY: OY + yBot };
  // a point on the object → the canvas (inside the object's own transform), and
  // whether the metal or the logo covers that pixel (an effect behind it hides)
  const proj = projector(D);
  G.project = (x, y, z) => { const q = proj(x, y, z); return [OX + q[0], OY + q[1], q[2]]; };
  G.covered = (cx, cy) => {
    const px = Math.round(cx - OX), py = Math.round(cy - OY);
    return px >= 0 && py >= 0 && px < FS && py < FS ? sid.data[(py * FS + px) * 4 + 3] / 255 : 0;
  };
  const S = D.studio;

  const n = times ? times.length : count;
  for (let f = 0; f < n; f++) {
    // a caller that stopped waiting (the budget) stops the work too
    if (cancel && cancel.cancelled) throw new Error("cancelled — the caller stopped waiting");
    const t = times ? times[f] : (f % FRAMES) / FPS;
    const boost = boostAt(t), cam = camera(t), yaw = envYaw(t), fs = flameScale(t), dim = flameDim(t);

    // ── the flame sprite: the metal re-lit, the logo over it ──
    const cyw = Math.cos(yaw), syw = Math.sin(yaw);
    const data = sid.data; data.set(base);
    for (let i = 0, nm = metalPx.length; i < nm; i++) {
      const p = metalPx[i], p4 = p * 4;
      let r = 0, g = 0, b = 0, tot = 0;
      for (let o = i * 20, oe = o + 20; o < oe; o += 10) {
        const cnt = mets[o + 9]; if (!cnt) continue;
        const rx = mets[o], ry = mets[o + 1], rz = mets[o + 2];
        env(rx * cyw - rz * syw, ry, rx * syw + rz * cyw, ev, S);
        r += toneFast(ev[0] * mets[o + 3] + mets[o + 6]) * cnt;
        g += toneFast(ev[1] * mets[o + 4] + mets[o + 7]) * cnt;
        b += toneFast(ev[2] * mets[o + 5] + mets[o + 8]) * cnt;
        tot += cnt;
      }
      const ma = tot / n2, la = logoA[p], A = ma + la;
      if (A <= 0) continue;
      // the metal's average and the logo's, weighted by what each covers
      const km = 255 / tot;
      data[p4] = ((r * km) * ma + logoRGB[p * 3] * la) / A;
      data[p4 + 1] = ((g * km) * ma + logoRGB[p * 3 + 1] * la) / A;
      data[p4 + 2] = ((b * km) * ma + logoRGB[p * 3 + 2] * la) / A;
      data[p4 + 3] = Math.min(1, A) * 255;
    }
    sx.putImageData(sid, 0, 0);
    if (!shadow) {
      shadow = cv.createCanvas(FS + 240, FS + 240);
      const shx = shadow.getContext("2d");
      shx.shadowColor = "rgba(0,0,0,0.65)"; shx.shadowBlur = 50; shx.shadowOffsetY = 26;
      // the sprite far off-canvas, so only its shadow lands here
      shx.shadowOffsetX = 4000; shx.drawImage(sprite, 120 - 4000, 120);
    }
    // the flame sways: thin strips, offset more toward the tips. Nothing else does.
    wx.globalCompositeOperation = "source-over"; wx.clearRect(0, 0, FS + 40, FS);
    if (D.sway) {
      for (let y = 0; y < FS; y += 2) {
        const dx = y < anchor ? swayAt(y, t) : 0;
        wx.drawImage(sprite, 0, y, FS, 2, 20 + dx, y, FS, 2);
      }
    } else {
      wx.drawImage(sprite, 20, 0);
    }
    // a glint across the metal, once a loop
    const gl = (t - 0.6) / 1.1;
    if (gl > 0 && gl < 1) {
      wx.globalCompositeOperation = "source-atop";
      const bx = -200 + (FS + 400) * easeInOut(gl);
      const g = wx.createLinearGradient(bx - 90, 0, bx + 90, 60);
      g.addColorStop(0, "rgba(255,255,255,0)"); g.addColorStop(0.5, "rgba(255,255,255,0.3)"); g.addColorStop(1, "rgba(255,255,255,0)");
      wx.fillStyle = g; wx.fillRect(0, 0, FS + 40, FS);
    }
    if (dim > 0.002) {
      wx.globalCompositeOperation = "source-atop";
      wx.fillStyle = `rgba(1,8,22,${dim.toFixed(3)})`; wx.fillRect(0, 0, FS + 40, FS);
    }
    wx.globalCompositeOperation = "source-over";

    // ── compose ──
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = "source-over"; ctx.globalAlpha = 1;
    // the background moves at half the camera's move: parallax
    const sb = 1 + (cam.s - 1) * 0.5;
    ctx.setTransform(sb, 0, 0, sb, OC.x * (1 - sb) + cam.dx * 0.5, OC.y * (1 - sb) + cam.dy * 0.5);
    ctx.drawImage(BASE, -80, -40);
    ctx.save(); ctx.globalCompositeOperation = "lighter";
    for (const bk of MIDBOK) {
      const ph = TAU * ((bk.k * t) / SECONDS + bk.ph);
      ctx.globalAlpha = bk.a * (0.7 + 0.3 * Math.sin(ph));
      const s = bk.s * 2; ctx.drawImage(MID, bk.x + 14 * Math.sin(ph) - s / 2, bk.y + 9 * Math.cos(ph) - s / 2, s, s);
    }
    ctx.restore();
    D.back(ctx, t, boost, G, P);
    ctx.setTransform(cam.s, 0, 0, cam.s, OC.x * (1 - cam.s) + cam.dx, OC.y * (1 - cam.s) + cam.dy);
    D.ambient(ctx, t, G, P);
    // the object, scaled about its logo (burning low, re-igniting); the others float
    ctx.save();
    if (D.float) ctx.translate(0, D.float * Math.sin((TAU * t) / SECONDS));
    ctx.translate(bulbX, bulbY); ctx.scale(fs, fs); ctx.translate(-bulbX, -bulbY);
    ctx.drawImage(shadow, OX - 120, OY - 120);
    ctx.drawImage(warp, OX - 20, OY);
    // bloom: the flame's own light, blurred back over itself (at half size)
    hx.globalCompositeOperation = "copy"; hx.filter = "blur(7px)"; hx.drawImage(warp, 20, 0, FS, FS, 0, 0, FS / 2, FS / 2); hx.filter = "none";
    ctx.globalCompositeOperation = "lighter"; ctx.globalAlpha = (0.16 + 0.05 * flicker(t)) * (1 - dim) + 0.3 * boost;
    ctx.drawImage(half, OX, OY, FS, FS);
    ctx.globalCompositeOperation = "source-over"; ctx.globalAlpha = 1;
    // effects that ride ON the object (registered to it through G.project)
    if (D.front) D.front(ctx, t, boost, G, P);
    ctx.restore();
    // ignition: a flash ring off the logo, a burst of sparks, a flare
    if (t >= IGN && boost > 0.002) {
      ctx.save(); ctx.globalCompositeOperation = "lighter";
      const u = clamp((t - IGN) / 0.8);
      if (u < 1) {
        const rr = 40 + 300 * easeOut(u);
        ctx.lineWidth = 2 + 10 * (1 - u); ctx.strokeStyle = hexA(P.accent, 0.85 * (1 - u));
        ctx.beginPath(); ctx.ellipse(bulbX, bulbY, rr, rr * 0.9, 0, 0, TAU); ctx.stroke();
      }
      ctx.lineCap = "round";
      for (const s of SPARKS) {
        const age = (t - IGN - s.d) / s.life;
        if (age < 0 || age > 1) continue;
        const tt = age * s.life, vx = Math.cos(s.a) * s.v, vy = Math.sin(s.a) * s.v;
        const x1 = bulbX + vx * tt, y1 = bulbY - 60 + vy * tt - 40 * tt * tt;
        ctx.strokeStyle = `rgba(${s.mint ? P.spark[0] : P.spark[1]},${(1 - age) * 0.9})`; ctx.lineWidth = s.w * (1 - age) + 0.4;
        ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x1 - vx * 0.04, y1 - vy * 0.04); ctx.stroke();
      }
      ctx.restore();
      flare(ctx, bulbX, OY + bulb.top - 30, boost, P);
    }
    // each design's own entrance (a strike, confetti) times itself
    if (D.ignite) D.ignite(ctx, t, boost, G, P);
    // foreground depth-of-field bokeh
    ctx.save(); ctx.globalCompositeOperation = "lighter";
    for (const [bx, by, bs, ba, ph] of FGBOK) {
      const q = TAU * (t / SECONDS + ph);
      ctx.globalAlpha = ba * (0.75 + 0.25 * Math.sin(q));
      ctx.drawImage(FG, bx + 22 * Math.sin(q) - bs, by + 12 * Math.cos(q) - bs, bs * 2, bs * 2);
    }
    ctx.restore();
    // the overlay layers never move with the camera
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(SHADE, 0, 0);
    ctx.drawImage(CHROME, 0, 0);
    drawCopy(ctx, t, L, f, P, D.icon);
    // ⚠️ canvas.data() is a LIVE VIEW of the pixels (listingMotion's scar): the
    // consumer must be done with it before the next frame — the encoder awaits
    // its pipe write, frames() copies
    if (onFrame) await onFrame(out.data());
    // let the bot answer between frames
    await new Promise((r) => setImmediate(r));
  }
  return true;
}

/** Frames as an array of RGBA buffers (tests, fonts:check). */
async function frames(coin, logoBuffer, { count = FRAMES, times = null, badge = null, design = null } = {}) {
  const list = [];
  const ok = await drawFrames(coin, logoBuffer, { count, times, badge, design, onFrame: (b) => list.push(Buffer.from(b)) });
  return ok ? list : null;
}

function ffmpegPath() {
  try {
    return require("@ffmpeg-installer/ffmpeg").path;
  } catch {
    return null;
  }
}
/** An ffmpeg turning piped RGBA frames into a silent MP4 (an autoplaying
 *  Telegram animation — no audio track). */
function encoder(outPath) {
  const bin = ffmpegPath();
  if (!bin) throw new Error("ffmpeg unavailable");
  const args = [
    "-y", "-loglevel", "error",
    "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${W}x${H}`, "-r", String(FPS), "-i", "pipe:0",
    "-c:v", "libx264", "-preset", "medium", "-crf", "19", "-pix_fmt", "yuv420p",
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
    // resolves once the frame is in the pipe: the next frame reuses the memory
    write(frame) {
      if (failed) return Promise.reject(failed);
      return new Promise((resolve, reject) => p.stdin.write(frame, (e) => (e ? reject(failed || e) : resolve())));
    },
    end() { p.stdin.end(); return done; },
    kill() { try { p.kill("SIGKILL"); } catch { /* already gone */ } },
  };
}

const TMP_PREFIX = "bt-out-tm-";
const TMP_MAX_AGE_MS = 10 * 60_000;
/** This module reclaims its own temp clips: anything older than ten minutes
 *  has long been uploaded. Best-effort, and only files with OUR prefix. */
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

/** The trending clip → { type: "animation", source: <mp4> }, or null on any failure. */
async function render(coin, logoBuffer, { badge = null, design = null, outPath = null, cancel = null, count = FRAMES } = {}) {
  const t0 = Date.now();
  let file = null;
  try {
    if (!kit.canvasLib()) {
      log.warn("[trendingMotion] @napi-rs/canvas unavailable — trending clip skipped");
      return null;
    }
    if (!outPath) sweepTmp().catch(() => {});
    file = outPath || path.join(os.tmpdir(), `${TMP_PREFIX}${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}.mp4`);
    const enc = encoder(file);
    try {
      await drawFrames(coin || {}, logoBuffer, { badge, design, cancel, count, onFrame: (fr) => enc.write(fr) });
    } catch (e) {
      enc.kill();
      throw e;
    }
    await enc.end();
    const st = fss.statSync(file);
    const key = (DESIGNS[design] || DESIGNS[designFor(badge)]).key;
    log.info(`[trendingMotion] ${tickerOf(coin && coin.symbol)} rendered in ${Date.now() - t0}ms (${key}, ${Math.round(st.size / 1024)} KB)`);
    return { type: "animation", source: file };
  } catch (e) {
    log.warn(`[trendingMotion] ${tickerOf(coin && coin.symbol)} render failed after ${Date.now() - t0}ms: ${e.message}`);
    if (file) fss.promises.unlink(file).catch(() => {}); // a half-written clip is never handed on
    return null;
  }
}

// ─────────────────────────── the designs ───────────────────────────
/*
 * One design per length of trending run ("bisakah anda buatkan yang berbeda2
 * kaya 24H 48H 12H 6H design berbeda"). The copy column, the timeline and the
 * loop are the same for all four; what changes is the object the logo is set
 * in, the room it stands in, the colour, and how it comes back in:
 *
 *   ≤ 6H   watch   a chronograph, the logo is its dial — Dexvra blue: a
 *                  polished case, a blue bezel, a sunray dial with the gem at
 *                  twelve; a timer light running round the minute track, a
 *                  domed crystal, a ghost dial turning behind. It replaced a
 *                  lightning bolt the operator rejected ("6H is bad design"),
 *                  then had to be brand blue and "lebih premium"
 *   ≤ 12H  trophy  the trophy, the logo on its cup — platinum on indigo;
 *                  spotlights, a pool of light, twinkling stars, confetti
 *   ≤ 24H  flame   the approved "Blue Flame", unchanged — and the design for a
 *                  badge that names no run (a listing badge, the force-post)
 *   > 24H  crown   a gold crown on a medallion — gold on royal blue; a turning
 *                  sunburst, gold dust rising, stars
 *
 * Bump a design's `version` when its geometry or lighting changes: it names
 * the cache file, so an old march is never read for a new shape.
 */
const PAL = {
  flame: {
    accent: CY, accent2: BLUE, iconCol: "#9FF3FF", pillText: "#E6FBFF", tickerLow: "#BFEFFF",
    base: ["#0F5AA8", "#073063", "#03132A", "#01050C"], bokeh: "140,210,255",
    spark: ["120,255,200", "200,245,255"], flare: ["90,190,255", "190,240,255", "150,230,255", "80,180,255"],
  },
  watch: {
    accent: CY, accent2: BLUE, iconCol: "#9FF3FF", pillText: "#E6FBFF", tickerLow: "#BFEFFF",
    base: ["#1262C2", "#0A3577", "#041634", "#01050E"], bokeh: "140,210,255",
    spark: ["140,235,255", "205,245,255"], flare: ["90,190,255", "190,240,255", "150,230,255", "80,180,255"],
  },
  trophy: {
    accent: "#A5B4FC", accent2: "#6D5DF5", iconCol: "#D4DCFF", pillText: "#EEF0FF", tickerLow: "#D9DEFF",
    base: ["#3A3AA6", "#202063", "#0C0B2B", "#03030C"], bokeh: "170,180,255",
    spark: ["205,195,255", "232,236,255"], flare: ["130,140,255", "222,226,255", "182,190,255", "110,120,255"],
  },
  crown: {
    accent: "#FCD34D", accent2: "#3B82F6", iconCol: "#FDE68A", pillText: "#FFF8E1", tickerLow: "#FDECB0",
    base: ["#1E4BB8", "#13286B", "#08102E", "#02040C"], bokeh: "255,214,128",
    spark: ["255,226,140", "255,246,214"], flare: ["255,200,90", "255,242,205", "255,226,150", "255,190,80"],
  },
};
const DESIGNS = {
  watch: {
    key: "watch", version: 1, sdf: watchSdf, rot: [-0.12, -0.34, -0.05], view: 2.5,
    logo: { cx: 0, cy: WT.cy, r: WT.L }, q: (m) => (m === 2 ? 0 : 1),
    mats: [{ c: [0.2, 0.5, 1.0], rough: 0.16 }, { c: [0.9, 0.94, 1.0], rough: 0.05 }],
    rim: [0.04, 0.5, 0.75], studio: { side: [0.2, 1.2, 1.7], left: [0.75, 0.85, 1.05] },
    sway: false, float: 5, pal: PAL.watch,
    back: drawWatchBack, ambient: drawMotes, front: drawWatchFront, ignite: null, icon: watchIcon,
  },
  trophy: {
    key: "trophy", version: 1, sdf: trophySdf, rot: [-0.2, -0.32, -0.04], view: 2.5,
    logo: { cx: 0, cy: TR.ly, r: TR.lr }, q: (m) => (m === 2 ? 1 : 0),
    mats: [{ c: [0.9, 0.92, 1.0], rough: 0.08 }, { c: [0.36, 0.34, 0.62], rough: 0.3 }],
    rim: [0.3, 0.3, 0.7], studio: { side: [0.7, 0.6, 1.6], left: [0.8, 0.8, 1.05] },
    sway: false, float: 5, pal: PAL.trophy,
    back: drawSpots, ambient: drawTwinkles, ignite: drawConfetti, icon: trophyIcon,
  },
  flame: {
    key: "flame", version: 1, sdf: flameSdf, rot: [-0.12, -0.36, -0.05], view: 2.55,
    logo: { cx: FL.cx, cy: FL.cy, r: FL.r }, q: (m) => (m === 1 ? 1 : 0),
    mats: [{ c: [0.25, 0.55, 1.0], rough: 0.22 }, { c: [0.88, 0.93, 1.0], rough: 0.08 }],
    rim: [0.04, 0.5, 0.7], studio: { side: [0.2, 1.2, 1.6], left: [0.7, 0.8, 1.0] },
    sway: true, float: 0, pal: PAL.flame,
    back: drawBacklight, ambient: (ctx, t) => drawEmbers(ctx, t), ignite: null, icon: flameIcon,
  },
  crown: {
    key: "crown", version: 1, sdf: crownSdf, rot: [-0.22, -0.34, -0.04], view: 2.55,
    logo: { cx: 0, cy: CR.mc, r: CR.mr - 0.2 }, q: (m) => (m === 4 ? 1 : 0),
    mats: [{ c: [1.0, 0.76, 0.32], rough: 0.14 }, { c: [0.3, 0.6, 1.0], rough: 0.05 }],
    rim: [0.25, 0.35, 0.65], studio: { side: [1.3, 1.05, 0.6], left: [0.9, 0.85, 0.8] },
    sway: false, float: 5, pal: PAL.crown,
    back: drawRays, ambient: drawDust, ignite: null, icon: crownIcon,
  },
};
/** "Trending 6H" → watch, 12H → trophy, 24H → flame, 48H → crown. A run in
 *  between takes the next design up (3H the watch, 16H and 18H the flame); a
 *  badge that names no run (a listing tier, nothing at all) is the flame. */
function designFor(badge) {
  const m = /trending\s*(\d+)\s*h/i.exec(String(badge || ""));
  const h = m ? Number(m[1]) : 0;
  if (!h) return "flame";
  if (h <= 6) return "watch";
  if (h <= 12) return "trophy";
  if (h <= 24) return "flame";
  return "crown";
}

/** TRENDING_MOTION=0 restores the old ladder exactly. Blank or unset is ON. */
const enabled = () => sourceEnabled("TRENDING_MOTION");

module.exports = {
  render,
  enabled,
  frames,
  W,
  H,
  FPS,
  FRAMES,
  SECONDS,
  LABEL_MIN,
  _drawFrames: drawFrames,
  DESIGN_KEYS: Object.keys(DESIGNS),
  _designFor: designFor,
  _flameBody: () => bodyFor("flame"),
  _bodyFor: bodyFor,
  _designs: DESIGNS,
  _cacheFile: cacheFile,
  _projector: projector,
  _sweepAt: sweepAt,
  _sweepTmp: sweepTmp,
  _pillOf: pillOf,
  _realFigure: realFigure,
  _timeline: { HOLD, OUTE, IN0, IGN },
  _layout: { CX, PANEL_Y, OX, OY, FS },
};
