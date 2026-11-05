/**
 * The TRENDING clip: "Blue Flame" — a 3D flame in satin blue metal with a
 * chrome ring, the token's own logo set into its bulb. Concept A of three
 * (flame · trophy · crown), picked by the operator ("A. Api") after the pump
 * gauge was approved. Like the gauge, the look is a decision: change it only
 * with a new approval.
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

// ─────────────────────────── the 3D flame ───────────────────────────
const FS = 560; // sprite size
const FSS = 2; // supersampling per axis
const FLAME_VERSION = 1; // bump when the geometry or the lighting changes (invalidates the cache)
const FL = { cx: 0, cy: -0.62, rL: 0.8 }; // the logo disc in the bulb

const smin = (a, b, k) => { const h = clamp(0.5 + (0.5 * (b - a)) / k); return mix(b, a, h) - k * h * (1 - h); };
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
// materials: 6 satin blue metal (the body), 1 chrome (the ring), 3 the logo
function sdfL(x, y, z, out) {
  const d2 = flame2(x, y);
  const t = 0.34, rr = 0.3;
  const wx = d2 + rr, wy = Math.abs(z) - t + rr;
  let d = Math.min(Math.max(wx, wy), 0) + len2(Math.max(wx, 0), Math.max(wy, 0)) - rr;
  let m = 6;
  const rl = len2(x - FL.cx, y - FL.cy);
  const zf = 0.32; // the front surface round the bulb's centre
  const rec = Math.max(rl - FL.rL, -(z - (zf - 0.06)));
  d = Math.max(d, -rec);
  const disc = Math.max(rl - FL.rL, Math.abs(z - (zf - 0.06)) - 0.014);
  if (disc < d) { d = disc; m = 3; }
  const ring = len2(rl - (FL.rL + 0.03), z - zf) - 0.065;
  if (ring < d) { d = ring; m = 1; }
  if (out) out.m = m;
  return d;
}
// turned a little toward the copy (right), the top leaning back
const RX = -0.12, RY = -0.36, RZ = -0.05;
const cX = Math.cos(RX), sX = Math.sin(RX), cYr = Math.cos(RY), sYr = Math.sin(RY), cZ = Math.cos(RZ), sZ = Math.sin(RZ);
function toLocal(x, y, z) {
  const x1 = cZ * x + sZ * y, y1 = -sZ * x + cZ * y, z1 = z;
  const x2 = cYr * x1 - sYr * z1, z2 = sYr * x1 + cYr * z1, y2 = y1;
  const y3 = cX * y2 + sX * z2, z3 = -sX * y2 + cX * z2;
  return [x2, y3, z3];
}
const sdfW = (x, y, z, out) => { const p = toLocal(x, y, z); return sdfL(p[0], p[1], p[2], out); };
const CAM = 24;
const VIEW = 2.55;

function normal(x, y, z) {
  const e = 0.0015;
  const a = sdfW(x + e, y - e, z - e), b = sdfW(x - e, y - e, z + e), c = sdfW(x - e, y + e, z - e), d = sdfW(x + e, y + e, z + e);
  const nx = a - b - c + d, ny = -a - b + c + d, nz = -a + b - c + d, l = len3(nx, ny, nz) || 1;
  return [nx / l, ny / l, nz / l];
}
function occlusion(x, y, z, n) {
  let o = 0, w = 1;
  for (let i = 1; i <= 5; i++) { const h = 0.05 * i; o += w * (h - sdfW(x + n[0] * h, y + n[1] * h, z + n[2] * h)); w *= 0.6; }
  return clamp(1 - 2.5 * o);
}
/** The studio the metal reflects: a softbox overhead, a cyan kicker on the
 *  right, a cool fill on the left, a hard little sun and a thin strip light. */
function env(rx, ry, rz, out = [0, 0, 0]) {
  let r = 0.01, g = 0.015, b = 0.03;
  const top = clamp((ry - 0.56) / 0.16) * clamp((0.95 - ry) / 0.1);
  r += 1.8 * top; g += 1.9 * top; b += 2.05 * top;
  const side = clamp((rx - 0.6) / 0.12) * clamp(1 - Math.abs(ry - 0.05) / 0.5); r += 0.2 * side; g += 1.2 * side; b += 1.6 * side;
  const left = clamp((-rx - 0.55) / 0.15) * clamp(1 - Math.abs(ry - 0.2) / 0.5); r += 0.7 * left; g += 0.8 * left; b += 1.0 * left;
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

// per metal sample: R (3), occ, ndv, the fixed lamps' specular (3), count
const MS = 9;
const METALS = [6, 1]; // q = 0 the body, q = 1 the chrome ring
const MAT = { 6: { c: [0.25, 0.55, 1.0], rough: 0.22 }, 1: { c: [0.88, 0.93, 1.0], rough: 0.08 } };

/** March the flame. Async: it yields every few rows so the bot keeps answering. */
async function marchFlame() {
  const N = FS * FSS;
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
      const n = normal(px, py, pz), occ = occlusion(px, py, pz, n);
      const vx = -dx, vy = -dy, vz = -dz;
      const ndv = clamp(n[0] * vx + n[1] * vy + n[2] * vz);
      const kk = 2 * (n[0] * dx + n[1] * dy + n[2] * dz);
      const R = [dx - kk * n[0], dy - kk * n[1], dz - kk * n[2]];
      const sp = (L) => { const hx = L[0] + vx, hy = L[1] + vy, hz = L[2] + vz, hl = len3(hx, hy, hz) || 1; return clamp((n[0] * hx + n[1] * hy + n[2] * hz) / hl); };
      if (m === 3) {
        const p = toLocal(px, py, pz);
        const d1 = clamp(n[0] * L1[0] + n[1] * L1[1] + n[2] * L1[2]), d2 = clamp(n[0] * L2[0] + n[1] * L2[1] + n[2] * L2[2]);
        const fres = 0.04 + 0.96 * Math.pow(1 - ndv, 5);
        env(R[0], R[1], R[2], ev);
        lA[oi * 5] += ((p[0] - FL.cx) / FL.rL) * 0.5 + 0.5;
        lA[oi * 5 + 1] += 0.5 - ((p[1] - FL.cy) / FL.rL) * 0.5;
        lA[oi * 5 + 2] += 1;
        lA[oi * 5 + 3] += Math.min(1.25, 0.35 + occ * (0.55 + 0.6 * d1 + 0.15 * d2) * 1.15);
        lA[oi * 5 + 4] += (1.1 * Math.pow(sp(L1), 120) + ev[1] * fres * 0.8) * 0.55;
        continue;
      }
      const q = m === 1 ? 1 : 0, rough = MAT[METALS[q]].rough;
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
const cacheFile = () => path.join(os.tmpdir(), `dexvra-trendflame-v${FLAME_VERSION}-${FS}x${FSS}.bin`);
const serialise = (g) => Buffer.concat([Buffer.from(CACHE_MAGIC), Buffer.from(g.metal.buffer), g.logo]);
function deserialise(b) {
  const nMetal = FS * FS * 2 * MS * 4, nLogo = FS * FS * 7;
  if (b.length !== 4 + nMetal + nLogo || b.toString("latin1", 0, 4) !== CACHE_MAGIC) return null;
  const metal = new Float32Array(b.buffer.slice(b.byteOffset + 4, b.byteOffset + 4 + nMetal));
  return { metal, logo: Buffer.from(b.subarray(4 + nMetal)) };
}
/** The prepared flame, for the per-frame passes:
 *   metalPx/mets  every pixel the metal touches, per kind the reflection vector
 *                 with the material's constants folded in (only the studio
 *                 swings, so only env() is per frame);
 *   logoL         every pixel the logo touches: uv, coverage, light, coat;
 *   bulb          where the logo sits in the sprite, so the sway can leave it be. */
function prepare(g) {
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
      const { c: mat, rough } = MAT[METALS[q]];
      const refl = (0.95 * (1 - rough * 0.6) + fres * 0.5);
      const rim = Math.pow(1 - ndv, 3) * 0.36;
      const k = [0, 1, 2].map((c) => refl * mat[c] * occ);
      const ad = [0, 1, 2].map((c) => [0.04, 0.5, 0.7][c] * rim + metal[o + 5 + c] / cnt);
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
  const bulb = sn ? { x: sx / sn, y: sy / sn, top } : { x: FS / 2, y: FS * 0.62, top: FS * 0.45 };
  return { metalPx: Int32Array.from(metalPx), mets: Float32Array.from(mets), logoL: Float32Array.from(logoL), bulb };
}
let flameP = null;
/** The flame, prepared: from memory, else the tmp cache, else a fresh march. */
function flameBody() {
  if (!flameP) {
    flameP = (async () => {
      let g = null;
      try { g = deserialise(await fss.promises.readFile(cacheFile())); } catch { g = null; }
      if (!g) {
        const t0 = Date.now();
        g = await marchFlame();
        log.info(`[trendingMotion] flame ray-marched in ${Date.now() - t0}ms`);
        const tmp = `${cacheFile()}.${process.pid}.tmp`;
        fss.promises.writeFile(tmp, serialise(g)).then(() => fss.promises.rename(tmp, cacheFile())).catch(() => fss.promises.unlink(tmp).catch(() => {}));
      }
      return prepare(g);
    })().catch((e) => { flameP = null; throw e; });
  }
  return flameP;
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
const OX = 50; // the flame sprite's place
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

function baseLayer(cv) {
  const c = cv.createCanvas(W + 160, H + 80), x = c.getContext("2d");
  const g = x.createRadialGradient(OC.x + 80, OC.y + 40, 20, OC.x + 200, OC.y + 40, 1040);
  g.addColorStop(0, "#0F5AA8"); g.addColorStop(0.28, "#073063"); g.addColorStop(0.62, "#03132A"); g.addColorStop(1, "#01050C");
  x.fillStyle = g; x.fillRect(0, 0, W + 160, H + 80);
  return c;
}
/** The flame's own light on the room: a heat glow behind it that breathes. */
function drawBacklight(ctx, t, boost) {
  ctx.save(); ctx.globalCompositeOperation = "lighter";
  const k = 0.85 + 0.15 * flicker(t) + 0.8 * boost;
  const hg = ctx.createRadialGradient(OC.x, OC.y + 30, 10, OC.x, OC.y - 40, 380);
  hg.addColorStop(0, hexA(CY, 0.3 * k)); hg.addColorStop(0.5, hexA(BLUE, 0.11 * k)); hg.addColorStop(1, hexA(BLUE, 0));
  ctx.fillStyle = hg; ctx.fillRect(OC.x - 400, OC.y - 440, 800, 880);
  // a soft column of heat rising off the tips
  const cg = ctx.createLinearGradient(0, OY - 40, 0, OC.y);
  cg.addColorStop(0, hexA(CY, 0)); cg.addColorStop(1, hexA(CY, 0.08 * k));
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
function softSprite(cv, blur) {
  const c = cv.createCanvas(160, 160), x = c.getContext("2d");
  x.filter = `blur(${blur}px)`; x.fillStyle = "rgba(140,210,255,1)"; x.beginPath(); x.arc(80, 80, 48, 0, TAU); x.fill(); x.filter = "none";
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
const CX = 690; // the copy column
/** The fixed chrome: brand, the network chip, the footer handles. */
function chromeLayer(cv, chain) {
  const c = cv.createCanvas(W, H), ctx = c.getContext("2d");
  drawBrandMark(ctx, CX, 44, 38);
  ctx.textBaseline = "alphabetic"; ctx.fillStyle = "#F1F5FB"; ctx.font = `800 27px ${F.x}`; ctx.fillText("Dexvra", CX + 50, 72);
  const ct = String(chain || "").toUpperCase().slice(0, 20);
  if (ct) {
    ctx.font = `700 ${LABEL_MIN}px ${F.m7}`;
    const cw = trackedW(ctx, ct, 2.6) + 40;
    roundRect(ctx, W - 60 - cw, 46, cw, 36, 18); ctx.fillStyle = "rgba(10,30,56,0.6)"; ctx.fill();
    ctx.strokeStyle = hexA(CY, 0.5); ctx.lineWidth = 1.2; ctx.stroke();
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
function flare(ctx, x, y, f) {
  if (f <= 0.01) return;
  ctx.save(); ctx.globalCompositeOperation = "lighter";
  const g = ctx.createLinearGradient(x - 420, 0, x + 420, 0);
  g.addColorStop(0, "rgba(90,190,255,0)"); g.addColorStop(0.5, `rgba(190,240,255,${0.8 * f})`); g.addColorStop(1, "rgba(90,190,255,0)");
  ctx.fillStyle = g; ctx.fillRect(x - 420, y - 1.5, 840, 3);
  ctx.globalAlpha = 0.35 * f; ctx.fillRect(x - 300, y - 6, 600, 12); ctx.globalAlpha = 1;
  const r = ctx.createRadialGradient(x, y, 0, x, y, 120);
  r.addColorStop(0, `rgba(255,255,255,${f})`); r.addColorStop(0.25, `rgba(150,230,255,${0.6 * f})`); r.addColorStop(1, "rgba(80,180,255,0)");
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
function drawCopy(ctx, t, L, f) {
  // the pill
  masked(ctx, t, 0.25, 0.45, 132, 194, (c) => {
    c.font = `700 18px ${F.m7}`;
    const pw = trackedW(c, L.pill, 4) + 68;
    roundRect(c, CX, 140, pw, 44, 22);
    const pg = c.createLinearGradient(CX, 0, CX + pw, 0); pg.addColorStop(0, hexA(CY, 0.28)); pg.addColorStop(1, hexA(BLUE, 0.18));
    c.fillStyle = pg; c.fill(); c.strokeStyle = hexA(CY, 0.7); c.lineWidth = 1.4; c.stroke();
    const pulse = 0.6 + 0.4 * Math.sin((TAU * 3 * t) / SECONDS);
    c.shadowColor = CY; c.shadowBlur = 8 + 10 * pulse; flameIcon(c, CX + 28, 163, 13, "#9FF3FF"); c.shadowBlur = 0;
    c.fillStyle = "#E6FBFF"; c.textBaseline = "middle"; tracked(c, L.pill, CX + 48, 163, 4);
  });
  // the ticker, letter by letter
  let x = CX - 4;
  [...L.sym].forEach((ch, i) => {
    ctx.font = `800 ${L.ts}px ${F.x}`;
    const w = ctx.measureText(ch).width, cx = x;
    masked(ctx, t, 0.35 + i * 0.045, 0.45, 196, 312, (c) => {
      c.font = `800 ${L.ts}px ${F.x}`; c.textBaseline = "alphabetic";
      const tg = c.createLinearGradient(0, 290 - L.ts * 0.74, 0, 290); tg.addColorStop(0, "#FFFFFF"); tg.addColorStop(1, "#BFEFFF");
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
      c.fillStyle = g2; c.fill(); c.strokeStyle = hexA(CY, 0.3); c.lineWidth = 1.2; c.stroke();
      const run = (t - 2.2) / 1.2; // a light running round the panel, once a loop
      if (run > 0 && run < 1) {
        const cg = c.createConicGradient(TAU * run - Math.PI / 2, CX + L.PW / 2, PANEL_Y + PANEL_H / 2);
        cg.addColorStop(0, hexA(CY, 0)); cg.addColorStop(0.06, hexA(CY, 0.95)); cg.addColorStop(0.12, hexA(CY, 0)); cg.addColorStop(1, hexA(CY, 0));
        roundRect(c, CX, PANEL_Y, L.PW, PANEL_H, 18); c.strokeStyle = cg; c.lineWidth = 2; c.stroke();
      }
      L.cells.forEach(([k, v], i) => {
        const cx = CX + i * L.cw + 24;
        if (i) { c.strokeStyle = hexA(CY, 0.18); c.lineWidth = 1.2; c.beginPath(); c.moveTo(CX + i * L.cw, PANEL_Y + 20); c.lineTo(CX + i * L.cw, PANEL_Y + PANEL_H - 20); c.stroke(); }
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
async function drawFrames(coin, logoBuffer, { count = FRAMES, times = null, badge = null, onFrame, cancel = null } = {}) {
  const cv = kit.canvasLib();
  if (!cv) return false;
  coin = coin || {};
  warnBoxes("trending-motion", { symbol: coin.symbol, name: coin.name });
  let img = null;
  if (logoBuffer) { try { img = await cv.loadImage(logoBuffer); } catch { img = null; } } // an unreadable logo draws the monogram
  const body = await flameBody();
  const L = copyLayout(cv, coin, badge);
  const LT = 256, lt = logoTexture(cv, img, coin.symbol);
  const BASE = baseLayer(cv), SHADE = shadeLayer(cv), CHROME = chromeLayer(cv, coin.chain), MID = softSprite(cv, 6), FG = softSprite(cv, 22);
  const sprite = cv.createCanvas(FS, FS), sx = sprite.getContext("2d"), sid = sx.createImageData(FS, FS);
  const warp = cv.createCanvas(FS + 40, FS), wx = warp.getContext("2d");
  const half = cv.createCanvas(FS / 2, FS / 2), hx = half.getContext("2d");
  let shadow = null; // the silhouette barely changes: its drop shadow is made once
  const out = cv.createCanvas(W, H), ctx = out.getContext("2d");
  const { metalPx, mets, logoL, bulb } = body;
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
        env(rx * cyw - rz * syw, ry, rx * syw + rz * cyw, ev);
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
    // the sway: thin strips, offset more toward the tips
    wx.globalCompositeOperation = "source-over"; wx.clearRect(0, 0, FS + 40, FS);
    for (let y = 0; y < FS; y += 2) {
      const dx = y < anchor ? swayAt(y, t) : 0;
      wx.drawImage(sprite, 0, y, FS, 2, 20 + dx, y, FS, 2);
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
    drawBacklight(ctx, t, boost);
    ctx.setTransform(cam.s, 0, 0, cam.s, OC.x * (1 - cam.s) + cam.dx, OC.y * (1 - cam.s) + cam.dy);
    drawEmbers(ctx, t);
    // the flame, scaled about its bulb (burning low, re-igniting)
    ctx.save();
    ctx.translate(bulbX, bulbY); ctx.scale(fs, fs); ctx.translate(-bulbX, -bulbY);
    ctx.drawImage(shadow, OX - 120, OY - 120);
    ctx.drawImage(warp, OX - 20, OY);
    // bloom: the flame's own light, blurred back over itself (at half size)
    hx.globalCompositeOperation = "copy"; hx.filter = "blur(7px)"; hx.drawImage(warp, 20, 0, FS, FS, 0, 0, FS / 2, FS / 2); hx.filter = "none";
    ctx.globalCompositeOperation = "lighter"; ctx.globalAlpha = (0.16 + 0.05 * flicker(t)) * (1 - dim) + 0.3 * boost;
    ctx.drawImage(half, OX, OY, FS, FS);
    ctx.restore();
    // ignition: a flash ring off the logo, a burst of sparks, a flare
    if (t >= IGN && boost > 0.002) {
      ctx.save(); ctx.globalCompositeOperation = "lighter";
      const u = clamp((t - IGN) / 0.8);
      if (u < 1) {
        const rr = 40 + 300 * easeOut(u);
        ctx.lineWidth = 2 + 10 * (1 - u); ctx.strokeStyle = hexA(CY, 0.85 * (1 - u));
        ctx.beginPath(); ctx.ellipse(bulbX, bulbY, rr, rr * 0.9, 0, 0, TAU); ctx.stroke();
      }
      ctx.lineCap = "round";
      for (const s of SPARKS) {
        const age = (t - IGN - s.d) / s.life;
        if (age < 0 || age > 1) continue;
        const tt = age * s.life, vx = Math.cos(s.a) * s.v, vy = Math.sin(s.a) * s.v;
        const x1 = bulbX + vx * tt, y1 = bulbY - 60 + vy * tt - 40 * tt * tt;
        ctx.strokeStyle = `rgba(${s.mint ? "120,255,200" : "200,245,255"},${(1 - age) * 0.9})`; ctx.lineWidth = s.w * (1 - age) + 0.4;
        ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x1 - vx * 0.04, y1 - vy * 0.04); ctx.stroke();
      }
      ctx.restore();
      flare(ctx, bulbX, OY + bulb.top - 30, boost);
    }
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
    drawCopy(ctx, t, L, f);
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
async function frames(coin, logoBuffer, { count = FRAMES, times = null, badge = null } = {}) {
  const list = [];
  const ok = await drawFrames(coin, logoBuffer, { count, times, badge, onFrame: (b) => list.push(Buffer.from(b)) });
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
async function render(coin, logoBuffer, { badge = null, outPath = null, cancel = null, count = FRAMES } = {}) {
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
      await drawFrames(coin || {}, logoBuffer, { badge, cancel, count, onFrame: (fr) => enc.write(fr) });
    } catch (e) {
      enc.kill();
      throw e;
    }
    await enc.end();
    const st = fss.statSync(file);
    log.info(`[trendingMotion] ${tickerOf(coin && coin.symbol)} rendered in ${Date.now() - t0}ms (${Math.round(st.size / 1024)} KB)`);
    return { type: "animation", source: file };
  } catch (e) {
    log.warn(`[trendingMotion] ${tickerOf(coin && coin.symbol)} render failed after ${Date.now() - t0}ms: ${e.message}`);
    if (file) fss.promises.unlink(file).catch(() => {}); // a half-written clip is never handed on
    return null;
  }
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
  _flameBody: flameBody,
  _cacheFile: cacheFile,
  _sweepTmp: sweepTmp,
  _pillOf: pillOf,
  _realFigure: realFigure,
  _timeline: { HOLD, OUTE, IN0, IGN },
  _layout: { CX, PANEL_Y, OX, OY, FS },
};
