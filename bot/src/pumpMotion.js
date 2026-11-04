/**
 * The PUMP ALERT clip: "Boost Gauge" — a 3D chrome speedometer whose needle
 * points at the TRUE multiple since listing, with the token's own logo as the
 * hub. Approved by the operator after thirteen rounds of stills and clips
 * ("perfect bagus"), so the look is a decision, not a draft: change it only
 * with a new approval.
 *
 * What is drawn, and where each figure comes from (pumpChecker → coin):
 *   ticker      the listing row's `sym`, spelt with exactly one "$"
 *   name        the listing row's `name`
 *   +N%         the STEP the pump alert announces (pumpChecker's milestone),
 *               the same number as the caption's — never the raw gain
 *   N×          xMultiple(step), the caption's own spelling ("2×", "2.5×")
 *   MC panel    pumpMc(baseline mcap) → pumpMc(live mcap), the caption's own
 *               spelling; an unread cap leaves its cell OUT, never "$0"
 *   network     the chain's label, top right
 *   hub         the token's logo; a monogram of the ticker when it has none
 *
 * How it is made:
 *   • the gauge BODY is ray-marched once (a signed distance field: bezel,
 *     housing, dial, hub), cached in memory and in os.tmpdir(), and the march
 *     YIELDS to the event loop every few rows — a synchronous four-second march
 *     would make the whole bot deaf (see "bot tidak bisa merespon" in CLAUDE.md);
 *   • every frame re-lights the chrome from stored reflection vectors while the
 *     studio turns, so highlights travel round the bezel like real metal;
 *   • the dial (ticks, the lit arc, the needle, the readout) is drawn flat per
 *     frame and mapped onto the dial through its UVs.
 *
 * The 6-second loop: HOLD 0–4.0 (the card, idling with an engine tremor) →
 * OUT 4.0–4.5 (the needle drops to 1×, the type leaves) → IN 4.5–6.0 (the
 * needle sweeps up with an overshoot, sparks off its tip, a lens flare as it
 * lands, the type returns masked and blur-to-sharp). Frame 0 IS the full card:
 * Telegram makes the thumbnail and the notification preview from it. The loop
 * is exact — t = 6 draws what t = 0 draws — and a test says so.
 *
 * PUMP_MOTION=0 switches it off (pumpChecker falls back to the admin pump clip,
 * then a text reply). Blank or unset is ON.
 */
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
const { spawn } = require("node:child_process");
const log = require("./helpers/logger");
const kit = require("./helpers/canvasKit");
const { CHANNELS, SITE_URL, X_LISTING_HANDLE } = require("./config/constants");
const { sourceEnabled } = require("./raid/sourceFlag");
const { xMultiple } = require("./channels/format");

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

const clamp = (v, a = 0, b = 1) => (v < a ? a : v > b ? b : v);
const mix = (a, b, t) => a + (b - a) * t;
const easeOut = (u) => 1 - Math.pow(1 - u, 3);
const easeIn = (u) => u * u * u;
const easeInOut = (u) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2);
const smooth = (a, b, x) => { const u = clamp((x - a) / (b - a)); return u * u * (3 - 2 * u); };
const OVERSHOOT = 1.4;
const easeOutBack = (u) => { const c3 = OVERSHOOT + 1; return 1 + c3 * Math.pow(u - 1, 3) + OVERSHOOT * Math.pow(u - 1, 2); };
const len3 = (x, y, z) => Math.sqrt(x * x + y * y + z * z);
const tracked = (ctx, text, x, y, t) => { for (const ch of [...String(text)]) { ctx.fillText(ch, x, y); x += ctx.measureText(ch).width + t; } };
const trackedW = (ctx, text, t) => { const cs = [...String(text)]; return cs.reduce((a, c) => a + ctx.measureText(c).width, 0) + t * Math.max(0, cs.length - 1); };
const tickerOf = (symbol) => `$${String(symbol || "").replace(/^\$+/, "").toUpperCase()}`;
const hostOf = (url) => String(url || "").replace(/^https?:\/\//, "").replace(/\/.*$/, "");

// ─────────────────────────── the 3D gauge body ───────────────────────────
// Local space: the dial faces +Z, centre at the origin. Ray-marched ONCE.
const GS = 600; // sprite size
const GSS = 2; // supersampling per axis
const GAUGE_VERSION = 1; // bump when the geometry or the lighting changes (invalidates the cache)
const RF = 2.55; // dial radius
const HUB = 0.74; // hub dome radius

function rbox2(px, py, bx, by, r) {
  const qx = Math.abs(px) - bx + r, qy = Math.abs(py) - by + r;
  return Math.min(Math.max(qx, qy), 0) + Math.sqrt(Math.max(qx, 0) ** 2 + Math.max(qy, 0) ** 2) - r;
}
const bezel = (x, y, z) => rbox2(Math.sqrt(x * x + y * y) - 2.8, z - 0.035, 0.3, 0.385, 0.16);
const housing = (x, y, z) => rbox2(Math.sqrt(x * x + y * y) - 1.4, z + 0.55, 1.62, 0.3, 0.12);
const face = (x, y, z) => Math.max(Math.sqrt(x * x + y * y) - RF, Math.abs(z + 0.12) - 0.05);
function hub(x, y, z) {
  // a LOW dome: a big sphere cut flat, so the logo is barely curved
  const Rs = 1.6, zc = -0.07 - Math.sqrt(Rs * Rs - HUB * HUB);
  return Math.max(len3(x, y, z - zc) - Rs, -(z + 0.07));
}
// materials: 1 bezel (chrome), 2 housing (dark metal), 3 dial, 4 hub
function sdfL(x, y, z, out) {
  let d = bezel(x, y, z), m = 1;
  const h = housing(x, y, z); if (h < d) { d = h; m = 2; }
  const f = face(x, y, z); if (f < d) { d = f; m = 3; }
  const u = hub(x, y, z); if (u < d) { d = u; m = 4; }
  if (out) out.m = m;
  return d;
}
// tilt: the top leans back, the face turns toward the copy (left)
const RX = (-24 * Math.PI) / 180, RY = (26 * Math.PI) / 180, RZ = (4 * Math.PI) / 180;
const cX = Math.cos(RX), sX = Math.sin(RX), cY = Math.cos(RY), sY = Math.sin(RY), cZ = Math.cos(RZ), sZ = Math.sin(RZ);
function toLocal(x, y, z) {
  const x1 = cZ * x + sZ * y, y1 = -sZ * x + cZ * y, z1 = z;
  const x2 = cY * x1 - sY * z1, z2 = sY * x1 + cY * z1, y2 = y1;
  const y3 = cX * y2 + sX * z2, z3 = -sX * y2 + cX * z2;
  return [x2, y3, z3];
}
const sdfW = (x, y, z, out) => { const p = toLocal(x, y, z); return sdfL(p[0], p[1], p[2], out); };
const CAM = [0, 0, 24];
const VIEW = 3.75;

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
/** The studio the metal reflects. `glint` adds the hard little sun and the
 *  thin strip the per-frame re-light uses; the march's own lighting omits them. */
function env(rx, ry, rz, glint, out = [0, 0, 0]) {
  let r = 0.01, g = 0.015, b = 0.03;
  const top = glint ? clamp((ry - 0.56) / 0.16) * clamp((0.95 - ry) / 0.1) : clamp((ry - 0.5) / 0.22) * clamp((0.97 - ry) / 0.1);
  const kt = glint ? [1.8, 1.9, 2.05] : [1.7, 1.8, 1.95];
  r += kt[0] * top; g += kt[1] * top; b += kt[2] * top;
  const side = clamp((rx - 0.6) / 0.12) * clamp(1 - Math.abs(ry - 0.05) / 0.5); r += 0.2 * side; g += 1.2 * side; b += 1.6 * side;
  const left = clamp((-rx - 0.55) / 0.15) * clamp(1 - Math.abs(ry - 0.2) / 0.5); r += 0.7 * left; g += 0.8 * left; b += 1.0 * left;
  const fl = clamp((-ry - 0.3) / 0.5); r += 0.02 * fl; g += 0.07 * fl; b += 0.15 * fl;
  if (glint) {
    // the sun only where it can show: below 0.97, pow(·, 260) is < 0.0004 anyway
    const sd = rx * -0.42 + ry * 0.62 + rz * 0.66;
    if (sd > 0.97) { const sun = Math.pow(sd, 260) * 6; r += sun; g += sun; b += sun; }
    const strip = clamp((rx - 0.27) / 0.025) * clamp((0.31 - rx) / 0.025) * clamp((ry - 0.05) / 0.3);
    r += 0.7 * strip; g += 0.8 * strip; b += 0.9 * strip;
  }
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
// the per-frame re-light tones ~200k samples a frame: a table, not a pow
const TONE_N = 4096, TONE_MAX = 16;
const TONE_LUT = (() => { const t = new Float32Array(TONE_N + 1); for (let i = 0; i <= TONE_N; i++) t[i] = tone((i / TONE_N) * TONE_MAX); return t; })();
const toneFast = (c) => TONE_LUT[c <= 0 ? 0 : c >= TONE_MAX ? TONE_N : ((c * (TONE_N / TONE_MAX)) | 0)];

function shadeHit(px, py, pz, rd, m) {
  const n = normal(px, py, pz), occ = occlusion(px, py, pz, n);
  const vx = -rd[0], vy = -rd[1], vz = -rd[2];
  const ndv = clamp(n[0] * vx + n[1] * vy + n[2] * vz);
  const k = 2 * (n[0] * rd[0] + n[1] * rd[1] + n[2] * rd[2]);
  const R = [rd[0] - k * n[0], rd[1] - k * n[1], rd[2] - k * n[2]];
  const e = env(R[0], R[1], R[2], false);
  const d1 = clamp(n[0] * L1[0] + n[1] * L1[1] + n[2] * L1[2]), d2 = clamp(n[0] * L2[0] + n[1] * L2[1] + n[2] * L2[2]);
  const sp = (L) => { const hx = L[0] + vx, hy = L[1] + vy, hz = L[2] + vz, hl = len3(hx, hy, hz) || 1; return clamp((n[0] * hx + n[1] * hy + n[2] * hz) / hl); };
  const fres = 0.04 + 0.96 * Math.pow(1 - ndv, 5);
  const base = [0.5, 0.5, 0.5], metal = 0, rough = m === 3 ? 0.3 : 0.05;
  let r = base[0] * (0.1 + 1.1 * d1 + 0.3 * d2) * occ, g = r, b = r;
  const refl = mix(0.05, 0.95, metal) * (1 - rough * 0.6) + fres * 0.5;
  r += e[0] * refl * occ; g += e[1] * refl * occ; b += e[2] * refl * occ;
  const p1 = Math.pow(sp(L1), mix(240, 30, rough)), p2 = Math.pow(sp(L2), mix(150, 20, rough));
  r += 1.1 * p1 + 0.2 * p2; g += 1.1 * p1 + 0.8 * p2; b += 1.15 * p1 + 1.0 * p2;
  return { c: [r, g, b], light: occ * (0.55 + 0.6 * d1 + 0.15 * d2), coat: 1.1 * p1 + 0.3 * p2 + e[1] * fres * 0.8, n, occ, ndv, R };
}

/** March the body. Async: it yields every few rows so the bot keeps answering. */
async function marchGauge() {
  const N = GS * GSS, n2 = GSS * GSS;
  const stat = new Float32Array(GS * GS * 4);
  const metal = new Float32Array(GS * GS * 2 * 6);
  const fA = new Float32Array(GS * GS * 5), hA = new Float32Array(GS * GS * 5);
  const hit = { m: 0 };
  for (let j = 0; j < N; j++) {
    if (j % 12 === 0) await new Promise((r) => setImmediate(r));
    for (let i = 0; i < N; i++) {
      const sx = ((i + 0.5) / N) * 2 - 1, sy = 1 - ((j + 0.5) / N) * 2;
      let dx = sx * VIEW - CAM[0], dy = sy * VIEW - CAM[1], dz = -CAM[2];
      const dl = len3(dx, dy, dz); dx /= dl; dy /= dl; dz /= dl;
      let t = 18, ok = false, px = 0, py = 0, pz = 0;
      for (let k = 0; k < 140; k++) {
        px = CAM[0] + dx * t; py = CAM[1] + dy * t; pz = CAM[2] + dz * t;
        const d = sdfW(px, py, pz, null);
        if (d < 0.0006 * t) { ok = true; break; }
        t += d * 0.85;
        if (t > 32) break;
      }
      if (!ok) continue;
      const oi = Math.floor(j / GSS) * GS + Math.floor(i / GSS);
      sdfW(px, py, pz, hit);
      const m = hit.m;
      const s = shadeHit(px, py, pz, [dx, dy, dz], m);
      if (m === 1 || m === 2) {
        const o = (oi * 2 + (m - 1)) * 6;
        metal[o] += s.R[0]; metal[o + 1] += s.R[1]; metal[o + 2] += s.R[2];
        metal[o + 3] += s.occ; metal[o + 4] += s.ndv; metal[o + 5] += 1;
      } else {
        stat[oi * 4] += tone(s.c[0]); stat[oi * 4 + 1] += tone(s.c[1]); stat[oi * 4 + 2] += tone(s.c[2]); stat[oi * 4 + 3] += 1;
        const p = toLocal(px, py, pz), A = m === 3 ? fA : hA, R = m === 3 ? RF : HUB;
        A[oi * 5] += (p[0] / R) * 0.5 + 0.5; A[oi * 5 + 1] += 0.5 - (p[1] / R) * 0.5; A[oi * 5 + 2] += 1;
        A[oi * 5 + 3] += s.light; A[oi * 5 + 4] += s.coat;
      }
    }
  }
  // 7 bytes a pixel: u, v as 16-bit (8-bit UVs are 256 steps across the dial,
  // which renders every tick and digit as a staircase), coverage, light, coat
  const pack = (A) => {
    const b = Buffer.alloc(GS * GS * 7);
    for (let p = 0; p < GS * GS; p++) {
      const w = A[p * 5 + 2]; if (!w) continue;
      b.writeUInt16LE(Math.round(clamp(A[p * 5] / w) * 65535), p * 7);
      b.writeUInt16LE(Math.round(clamp(A[p * 5 + 1] / w) * 65535), p * 7 + 2);
      b[p * 7 + 4] = Math.round((w / n2) * 255);
      b[p * 7 + 5] = Math.round(clamp(A[p * 5 + 3] / w / 1.4) * 255);
      b[p * 7 + 6] = Math.round(clamp(A[p * 5 + 4] / w) * 255);
    }
    return b;
  };
  return { stat, metal, face: pack(fA), hub: pack(hA) };
}

const CACHE_MAGIC = "DXPG";
const cacheFile = () => path.join(os.tmpdir(), `dexvra-pumpgauge-v${GAUGE_VERSION}-${GS}x${GSS}.bin`);
function serialise(g) {
  return Buffer.concat([Buffer.from(CACHE_MAGIC), Buffer.from(g.stat.buffer), Buffer.from(g.metal.buffer), g.face, g.hub]);
}
function deserialise(b) {
  const nStat = GS * GS * 4 * 4, nMetal = GS * GS * 12 * 4, nMap = GS * GS * 7;
  if (b.length !== 4 + nStat + nMetal + nMap * 2 || b.toString("latin1", 0, 4) !== CACHE_MAGIC) return null;
  let o = 4;
  const stat = new Float32Array(b.buffer.slice(b.byteOffset + o, b.byteOffset + o + nStat)); o += nStat;
  const metal = new Float32Array(b.buffer.slice(b.byteOffset + o, b.byteOffset + o + nMetal)); o += nMetal;
  const faceB = Buffer.from(b.subarray(o, o + nMap)); o += nMap;
  const hubB = Buffer.from(b.subarray(o, o + nMap));
  return { stat, metal, face: faceB, hub: hubB };
}
/** The prepared body, for the per-frame passes:
 *   base   the RGBA of every pixel with NO metal in it — final, drawn once;
 *   mixed  every pixel the chrome touches: its static colour sum and count, and
 *          per metal sample the reflection vector with the material's constants
 *          already folded in (only the studio turns, so only env() is per frame). */
function prepare(g) {
  const { stat, metal } = g;
  const n2 = GSS * GSS;
  const base = new Uint8ClampedArray(GS * GS * 4);
  const mixed = [], mixedPx = [], mets = [];
  const BEZ = [0.88, 0.93, 1.0], HOU = [0.05, 0.1, 0.18];
  for (let p = 0; p < GS * GS; p++) {
    const cs = stat[p * 4 + 3], cb = metal[p * 12 + 5], ch = metal[p * 12 + 11];
    if (!(cs + cb + ch)) continue;
    if (!(cb + ch)) {
      base[p * 4] = (stat[p * 4] / cs) * 255; base[p * 4 + 1] = (stat[p * 4 + 1] / cs) * 255; base[p * 4 + 2] = (stat[p * 4 + 2] / cs) * 255; base[p * 4 + 3] = (cs / n2) * 255;
      continue;
    }
    mixedPx.push(p);
    mixed.push(stat[p * 4], stat[p * 4 + 1], stat[p * 4 + 2], cs);
    for (let q = 0; q < 2; q++) {
      const o = (p * 2 + q) * 6, cnt = metal[o + 5];
      if (!cnt) { mets.push(0, 0, 0, 0, 0, 0, 0, 0, 0, 0); continue; }
      let rx = metal[o] / cnt, ry = metal[o + 1] / cnt, rz = metal[o + 2] / cnt;
      const rl = Math.hypot(rx, ry, rz) || 1; rx /= rl; ry /= rl; rz /= rl;
      const occ = metal[o + 3] / cnt, ndv = metal[o + 4] / cnt;
      const fres = 0.04 + 0.96 * Math.pow(1 - ndv, 5);
      const mat = q === 0 ? BEZ : HOU, met = q === 0 ? 1 : 0.8, rough = q === 0 ? 0.08 : 0.35;
      // the housing is dark painted metal: half the reflection the mirror bezel takes
      const refl = (mix(0.05, 0.95, met) * (1 - rough * 0.6) + fres * 0.5) * (q === 0 ? 1 : 0.42);
      const rim = Math.pow(1 - ndv, 3) * (q === 0 ? 0.6 : 1) * 0.6;
      const kk = [0, 1, 2].map((c) => refl * mix(1, mat[c], met) * occ);
      const ad = [0, 1, 2].map((c) => mat[c] * (1 - met) * 0.5 * occ + [0.04, 0.5, 0.7][c] * rim);
      mets.push(rx, ry, rz, kk[0], kk[1], kk[2], ad[0], ad[1], ad[2], cnt);
    }
  }
  const faceL = [], facePx = [];
  for (let p = 0; p < GS * GS; p++) {
    const cov = g.face[p * 7 + 4]; if (!cov) continue;
    const u = g.face.readUInt16LE(p * 7) / 65535, v = g.face.readUInt16LE(p * 7 + 2) / 65535;
    const dd = u * 0.75 + v - 0.55;
    const sheen = 0.09 * Math.exp(-(dd * dd) / 0.012) * Math.max(0, 1 - v * 1.4);
    facePx.push(p);
    faceL.push(p, u, v, cov / 255, Math.min(1.25, 0.35 + (g.face[p * 7 + 5] / 255) * 1.15), 255 * ((g.face[p * 7 + 6] / 255) * 0.55 + sheen));
  }
  const hubL = [];
  for (let p = 0; p < GS * GS; p++) {
    const cov = g.hub[p * 7 + 4]; if (!cov) continue;
    hubL.push(p, g.hub.readUInt16LE(p * 7) / 65535, g.hub.readUInt16LE(p * 7 + 2) / 65535, cov / 255, (g.hub[p * 7 + 5] / 255) * 1.25, g.hub[p * 7 + 6] / 255);
  }
  // uv → sprite px, for the needle tip (sparks, the flare)
  const GR = 64, gx = new Float32Array(GR * GR), gy = new Float32Array(GR * GR), gn = new Float32Array(GR * GR);
  for (let i = 0; i < faceL.length; i += 6) {
    const k = Math.min(GR - 1, (faceL[i + 2] * GR) | 0) * GR + Math.min(GR - 1, (faceL[i + 1] * GR) | 0);
    gx[k] += faceL[i] % GS; gy[k] += (faceL[i] / GS) | 0; gn[k]++;
  }
  return {
    base, mixedPx: Int32Array.from(mixedPx), mixed: Float32Array.from(mixed), mets: Float32Array.from(mets),
    facePx: Int32Array.from(facePx), faceL: Float32Array.from(faceL), hubL: Float32Array.from(hubL), grid: { GR, gx, gy, gn },
  };
}
let gaugeP = null;
/** The body, prepared: from memory, else the tmp cache, else a fresh march. */
function gaugeBody() {
  if (!gaugeP) {
    gaugeP = (async () => {
      let g = null;
      try { g = deserialise(await fss.promises.readFile(cacheFile())); } catch { g = null; }
      if (!g) {
        const t0 = Date.now();
        g = await marchGauge();
        log.info(`[pumpMotion] gauge body ray-marched in ${Date.now() - t0}ms`);
        const tmp = `${cacheFile()}.${process.pid}.tmp`;
        fss.promises.writeFile(tmp, serialise(g)).then(() => fss.promises.rename(tmp, cacheFile())).catch(() => fss.promises.unlink(tmp).catch(() => {}));
      }
      return prepare(g);
    })().catch((e) => { gaugeP = null; throw e; });
  }
  return gaugeP;
}

// ─────────────────────────── the dial ───────────────────────────
const A0 = (135 * Math.PI) / 180;
const SWEEP_ANG = (270 * Math.PI) / 180;
/** A scale that puts the needle about two-thirds up, labels on round numbers. */
function scaleFor(m) {
  const top = Math.max(2.4, m * 1.35);
  const steps = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000];
  let step = steps[steps.length - 1];
  for (const s of steps) if (top / s <= 5) { step = s; break; }
  return { min: 1, max: Math.ceil(top / step) * step, step };
}
/** The readout: the caption's spelling at every step of the count (2×, 2.5×). */
const readout = (v) => xMultiple((Math.round(v * 10) / 10 - 1) * 100);

function dialTexture(cv, m, k, kRead, jit, into = null) {
  const T = 720, c = into || cv.createCanvas(T, T), x = c.getContext("2d"), R = T / 2, cx = R, cy = R;
  x.setTransform(1, 0, 0, 1, 0, 0); x.globalCompositeOperation = "source-over"; x.globalAlpha = 1;
  const sc = scaleFor(m);
  const angOf = (v) => A0 + SWEEP_ANG * clamp((v - sc.min) / (sc.max - sc.min));
  const g = x.createRadialGradient(cx, cy - 60, 20, cx, cy, R);
  g.addColorStop(0, "#0E2A4A"); g.addColorStop(0.7, "#071A30"); g.addColorStop(1, "#020A14");
  x.fillStyle = g; x.fillRect(0, 0, T, T);
  x.strokeStyle = "rgba(140,200,255,0.05)"; x.lineWidth = 1;
  for (let r = 60; r < R; r += 18) { x.beginPath(); x.arc(cx, cy, r, 0, TAU); x.stroke(); }
  const ra = R * 0.8;
  x.lineCap = "round";
  x.lineWidth = 26; x.strokeStyle = "rgba(120,180,255,0.10)";
  x.beginPath(); x.arc(cx, cy, ra, A0, A0 + SWEEP_ANG); x.stroke();
  const vNow = sc.min + (m - sc.min) * k;
  // the readout may never pass the true multiple, even while the needle overshoots
  const vRead = sc.min + (m - sc.min) * Math.min(1, kRead);
  const aV = angOf(vNow) + jit;
  const ag = x.createConicGradient(A0 - 0.2, cx, cy);
  ag.addColorStop(0, BLUE); ag.addColorStop(0.45, CY); ag.addColorStop(0.75, MINT); ag.addColorStop(1, MINT);
  x.save(); x.shadowColor = CY; x.shadowBlur = 30;
  x.strokeStyle = ag; x.lineWidth = 26;
  x.beginPath(); x.arc(cx, cy, ra, A0, Math.max(A0 + 0.001, aV)); x.stroke(); x.restore();
  const minor = sc.step / 5, marks = [];
  for (let v = minor; v <= sc.max + 1e-9; v += minor) if (v >= sc.min - 1e-9) marks.push(v);
  if (Math.abs(marks[0] - sc.min) > 1e-9) marks.unshift(sc.min);
  for (const v of marks) {
    const a = angOf(v), major = Math.abs(v - sc.min) < 1e-9 || Math.abs(v / sc.step - Math.round(v / sc.step)) < 1e-6;
    const r1 = R * (major ? 0.6 : 0.64), r2 = R * 0.69;
    x.strokeStyle = major ? "rgba(230,245,255,0.9)" : "rgba(180,210,240,0.45)"; x.lineWidth = major ? 5 : 2.5;
    x.beginPath(); x.moveTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1); x.lineTo(cx + Math.cos(a) * r2, cy + Math.sin(a) * r2); x.stroke();
    if (major) {
      x.font = `700 38px ${F.d7}`; x.fillStyle = "#E8F3FF"; x.textAlign = "center"; x.textBaseline = "middle";
      x.fillText(`${Math.round(v)}×`, cx + Math.cos(a) * R * 0.46, cy + Math.sin(a) * R * 0.46);
    }
  }
  x.textAlign = "center"; x.textBaseline = "alphabetic";
  x.font = `800 86px ${F.x}`;
  const rg = x.createLinearGradient(0, cy + 150, 0, cy + 240);
  rg.addColorStop(0, "#FFFFFF"); rg.addColorStop(1, "#9FE9FF");
  x.fillStyle = rg; x.fillText(readout(vRead), cx, cy + 250);
  x.font = `700 28px ${F.m7}`; x.fillStyle = "rgba(190,225,255,0.8)"; x.textAlign = "left";
  const lab = "SINCE LISTING"; tracked(x, lab, cx - trackedW(x, lab, 4) / 2, cy + 296, 4);
  const nl = R * 0.66;
  const needle = (ox, oy, fill, blur) => {
    x.save(); x.translate(cx + ox, cy + oy); x.rotate(aV);
    if (blur) x.filter = `blur(${blur}px)`;
    x.beginPath(); x.moveTo(-40, -9); x.lineTo(nl, -2.5); x.lineTo(nl + 6, 0); x.lineTo(nl, 2.5); x.lineTo(-40, 9); x.closePath();
    x.fillStyle = fill; x.fill(); x.restore(); x.filter = "none";
  };
  needle(10, 14, "rgba(0,0,0,0.55)", 6);
  x.save(); x.shadowColor = CY; x.shadowBlur = 24; needle(0, 0, "#EFFFFF", 0); x.restore();
  return { canvas: c, aV, nl, R };
}

/** The hub texture: the token's logo, or a monogram of its ticker. */
function hubTexture(cv, img, symbol) {
  const LT = 256, c = cv.createCanvas(LT, LT), x = c.getContext("2d");
  if (img) {
    const s = Math.max(LT / img.width, LT / img.height);
    x.drawImage(img, (LT - img.width * s) / 2, (LT - img.height * s) / 2, img.width * s, img.height * s);
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
const SWEEP0 = 0.15;
const SWEEPD = 1.0;
// easeOutBack first reaches 1 at u = 1 − c1/c3: the moment the needle lands
const T_LAND = IN0 + SWEEP0 + (1 - OVERSHOOT / (OVERSHOOT + 1)) * SWEEPD;
const at = (t, a, d) => clamp((t - (IN0 + a)) / d);
function needleAt(t) {
  if (t < HOLD) return { k: 1, read: 1 };
  if (t < OUTE) { const u = easeIn((t - HOLD) / (OUTE - HOLD)); return { k: 1 - u, read: 1 - u }; }
  const u = at(t, SWEEP0, SWEEPD);
  return { k: easeOutBack(u), read: easeOut(u) };
}
const tremor = (t) => (t < HOLD ? 0.006 * Math.sin((TAU * 25 * t) / SECONDS) + 0.004 * Math.sin((TAU * 7 * t) / SECONDS) : 0);
const rev = (t) => (t >= IN0 ? Math.sin(Math.PI * clamp((t - IN0 - 0.1) / 1.3)) : 0);
function camera(t) {
  let s;
  if (t < HOLD) s = 1 + 0.012 * Math.sin((Math.PI * t) / HOLD);
  else if (t < OUTE) s = 1 + 0.07 * easeIn((t - HOLD) / (OUTE - HOLD));
  else s = 1 + 0.07 * (1 - easeOut(at(t, 0, 1.4)));
  return { s, dx: 7 * Math.sin((TAU * t) / SECONDS), dy: 3 * Math.sin((TAU * 2 * t) / SECONDS) };
}
const envYaw = (t) => 0.22 * Math.sin((TAU * t) / SECONDS) + 0.75 * rev(t) * rev(t);
function reveal(t, a, d) {
  if (t < HOLD) return 1;
  if (t < OUTE) return 1 - easeIn((t - HOLD) / (OUTE - HOLD));
  return easeOut(at(t, a, d));
}

// ─────────────────────────── the scene ───────────────────────────
const V = { x: 960, y: 318 }; // the vanishing point, behind the gauge
const GX = 660; // the gauge sprite's place
const GY = 20;
const rand = (seed) => () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const STREAKS = (() => {
  const r = rand(31);
  return Array.from({ length: 190 }, () => ({
    a: r() * TAU, rad: 0.4 + r() * 2.6, z0: r(), cyc: 1 + Math.floor(r() * 3), len: 0.06 + r() * 0.12, w: 0.6 + r() * 1.8,
    col: r() < 0.7 ? "205,242,255" : r() < 0.5 ? "61,245,159" : "90,160,255", br: 0.35 + r() * 0.65,
  }));
})();
const MIDBOK = (() => { const r = rand(7); return Array.from({ length: 12 }, () => ({ x: 560 + r() * 720, y: r() * H, s: 30 + r() * 60, a: 0.05 + r() * 0.08, ph: r(), k: 1 + Math.floor(r() * 2) })); })();
const FGBOK = [[1180, 560, 120, 0.11, 0.0], [700, 600, 80, 0.07, 0.35], [1240, 120, 90, 0.08, 0.6], [900, 40, 70, 0.06, 0.8], [1060, 620, 60, 0.07, 0.2]];

function baseLayer(cv) {
  const c = cv.createCanvas(W + 160, H + 80), x = c.getContext("2d");
  const g = x.createRadialGradient(V.x + 80, V.y + 40, 20, V.x + 80, V.y + 40, 920);
  g.addColorStop(0, "#0F4E96"); g.addColorStop(0.26, "#072C5A"); g.addColorStop(0.6, "#03132A"); g.addColorStop(1, "#01050C");
  x.fillStyle = g; x.fillRect(0, 0, W + 160, H + 80);
  return c;
}
function drawTunnel(ctx, t, boost) {
  ctx.save(); ctx.globalCompositeOperation = "lighter"; ctx.lineCap = "round";
  for (const st of STREAKS) {
    // depth runs 1 (far) → 0 (here); each streak completes whole cycles a loop
    const ph = (st.z0 + (st.cyc * t) / SECONDS) % 1;
    const z1 = 1 - ph, z2 = Math.min(1, z1 + st.len * (1 + boost * 2.2));
    const pr = (z) => 60 + (st.rad * 260) / (0.12 + z * 1.6);
    const r1 = pr(z1), r2 = pr(z2);
    const x1 = V.x + Math.cos(st.a) * r1, y1 = V.y + Math.sin(st.a) * r1 * 0.78, x2 = V.x + Math.cos(st.a) * r2, y2 = V.y + Math.sin(st.a) * r2 * 0.78;
    // away from the copy column, alive in the middle of its run
    const a = st.br * Math.sin(Math.PI * ph) * clamp((Math.min(x1, x2) - 520) / 260) * (0.8 + boost * 1.1);
    if (a <= 0.01) continue;
    const g = ctx.createLinearGradient(x2, y2, x1, y1);
    g.addColorStop(0, `rgba(${st.col},0)`); g.addColorStop(1, `rgba(${st.col},${Math.min(1, a)})`);
    ctx.strokeStyle = g; ctx.lineWidth = st.w * (0.7 + (1 - z1) * 1.6);
    ctx.beginPath(); ctx.moveTo(x2, y2); ctx.lineTo(x1, y1); ctx.stroke();
  }
  ctx.restore();
}
function drawGodRays(ctx, t, boost) {
  ctx.save(); ctx.globalCompositeOperation = "lighter";
  const n = 14, step = TAU / n, rot = (2 * step * t) / SECONDS; // two beam-steps a loop: the pattern repeats every two beams
  const g = ctx.createRadialGradient(V.x, V.y, 80, V.x, V.y, 820);
  const a = 0.06 + 0.12 * boost;
  g.addColorStop(0, hexA(CY, a)); g.addColorStop(0.5, hexA(BLUE, a * 0.35)); g.addColorStop(1, hexA(BLUE, 0));
  ctx.fillStyle = g;
  for (let i = 0; i < n; i++) {
    const s = i * step + rot, w = i % 2 ? step * 0.14 : step * 0.3;
    ctx.beginPath(); ctx.moveTo(V.x, V.y); ctx.arc(V.x, V.y, 820, s, s + w); ctx.closePath(); ctx.fill();
  }
  ctx.restore();
}
function drawHalo(ctx, t, boost) {
  ctx.save(); ctx.globalCompositeOperation = "lighter";
  for (let i = 0; i < 3; i++) {
    const r = 300 + i * 70 + 10 * Math.sin(TAU * (t / SECONDS + i / 3));
    ctx.beginPath(); ctx.ellipse(V.x, V.y, r, r * 0.92, 0, 0, TAU);
    ctx.lineWidth = 1.2; ctx.strokeStyle = hexA(CY, (0.1 - i * 0.025) * (1 + boost)); ctx.stroke();
  }
  const a0 = (TAU * t) / SECONDS - Math.PI / 2;
  const g = ctx.createConicGradient(a0 - 0.9, V.x, V.y);
  g.addColorStop(0, hexA(CY, 0)); g.addColorStop(0.14, hexA(CY, 0.7)); g.addColorStop(0.15, hexA(CY, 0)); g.addColorStop(1, hexA(CY, 0));
  ctx.beginPath(); ctx.ellipse(V.x, V.y, 300, 276, 0, 0, TAU); ctx.lineWidth = 2.4; ctx.strokeStyle = g; ctx.stroke();
  const cg = ctx.createRadialGradient(V.x, V.y, 40, V.x, V.y, 380);
  cg.addColorStop(0, hexA(CY, 0.22 + 0.3 * boost)); cg.addColorStop(1, hexA(BLUE, 0));
  ctx.fillStyle = cg; ctx.fillRect(V.x - 380, V.y - 380, 760, 760);
  ctx.restore();
}
function softSprite(cv, blur) {
  const c = cv.createCanvas(160, 160), x = c.getContext("2d");
  x.filter = `blur(${blur}px)`; x.fillStyle = "rgba(140,210,255,1)"; x.beginPath(); x.arc(80, 80, 48, 0, TAU); x.fill(); x.filter = "none";
  return c;
}
function shadeLayer(cv) {
  const c = cv.createCanvas(W, H), x = c.getContext("2d");
  const g = x.createLinearGradient(0, 0, 720, 0);
  g.addColorStop(0, "rgba(1,5,12,0.9)"); g.addColorStop(0.55, "rgba(1,5,12,0.55)"); g.addColorStop(1, "rgba(1,5,12,0)");
  x.fillStyle = g; x.fillRect(0, 0, 720, H);
  const v = x.createRadialGradient(W / 2, H / 2, 300, W / 2, H / 2, 820);
  v.addColorStop(0, "rgba(0,0,0,0)"); v.addColorStop(1, "rgba(0,0,0,0.5)");
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
/** The fixed chrome: brand, the network chip, the footer handles. */
function chromeLayer(cv, badge) {
  const c = cv.createCanvas(W, H), ctx = c.getContext("2d");
  drawBrandMark(ctx, 62, 42, 44);
  ctx.textBaseline = "alphabetic"; ctx.fillStyle = "#F1F5FB"; ctx.font = `800 30px ${F.x}`; ctx.fillText("Dexvra", 118, 74);
  if (badge) {
    ctx.font = `700 15px ${F.m7}`;
    const ct = String(badge).toUpperCase().slice(0, 24), cw = trackedW(ctx, ct, 2.6) + 40;
    roundRect(ctx, W - 62 - cw, 48, cw, 36, 18); ctx.fillStyle = "rgba(10,30,56,0.6)"; ctx.fill();
    ctx.strokeStyle = hexA(CY, 0.5); ctx.lineWidth = 1.2; ctx.stroke();
    ctx.fillStyle = "#D8F4FF"; ctx.textBaseline = "middle"; tracked(ctx, ct, W - 62 - cw + 20, 67, 2.6);
  }
  const items = [
    ["web", hostOf(SITE_URL) || "dexvra.io"],
    ["tg", String(CHANNELS.listing || "").startsWith("@") ? CHANNELS.listing : `@${CHANNELS.listing || "dexvralisting"}`],
    ["x", `@${X_LISTING_HANDLE}`],
  ];
  let x = 64; const y = 596;
  ctx.font = `600 18px ${F.d6}`; ctx.textBaseline = "middle";
  for (const [k, text] of items) {
    footerIcon(ctx, k, x + 9, y, 9);
    ctx.fillStyle = "#C2CEDD"; ctx.fillText(text, x + 26, y + 1);
    x += 26 + ctx.measureText(text).width + 32;
  }
  return c;
}
function flare(ctx, x, y, f) {
  if (f <= 0.01) return;
  ctx.save(); ctx.globalCompositeOperation = "lighter";
  const g = ctx.createLinearGradient(x - 520, 0, x + 520, 0);
  g.addColorStop(0, "rgba(90,190,255,0)"); g.addColorStop(0.5, `rgba(190,240,255,${0.85 * f})`); g.addColorStop(1, "rgba(90,190,255,0)");
  ctx.fillStyle = g; ctx.fillRect(x - 520, y - 1.5, 1040, 3);
  ctx.globalAlpha = 0.4 * f; ctx.fillRect(x - 380, y - 6, 760, 12); ctx.globalAlpha = 1;
  const r = ctx.createRadialGradient(x, y, 0, x, y, 120);
  r.addColorStop(0, `rgba(255,255,255,${f})`); r.addColorStop(0.25, `rgba(150,230,255,${0.6 * f})`); r.addColorStop(1, "rgba(80,180,255,0)");
  ctx.fillStyle = r; ctx.fillRect(x - 120, y - 120, 240, 240);
  ctx.fillStyle = `rgba(255,255,255,${0.9 * f})`;
  for (const [w, h] of [[70 * f + 10, 1.6], [1.6, 50 * f + 8]]) { ctx.beginPath(); ctx.ellipse(x, y, w, h, 0, 0, TAU); ctx.fill(); }
  for (const [k2, s, a] of [[0.4, 18, 0.25], [0.7, 30, 0.15], [1.2, 12, 0.2]]) {
    const gx = x + (640 - x) * k2 * 2, gy = y + (320 - y) * k2 * 2;
    const gg = ctx.createRadialGradient(gx, gy, 0, gx, gy, s);
    gg.addColorStop(0, `rgba(120,220,255,${a * f})`); gg.addColorStop(1, "rgba(120,220,255,0)");
    ctx.fillStyle = gg; ctx.fillRect(gx - s, gy - s, s * 2, s * 2);
  }
  ctx.restore();
}

// ── type: masked, blur-to-sharp ──
function masked(ctx, t, a, d, y0, y1, draw, slide = 34) {
  const k = reveal(t, a, d);
  if (k <= 0.002) return;
  ctx.save();
  ctx.beginPath(); ctx.rect(0, y0, 760, y1 - y0); ctx.clip();
  ctx.translate(0, t >= IN0 ? (1 - k) * slide : -(1 - k) * slide * 0.5);
  ctx.globalAlpha = k;
  const blur = (1 - k) * 8;
  if (blur > 0.3) ctx.filter = `blur(${blur.toFixed(1)}px)`;
  draw(ctx);
  ctx.restore();
  ctx.filter = "none";
}
/** Sizes for the copy, decided once per clip from the FINAL strings. */
function copyLayout(cv, coin) {
  const m = cv.createCanvas(10, 10).getContext("2d");
  const sym = tickerOf(coin.symbol);
  let ts = 88; m.font = `800 ${ts}px ${F.x}`;
  while (m.measureText(sym).width > 560 && ts > 40) { ts -= 2; m.font = `800 ${ts}px ${F.x}`; }
  let ns = 28; const name = String(coin.name || "").trim();
  if (name) { m.font = `500 ${ns}px ${F.m}`; while (m.measureText(name).width > 560 && ns > 16) { ns -= 1; m.font = `500 ${ns}px ${F.m}`; } }
  const pct = Math.round(Number(coin.pct) || 0);
  let gs = 120; m.font = `800 ${gs}px ${F.x}`;
  while (m.measureText(`+${pct}%`).width > 560 && gs > 60) { gs -= 2; m.font = `800 ${gs}px ${F.x}`; }
  const cells = [];
  if (coin.firstMc) cells.push(["MC AT LISTING", coin.firstMc, "#BFCCDD"]);
  if (coin.lastMc) cells.push(["MC NOW", coin.lastMc, "#FFFFFF"]);
  return { sym, ts, name, ns, pct, gs, cells };
}
function drawCopy(ctx, t, L, kRead) {
  masked(ctx, t, 0.3, 0.45, 148, 196, (c) => {
    const pulse = 0.6 + 0.4 * Math.sin((TAU * 3 * t) / SECONDS);
    c.fillStyle = MINT; c.shadowColor = MINT; c.shadowBlur = 14 * pulse;
    c.beginPath(); c.arc(72, 170, 6, 0, TAU); c.fill(); c.shadowBlur = 0;
    c.font = `700 20px ${F.m7}`; c.fillStyle = "#DFF7FF"; c.textBaseline = "middle"; tracked(c, "PUMP ALERT", 90, 171, 5);
  });
  // the ticker, letter by letter
  let x = 60;
  [...L.sym].forEach((ch, i) => {
    ctx.font = `800 ${L.ts}px ${F.x}`;
    const w = ctx.measureText(ch).width, cx = x;
    masked(ctx, t, 0.4 + i * 0.045, 0.45, 160, 282, (c) => {
      c.font = `800 ${L.ts}px ${F.x}`; c.textBaseline = "alphabetic";
      const tg = c.createLinearGradient(0, 262 - L.ts * 0.74, 0, 262); tg.addColorStop(0, "#FFFFFF"); tg.addColorStop(1, "#BFEFFF");
      c.fillStyle = tg; c.fillText(ch, cx, 262);
    }, 70);
    x += w;
  });
  if (L.name) masked(ctx, t, 0.62, 0.45, 276, 318, (c) => { c.font = `500 ${L.ns}px ${F.m}`; c.fillStyle = "#A9B9CE"; c.textBaseline = "alphabetic"; c.fillText(L.name, 64, 304); });
  // the gain, counting up with the needle on the way in only
  const cnt = t >= IN0 ? Math.round(L.pct * Math.min(1, kRead)) : L.pct;
  masked(ctx, t, 0.55, 0.5, 318, 452, (c) => {
    c.font = `800 ${L.gs}px ${F.x}`; c.textBaseline = "alphabetic"; c.translate(56, 432);
    const gg = c.createLinearGradient(0, -L.gs * 0.74, 0, 0); gg.addColorStop(0, "#EFFFF8"); gg.addColorStop(0.45, MINT); gg.addColorStop(1, CY);
    c.shadowColor = hexA(MINT, 0.45); c.shadowBlur = 30; c.fillStyle = gg; c.fillText(`+${cnt}%`, 0, 0);
  }, 90);
  const sw = (t - 1.4) / 0.9;
  if (sw > 0 && sw < 1) {
    ctx.save(); ctx.font = `800 ${L.gs}px ${F.x}`; ctx.textBaseline = "alphabetic";
    const w = ctx.measureText(`+${L.pct}%`).width, sx = 56 - 120 + (w + 240) * sw;
    const g = ctx.createLinearGradient(sx - 60, 0, sx + 60, 0);
    g.addColorStop(0, "rgba(255,255,255,0)"); g.addColorStop(0.5, "rgba(255,255,255,0.7)"); g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.globalCompositeOperation = "lighter"; ctx.fillStyle = g; ctx.fillText(`+${L.pct}%`, 56, 432); ctx.restore();
  }
  if (!L.cells.length) return;
  masked(ctx, t, 0.8, 0.5, 462, 562, (c) => {
    const y0 = 470, pw = L.cells.length === 2 ? 520 : 260;
    roundRect(c, 62, y0, pw, 84, 16);
    const pg = c.createLinearGradient(0, y0, 0, y0 + 84); pg.addColorStop(0, "rgba(16,30,52,0.85)"); pg.addColorStop(1, "rgba(6,12,22,0.85)");
    c.fillStyle = pg; c.fill(); c.strokeStyle = hexA(CY, 0.28); c.lineWidth = 1.2; c.stroke();
    const run = (t - 2.2) / 1.2;
    if (run > 0 && run < 1) {
      const cg = c.createConicGradient(TAU * run - Math.PI / 2, 62 + pw / 2, y0 + 42);
      cg.addColorStop(0, hexA(CY, 0)); cg.addColorStop(0.06, hexA(CY, 0.95)); cg.addColorStop(0.12, hexA(CY, 0)); cg.addColorStop(1, hexA(CY, 0));
      roundRect(c, 62, y0, pw, 84, 16); c.strokeStyle = cg; c.lineWidth = 2; c.stroke();
    }
    const cell = (cx, k, v, col) => {
      c.font = `700 15px ${F.m7}`; c.fillStyle = hexA(ICE, 0.75); c.textBaseline = "alphabetic"; tracked(c, k, cx, y0 + 32, 1.6);
      c.font = `700 30px ${F.d7}`; c.fillStyle = col; c.fillText(v, cx, y0 + 70);
    };
    cell(86, ...L.cells[0]);
    if (L.cells.length === 2) {
      c.strokeStyle = hexA(CY, 0.8); c.lineWidth = 2; const ax = 262;
      c.beginPath(); c.moveTo(ax, y0 + 52); c.lineTo(ax + 36, y0 + 52); c.moveTo(ax + 28, y0 + 45); c.lineTo(ax + 36, y0 + 52); c.lineTo(ax + 28, y0 + 59); c.stroke();
      cell(318, ...L.cells[1]);
    }
  });
}

/**
 * Draw the clip. `coin` = { symbol, name, pct, firstMc, lastMc } (figures
 * already spelt — see the header); `times` (seconds, UNWRAPPED) is the test
 * seam. Calls onFrame(rgbaBuffer) per frame and awaits it.
 */
async function drawFrames(coin, logoBuffer, { count = FRAMES, times = null, badge = null, onFrame, cancel = null } = {}) {
  const cv = kit.canvasLib();
  if (!cv) return false;
  coin = coin || {};
  warnBoxes("pump-motion", { symbol: coin.symbol, name: coin.name });
  let img = null;
  if (logoBuffer) { try { img = await cv.loadImage(logoBuffer); } catch { img = null; } } // an unreadable logo draws the monogram
  const body = await gaugeBody();
  const L = copyLayout(cv, coin);
  const mult = 1 + L.pct / 100;
  const sc = scaleFor(mult);
  const angOf = (v) => A0 + SWEEP_ANG * clamp((v - sc.min) / (sc.max - sc.min));
  const LT = 256, lt = hubTexture(cv, img, coin.symbol);
  const BASE = baseLayer(cv), SHADE = shadeLayer(cv), CHROME = chromeLayer(cv, badge), MID = softSprite(cv, 6), FG = softSprite(cv, 22);
  const sprite = cv.createCanvas(GS, GS), sx = sprite.getContext("2d"), sid = sx.createImageData(GS, GS);
  const dialC = cv.createCanvas(720, 720);
  const glare = cv.createCanvas(GS, GS), gxx = glare.getContext("2d");
  const half = cv.createCanvas(GS / 2, GS / 2), hx = half.getContext("2d");
  let shadow = null; // the gauge's silhouette never changes: its drop shadow is made once
  const out = cv.createCanvas(W, H), ctx = out.getContext("2d");
  const { mixedPx, mixed, mets, facePx, faceL, hubL, grid } = body;
  const ev = new Float64Array(3);

  // the hub (the logo) never changes within a clip: bake it into this clip's base
  const base = Uint8ClampedArray.from(body.base);
  for (let i = 0; i < hubL.length; i += 6) {
    const p = hubL[i], u = hubL[i + 1], v = hubL[i + 2], a = hubL[i + 3], light = Math.min(1.25, 0.35 + hubL[i + 4]), coat = 255 * hubL[i + 5] * 0.55;
    const ti = (Math.min(LT - 1, (v * LT) | 0) * LT + Math.min(LT - 1, (u * LT) | 0)) * 4;
    for (let c = 0; c < 3; c++) base[p * 4 + c] = base[p * 4 + c] * (1 - a) + Math.min(255, lt[ti + c] * light + coat) * a;
  }
  const uvToPx = (u, v) => {
    const { GR, gx, gy, gn } = grid;
    const ci = Math.min(GR - 1, Math.max(0, (u * GR) | 0)), cj = Math.min(GR - 1, Math.max(0, (v * GR) | 0));
    let best = null, bd = 1e9;
    for (let dj = -2; dj <= 2; dj++) for (let di = -2; di <= 2; di++) {
      const i = cj + dj, j = ci + di; if (i < 0 || j < 0 || i >= GR || j >= GR) continue;
      const k = i * GR + j; if (!gn[k]) continue;
      const d = di * di + dj * dj; if (d < bd) { bd = d; best = [gx[k] / gn[k], gy[k] / gn[k]]; }
    }
    return best;
  };
  const bobAt = (tt) => 5 * Math.sin((TAU * tt) / SECONDS);
  const tipAt = (tt) => {
    const n2 = needleAt(tt), a = angOf(sc.min + (mult - sc.min) * n2.k) + tremor(tt);
    const p = uvToPx(0.5 + 0.33 * Math.cos(a), 0.5 + 0.33 * Math.sin(a));
    return p ? [GX + p[0], GY + bobAt(tt) + p[1]] : null;
  };
  const n = times ? times.length : count;
  for (let f = 0; f < n; f++) {
    // a caller that stopped waiting (the budget) stops the work too
    if (cancel && cancel.cancelled) throw new Error("cancelled — the caller stopped waiting");
    const t = times ? times[f] : (f % FRAMES) / FPS;
    const nd = needleAt(t), jit = tremor(t), boost = rev(t), cam = camera(t), yaw = envYaw(t);

    // ── the gauge sprite: the base, the chrome re-lit, the dial ──
    const cyw = Math.cos(yaw), syw = Math.sin(yaw);
    const data = sid.data; data.set(base);
    for (let i = 0, n4 = mixedPx.length; i < n4; i++) {
      const p4 = mixedPx[i] * 4, s4 = i * 4;
      let r = mixed[s4], g = mixed[s4 + 1], b = mixed[s4 + 2], tot = mixed[s4 + 3];
      for (let o = i * 20, oe = o + 20; o < oe; o += 10) {
        const cnt = mets[o + 9]; if (!cnt) continue;
        const rx = mets[o], ry = mets[o + 1], rz = mets[o + 2];
        env(rx * cyw - rz * syw, ry, rx * syw + rz * cyw, true, ev);
        r += toneFast(ev[0] * mets[o + 3] + mets[o + 6]) * cnt;
        g += toneFast(ev[1] * mets[o + 4] + mets[o + 7]) * cnt;
        b += toneFast(ev[2] * mets[o + 5] + mets[o + 8]) * cnt;
        tot += cnt;
      }
      const k = 255 / tot;
      data[p4] = r * k; data[p4 + 1] = g * k; data[p4 + 2] = b * k; data[p4 + 3] = (tot / (GSS * GSS)) * 255;
    }
    dialTexture(cv, mult, nd.k, nd.read, jit, dialC);
    // ⚠️ data() FLUSHES the canvas's pending drawing and hands back its pixels
    // (a view, 0.1 ms; getImageData copies 2 MB). Called after the draw, every
    // frame: a view taken before a draw does not see it — measured.
    const dd = dialC.data();
    const T = 720, T4 = T * 4;
    for (let i = 0, nf = facePx.length; i < nf; i++) {
      const p4 = facePx[i] * 4, f = i * 6, a = faceL[f + 3], lt2 = faceL[f + 4], add = faceL[f + 5], ia = 1 - a;
      let fx = faceL[f + 1] * T - 0.5, fy = faceL[f + 2] * T - 0.5;
      fx = fx < 0 ? 0 : fx > T - 1.001 ? T - 1.001 : fx; fy = fy < 0 ? 0 : fy > T - 1.001 ? T - 1.001 : fy;
      const x0 = fx | 0, y0 = fy | 0, ax = fx - x0, ay = fy - y0;
      const w00 = (1 - ax) * (1 - ay), w10 = ax * (1 - ay), w01 = (1 - ax) * ay, w11 = ax * ay;
      const b00 = y0 * T4 + x0 * 4, b10 = b00 + 4, b01 = b00 + T4, b11 = b01 + 4;
      for (let c = 0; c < 3; c++) {
        let v = (dd[b00 + c] * w00 + dd[b10 + c] * w10 + dd[b01 + c] * w01 + dd[b11 + c] * w11) * lt2 + add;
        if (v > 255) v = 255;
        data[p4 + c] = data[p4 + c] * ia + v * a;
      }
    }
    sx.putImageData(sid, 0, 0);
    if (!shadow) {
      shadow = cv.createCanvas(GS + 240, GS + 240);
      const shx = shadow.getContext("2d");
      shx.shadowColor = "rgba(0,0,0,0.7)"; shx.shadowBlur = 60; shx.shadowOffsetY = 30;
      // draw the sprite far off-canvas so only its shadow lands here
      shx.shadowOffsetX = 4000; shx.drawImage(sprite, 120 - 4000, 120);
    }

    // ── compose ──
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = "source-over"; ctx.globalAlpha = 1;
    // the background moves at half the camera's move: parallax
    const sb = 1 + (cam.s - 1) * 0.5;
    ctx.setTransform(sb, 0, 0, sb, V.x * (1 - sb) + cam.dx * 0.5, V.y * (1 - sb) + cam.dy * 0.5);
    ctx.drawImage(BASE, -80, -40);
    drawGodRays(ctx, t, boost);
    drawTunnel(ctx, t, boost);
    ctx.save(); ctx.globalCompositeOperation = "lighter";
    for (const b of MIDBOK) {
      const ph = TAU * ((b.k * t) / SECONDS + b.ph);
      ctx.globalAlpha = b.a * (0.7 + 0.3 * Math.sin(ph));
      const s = b.s * 2; ctx.drawImage(MID, b.x + 14 * Math.sin(ph) - s / 2, b.y + 9 * Math.cos(ph) - s / 2, s, s);
    }
    ctx.restore();
    drawHalo(ctx, t, boost);
    ctx.setTransform(cam.s, 0, 0, cam.s, V.x * (1 - cam.s) + cam.dx, V.y * (1 - cam.s) + cam.dy);
    let spr = sprite;
    const sw = (t - 0.6) / 1.1; // a glare across the glass and chrome, once a loop
    if (sw > 0 && sw < 1) {
      gxx.globalCompositeOperation = "source-over"; gxx.clearRect(0, 0, GS, GS); gxx.drawImage(sprite, 0, 0);
      gxx.globalCompositeOperation = "source-atop";
      const bx = -200 + (GS + 400) * easeInOut(sw);
      const g = gxx.createLinearGradient(bx - 90, 0, bx + 90, 60);
      g.addColorStop(0, "rgba(255,255,255,0)"); g.addColorStop(0.5, "rgba(255,255,255,0.3)"); g.addColorStop(1, "rgba(255,255,255,0)");
      gxx.fillStyle = g; gxx.fillRect(0, 0, GS, GS);
      spr = glare;
    }
    const gy = GY + bobAt(t);
    ctx.drawImage(shadow, GX - 120, gy - 120);
    ctx.drawImage(spr, GX, gy);
    // bloom: the gauge's own light, blurred back over itself (at half size — a blur that size costs nothing)
    hx.globalCompositeOperation = "copy"; hx.filter = "blur(7px)"; hx.drawImage(spr, 0, 0, GS / 2, GS / 2); hx.filter = "none";
    ctx.save(); ctx.globalCompositeOperation = "lighter"; ctx.globalAlpha = 0.16 + 0.18 * boost; ctx.drawImage(half, GX, gy, GS, GS); ctx.restore();
    // the needle tip: sparks while it climbs, a flare where it lands
    if (t >= IN0 + SWEEP0 && t < SECONDS) {
      ctx.save(); ctx.globalCompositeOperation = "lighter"; ctx.lineCap = "round";
      for (let i = 0; i < 60; i++) {
        const tb = IN0 + SWEEP0 + (i / 60) * 0.95, life = 0.55, age = (t - tb) / life;
        if (age < 0 || age > 1) continue;
        const p0 = tipAt(tb); if (!p0) continue;
        const ang = (i * 2.399) % TAU, spd = 60 + ((i * 37) % 90);
        const vx = Math.cos(ang) * spd, vy = Math.sin(ang) * spd - 40;
        const tt = age * life, x1 = p0[0] + vx * tt, y1 = p0[1] + vy * tt + 90 * tt * tt;
        ctx.strokeStyle = `rgba(${i % 3 ? "200,245,255" : "120,255,200"},${(1 - age) * 0.9})`; ctx.lineWidth = 1.6 * (1 - age) + 0.4;
        ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x1 - vx * 0.05, y1 - vy * 0.05); ctx.stroke();
      }
      ctx.restore();
    }
    if (t >= T_LAND) {
      // fades to nothing before the loop wraps: frame 0 carries no flare
      const fl = Math.exp(-(t - T_LAND) * 4.5) * (1 - smooth(5.7, 5.96, t));
      const p = tipAt(T_LAND); if (p) flare(ctx, p[0], p[1], fl);
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
    drawCopy(ctx, t, L, nd.read);
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

const TMP_PREFIX = "bt-out-pm-";
const TMP_MAX_AGE_MS = 10 * 60_000;
/** This module reclaims its own temp clips: anything older than ten minutes
 *  has long been uploaded. Best-effort. */
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

/** The pump clip → { type: "animation", source: <mp4> }, or null on any failure. */
async function render(coin, logoBuffer, { badge = null, outPath = null, cancel = null, count = FRAMES } = {}) {
  const t0 = Date.now();
  let file = null;
  try {
    if (!kit.canvasLib()) {
      log.warn("[pumpMotion] @napi-rs/canvas unavailable — pump clip skipped");
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
    log.info(`[pumpMotion] ${tickerOf(coin && coin.symbol)} rendered in ${Date.now() - t0}ms (${Math.round(st.size / 1024)} KB)`);
    return { type: "animation", source: file };
  } catch (e) {
    log.warn(`[pumpMotion] ${tickerOf(coin && coin.symbol)} render failed after ${Date.now() - t0}ms: ${e.message}`);
    if (file) fss.promises.unlink(file).catch(() => {}); // a half-written clip is never handed on
    return null;
  }
}

/** PUMP_MOTION=0 restores the old ladder exactly. Blank or unset is ON. */
const enabled = () => sourceEnabled("PUMP_MOTION");

module.exports = {
  render,
  enabled,
  frames,
  W,
  H,
  FPS,
  FRAMES,
  SECONDS,
  _drawFrames: drawFrames,
  _scaleFor: scaleFor,
  _readout: readout,
  _needleAt: needleAt,
  _gaugeBody: gaugeBody,
  _cacheFile: cacheFile,
  _sweepTmp: sweepTmp,
  _timeline: { HOLD, OUTE, IN0, T_LAND },
};
