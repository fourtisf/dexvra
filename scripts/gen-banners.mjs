// Renders animated Dexvra promo banners (New Listing / Trending / Featured ad)
// as looping GIF + WebM video + a static poster PNG — all from one CSS-animated
// HTML template, in the same premium brand style as the other gen-* scripts.
//
//   node scripts/gen-banners.mjs [listing|trending|ad|all]
//
// Chromium + ffmpeg are auto-discovered under PLAYWRIGHT_BROWSERS_PATH; override
// with CHROMIUM_PATH / FFMPEG_PATH if they live elsewhere.
//
// Outputs to public/brand/templates/<kind>.{gif,webm,png}.
//
// Why two formats: the admin "Banner Image" upload slot accepts GIF (<=3 MB),
// so the GIF is tuned small for that; Telegram channel/DM posts take video, so
// the crisp full-res WebM is for the bot. Both loop seamlessly.
//
// Customise a banner for a real token without touching this file:
//   BANNER_DATA='[{"kind":"listing","symbol":"PEPE","chain":"Ethereum",
//                  "chainColor":"#627EEA","tier":"Diamond","emoji":"🐸",
//                  "grad":["#B8FFD0","#3DF59F","#0B9E5E"],"out":"pepe-listing"}]' \
//   node scripts/gen-banners.mjs
import { chromium } from "playwright";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import gifenc from "gifenc";
import { PNG } from "pngjs";

const { GIFEncoder, quantize, applyPalette } = gifenc;

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = resolve(ROOT, "public/brand/templates");
mkdirSync(OUT, { recursive: true });

// Resolve ffmpeg: explicit env → Playwright's bundled build → system ffmpeg.
// The WebM (VP8) muxer + libvpx encoder ship with Playwright's ffmpeg, so no
// system install is needed when Playwright is present.
function findFfmpeg() {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH || "/opt/pw-browsers";
  try {
    const dir = readdirSync(base).find((n) => n.startsWith("ffmpeg"));
    if (dir) {
      const inner = readdirSync(resolve(base, dir)).find((n) => n.startsWith("ffmpeg"));
      if (inner && existsSync(resolve(base, dir, inner))) return resolve(base, dir, inner);
    }
  } catch {}
  return "ffmpeg"; // fall back to PATH
}
const FF = findFfmpeg();

// Resolve the Chromium binary the same way: explicit env → the pre-installed
// browser under PLAYWRIGHT_BROWSERS_PATH → let Playwright find its own.
function findChromium() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH || "/opt/pw-browsers";
  const link = resolve(base, "chromium");
  return existsSync(link) ? link : undefined;
}
const CHROMIUM = findChromium();

// ---- brand tokens (kept in sync with gen-brand-assets / globals.css) ----
const MINT = "#4BFCA6", CYAN = "#22D3EE", DEEP = "#12B9E0";
const INK = "#F2F6FC", MUTED = "#AEBCCF", DIM = "#7b8aa0";
const FONT = `'Space Grotesk','Liberation Sans','DejaVu Sans',system-ui,sans-serif`;
const MONO = `'DejaVu Sans Mono',ui-monospace,monospace`;

// ---- canvas + timing ----
const W = 1200, H = 628;               // 1.91:1 — social / Telegram link-preview ratio
const LOOP_MS = 3000;                  // every keyframe tiles cleanly at this period
const GIF_FPS = 12, GIF_SCALE = 760 / W; // downscaled + fewer frames -> stays <3 MB
const WEBM_FPS = 24;                   // full-res, smooth

const gem = (size) => `
  <svg viewBox="0 0 48 48" width="${size}" height="${size}" style="display:block">
    <defs><linearGradient id="g${size}" x1="9" y1="12" x2="39" y2="37" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="${MINT}"/><stop offset=".55" stop-color="${CYAN}"/><stop offset="1" stop-color="${DEEP}"/></linearGradient></defs>
    <rect x="2" y="2" width="44" height="44" rx="13" fill="#0A0E16"/>
    <rect x="2" y="2" width="44" height="44" rx="13" fill="none" stroke="url(#g${size})" stroke-opacity=".5" stroke-width="1.5"/>
    <path d="M15 12 H33 L39 19 L24 37 L9 19 Z" fill="url(#g${size})"/>
    <g stroke="#0A0E16" stroke-width="1.3" stroke-opacity=".5" fill="none">
      <path d="M9 19 H39"/><path d="M15 12 L20 19"/><path d="M33 12 L28 19"/><path d="M20 19 H28"/><path d="M20 19 L24 37"/><path d="M28 19 L24 37"/></g>
    <path d="M15.6 12.5 H22 L19 18.5 H10.5 Z" fill="#fff" fill-opacity=".14"/>
  </svg>`;

const coin = (emoji, grad, size = 172) => `
  <div style="width:${size}px;height:${size}px;border-radius:50%;display:grid;place-items:center;
     font-size:${size * 0.5}px;line-height:1;
     background:radial-gradient(circle at 32% 26%,${grad[0]},${grad[1]} 45%,${grad[2]});
     box-shadow:0 24px 60px rgba(0,0,0,.5), inset 0 3px 10px rgba(255,255,255,.35), inset 0 -8px 18px rgba(0,0,0,.28);
     border:1px solid rgba(255,255,255,.28)">${emoji}</div>`;

const sparkle = (x, y, delay, size = 26) =>
  `<span class="spk" style="left:${x};top:${y};font-size:${size}px;animation-delay:${delay}ms">✦</span>`;

// staggered momentum bars for the trending board
const bars = () => {
  const hs = [34, 52, 40, 66, 58, 80, 72, 96, 88, 118, 128, 150];
  return `<div class="bars">${hs
    .map(
      (h, i) =>
        `<span class="bar" style="height:${h}px;animation-delay:${-((i * LOOP_MS) / hs.length).toFixed(0)}ms;
          background:linear-gradient(180deg,${MINT},${CYAN})"></span>`,
    )
    .join("")}</div>`;
};

const CSS = `
*{margin:0;padding:0;box-sizing:border-box}
.card{position:relative;width:${W}px;height:${H}px;overflow:hidden;font-family:${FONT};color:${INK};
  background:
    radial-gradient(1100px 520px at 26% -30%, rgba(255,255,255,.05), transparent 60%),
    radial-gradient(900px 720px at 98% 54%, rgba(34,211,238,.12), transparent 60%),
    radial-gradient(760px 520px at 58% 128%, rgba(75,252,166,.07), transparent 60%),
    #080B11;}
.dots{position:absolute;inset:0;background-image:radial-gradient(rgba(255,255,255,.035) 1px,transparent 1px);background-size:26px 26px;opacity:.55}
.sweep{position:absolute;top:-40%;left:0;width:44%;height:180%;pointer-events:none;
  background:linear-gradient(100deg,transparent,rgba(255,255,255,.14) 46%,rgba(75,252,166,.10) 54%,transparent);
  transform:skewX(-16deg) translateX(-160%);animation:sweep ${LOOP_MS}ms linear infinite}
.lockup{position:absolute;left:56px;top:46px;display:flex;align-items:center;gap:16px;z-index:3}
.lockup .wm{font-size:36px;font-weight:800;letter-spacing:-.03em;color:${INK};line-height:1}
.lockup .sub{font-family:${MONO};font-size:11px;font-weight:700;letter-spacing:.34em;color:${CYAN};text-transform:uppercase;margin-top:5px}
.urlpill{position:absolute;right:56px;bottom:44px;font-family:${MONO};font-size:16px;font-weight:700;letter-spacing:.16em;
  color:${MINT};text-transform:uppercase;border:1px solid rgba(75,252,166,.35);border-radius:999px;padding:8px 18px;background:rgba(75,252,166,.06);z-index:3}
.spk{position:absolute;color:#fff;opacity:.35;animation:twinkle 1500ms ease-in-out infinite;z-index:2;
  text-shadow:0 0 12px rgba(75,252,166,.6)}
.eyebrow{display:inline-flex;align-items:center;gap:10px;font-family:${MONO};font-size:16px;font-weight:700;
  letter-spacing:.22em;text-transform:uppercase;padding:8px 16px;border-radius:999px;
  border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.04)}
.livedot{width:10px;height:10px;border-radius:50%;background:${MINT};box-shadow:0 0 0 0 rgba(75,252,166,.6);animation:pulseDot 1500ms ease-out infinite}
.body{position:absolute;inset:0;display:flex;align-items:center;z-index:2}
.stage-coin{position:relative;display:grid;place-items:center;animation:floatY ${LOOP_MS}ms ease-in-out infinite}
.ring{position:absolute;border-radius:50%;border:2px solid rgba(75,252,166,.5);animation:ringPulse ${LOOP_MS}ms ease-out infinite}
.grad{background:linear-gradient(90deg,${MINT},${CYAN} 55%,${DEEP});-webkit-background-clip:text;background-clip:text;color:transparent}
.chip{display:inline-flex;align-items:center;gap:8px;font-family:${MONO};font-size:15px;font-weight:700;letter-spacing:.08em;
  padding:7px 14px;border-radius:999px;border:1px solid rgba(255,255,255,.16);background:rgba(255,255,255,.05);color:${INK}}
.bars{display:flex;align-items:flex-end;gap:9px;height:150px}
.bar{width:16px;border-radius:5px 5px 2px 2px;transform-origin:bottom;animation:barPulse ${LOOP_MS}ms ease-in-out infinite;box-shadow:0 0 14px rgba(34,211,238,.4)}
.cta{display:inline-flex;align-items:center;gap:10px;font-size:24px;font-weight:800;letter-spacing:-.01em;color:#04240f;
  padding:16px 30px;border-radius:14px;background:linear-gradient(90deg,${MINT},${CYAN});animation:glowPulse 1500ms ease-in-out infinite}
.slot{width:132px;height:132px;border-radius:22px;display:grid;place-items:center;text-align:center;font-family:${MONO};font-size:12px;
  letter-spacing:.14em;color:${MUTED};border:2px dashed rgba(75,252,166,.4);background:rgba(75,252,166,.05);animation:floatY ${LOOP_MS}ms ease-in-out infinite}
@keyframes sweep{to{transform:skewX(-16deg) translateX(420%)}}
@keyframes twinkle{0%,100%{opacity:.2;transform:scale(.7)}50%{opacity:1;transform:scale(1.15)}}
@keyframes floatY{0%,100%{transform:translateY(0)}50%{transform:translateY(-10px)}}
@keyframes pulseDot{0%{box-shadow:0 0 0 0 rgba(75,252,166,.55)}70%{box-shadow:0 0 0 14px rgba(75,252,166,0)}100%{box-shadow:0 0 0 0 rgba(75,252,166,0)}}
@keyframes ringPulse{0%{width:150px;height:150px;opacity:0}45%{opacity:.55}100%{width:300px;height:300px;opacity:0}}
@keyframes barPulse{0%,100%{transform:scaleY(.42)}50%{transform:scaleY(1)}}
@keyframes glowPulse{0%,100%{box-shadow:0 0 0 0 rgba(75,252,166,.0),0 14px 34px rgba(34,211,238,.28)}50%{box-shadow:0 0 0 6px rgba(75,252,166,.18),0 14px 44px rgba(34,211,238,.5)}}`;

// ---- per-kind body content ----
function bodyFor(kind, d) {
  if (kind === "listing") {
    return `
      <div class="body" style="padding-left:520px">
        <div style="display:flex;flex-direction:column;align-items:flex-start;gap:20px;max-width:600px">
          <span class="eyebrow" style="color:${MINT};border-color:rgba(75,252,166,.35)"><span class="livedot"></span>🚀 New Listing</span>
          <div style="font-size:78px;font-weight:800;letter-spacing:-.035em;line-height:.95">
            <span class="grad">$${d.symbol}</span></div>
          <div style="font-size:30px;font-weight:600;color:${MUTED};line-height:1.25">is now live on <b style="color:${INK}">Dexvra</b></div>
          <div style="display:flex;gap:12px;margin-top:6px">
            <span class="chip"><span style="width:9px;height:9px;border-radius:50%;background:${d.chainColor}"></span>${d.chain}</span>
            <span class="chip" style="border-color:rgba(75,252,166,.4);color:${MINT}">◆ ${d.tier}</span>
          </div>
        </div>
      </div>
      <div style="position:absolute;left:150px;top:0;bottom:0;display:grid;place-items:center;z-index:2">
        <div class="stage-coin"><span class="ring"></span>${coin(d.emoji, d.grad, 224)}</div>
      </div>`;
  }
  if (kind === "trending") {
    return `
      <div class="body" style="padding-left:520px">
        <div style="display:flex;flex-direction:column;align-items:flex-start;gap:18px;max-width:600px">
          <span class="eyebrow" style="color:#FFC53D;border-color:rgba(255,197,61,.4)">🔥 Trending #${d.rank}</span>
          <div style="display:flex;align-items:baseline;gap:18px">
            <div style="font-size:66px;font-weight:800;letter-spacing:-.035em;line-height:.95"><span class="grad">$${d.symbol}</span></div>
            <div style="font-family:${MONO};font-size:44px;font-weight:800;color:${MINT};text-shadow:0 0 22px rgba(75,252,166,.45)">▲ ${d.pct}</div>
          </div>
          <div style="font-size:22px;font-weight:600;color:${MUTED}">MCAP <b style="color:${INK}">${d.mcap}</b> → ATH <b style="color:${INK}">${d.ath}</b></div>
          <div style="display:flex;gap:12px;margin-top:4px">
            <span class="chip"><span style="width:9px;height:9px;border-radius:50%;background:${d.chainColor}"></span>${d.chain}</span>
            <span class="chip" style="border-color:rgba(255,197,61,.4);color:#FFC53D">↗ Since listing</span>
          </div>
        </div>
      </div>
      <div style="position:absolute;left:120px;top:0;bottom:0;width:360px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:26px;z-index:2">
        <div class="stage-coin">${coin(d.emoji, d.grad, 188)}</div>
        ${bars()}
      </div>`;
  }
  // ad / featured — generic bookable banner
  return `
    <div class="body" style="padding-left:150px">
      <div style="display:flex;flex-direction:column;align-items:flex-start;gap:22px;max-width:640px">
        <span class="eyebrow" style="color:${CYAN};border-color:rgba(34,211,238,.4)">📢 Featured Slot</span>
        <div style="font-size:60px;font-weight:800;letter-spacing:-.03em;line-height:1.02">
          Get featured across the <span class="grad">Dexvra</span> network</div>
        <div style="font-size:24px;font-weight:500;color:${MUTED};line-height:1.35;max-width:20ch">
          Homepage spotlight, ticker priority & trending reach — on every Dexvra tool.</div>
        <div style="margin-top:8px"><span class="cta">${d.cta || "Boost your token →"}</span></div>
      </div>
    </div>
    <div style="position:absolute;right:120px;top:0;bottom:0;display:flex;align-items:center;z-index:2">
      <div class="slot">YOUR<br/>TOKEN<br/>HERE</div>
    </div>`;
}

function pageHTML(kind, d, scale) {
  const spks =
    sparkle("36%", "24%", 0) +
    sparkle("12%", "70%", 900) +
    sparkle("62%", "16%", 1600, 20) +
    sparkle("88%", "60%", 500, 22);
  const card = `
    <div class="card">
      <div class="dots"></div>
      <div class="sweep"></div>
      ${spks}
      <div class="lockup">${gem(50)}<div><div class="wm">Dexvra</div><div class="sub">Multi‑chain Discovery</div></div></div>
      ${bodyFor(kind, d)}
      <div class="urlpill">dexvra.io</div>
    </div>`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>${CSS}</style></head>
    <body style="background:#080B11">
      <div style="width:${W}px;height:${H}px;transform:scale(${scale});transform-origin:top left">${card}</div>
    </body></html>`;
}

// ---- deterministic frame capture: pause every animation and seek it ----
async function capture(page, { fps, type }) {
  const n = Math.round((LOOP_MS / 1000) * fps);
  const clip = { x: 0, y: 0, width: page.viewportSize().width, height: page.viewportSize().height };
  const shots = [];
  for (let i = 0; i < n; i++) {
    const t = (i * LOOP_MS) / n;
    await page.evaluate((tt) => {
      for (const a of document.getAnimations()) {
        try { a.pause(); a.currentTime = tt; } catch {}
      }
    }, t);
    shots.push(await page.screenshot(type === "jpeg" ? { type: "jpeg", quality: 92, clip } : { type: "png", clip }));
  }
  return shots;
}

function encodeGIF(pngBuffers, w, h) {
  const frames = pngBuffers.map((b) => PNG.sync.read(b).data);
  // global palette sampled across the loop so colours stay stable frame-to-frame
  const picks = [0, frames.length >> 2, frames.length >> 1, (frames.length * 3) >> 2];
  const sample = Buffer.concat(picks.map((i) => Buffer.from(frames[i].buffer, frames[i].byteOffset, frames[i].byteLength)));
  const palette = quantize(sample, 256, { format: "rgb444" });
  const gif = GIFEncoder();
  const delay = Math.round(1000 / GIF_FPS);
  frames.forEach((data, i) => {
    const index = applyPalette(data, palette, "rgb444");
    if (i === 0) gif.writeFrame(index, w, h, { palette, delay, repeat: 0 });
    else gif.writeFrame(index, w, h, { delay });
  });
  gif.finish();
  return Buffer.from(gif.bytes());
}

function encodeWebM(jpegBuffers, outPath) {
  const r = spawnSync(
    FF,
    ["-y", "-f", "image2pipe", "-vcodec", "mjpeg", "-r", String(WEBM_FPS), "-i", "pipe:0",
      "-c:v", "libvpx", "-b:v", "1600k", "-deadline", "good", "-cpu-used", "1",
      "-pix_fmt", "yuv420p", "-an", outPath],
    { input: Buffer.concat(jpegBuffers), maxBuffer: 1 << 30 },
  );
  if (r.status !== 0) throw new Error("ffmpeg failed:\n" + (r.stderr?.toString() || r.error));
}

const kb = (b) => `${(b.length / 1024).toFixed(0)} KB`;

async function render(browser, kind, d) {
  const name = d.out || kind;

  // --- WebM + poster: full-res JPEG frames ---
  let ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  let page = await ctx.newPage();
  await page.setContent(pageHTML(kind, d, 1), { waitUntil: "networkidle" });
  await page.waitForTimeout(250);
  const jpegs = await capture(page, { fps: WEBM_FPS, type: "jpeg" });
  const poster = await page.screenshot({ type: "png", clip: { x: 0, y: 0, width: W, height: H } });
  writeFileSync(resolve(OUT, `${name}.png`), poster);
  encodeWebM(jpegs, resolve(OUT, `${name}.webm`));
  await ctx.close();

  // --- GIF: downscaled PNG frames ---
  const gw = Math.round(W * GIF_SCALE), gh = Math.round(H * GIF_SCALE);
  ctx = await browser.newContext({ viewport: { width: gw, height: gh }, deviceScaleFactor: 1 });
  page = await ctx.newPage();
  await page.setContent(pageHTML(kind, d, GIF_SCALE), { waitUntil: "networkidle" });
  await page.waitForTimeout(250);
  const pngs = await capture(page, { fps: GIF_FPS, type: "png" });
  const gif = encodeGIF(pngs, gw, gh);
  writeFileSync(resolve(OUT, `${name}.gif`), gif);
  await ctx.close();

  const posterSize = poster.length;
  console.log(`✓ ${name}: gif ${kb(gif)}${gif.length > 3 * 1024 * 1024 ? " ⚠ >3MB" : ""}  webm ✓  png ${kb({ length: posterSize })}`);
}

// ---- default sample data (one per template kind) ----
const DEFAULTS = {
  listing: { kind: "listing", symbol: "WARCHEST", chain: "Solana", chainColor: "#14F195", tier: "Diamond", emoji: "⚔️", grad: ["#FFE9A8", "#FFC53D", "#B57900"] },
  trending: { kind: "trending", symbol: "CUBEMAN", chain: "Base", chainColor: "#0052FF", rank: 1, pct: "412%", mcap: "$310K", ath: "$128.4M", emoji: "🧊", grad: ["#B0F2FF", "#22D3EE", "#0A7F96"] },
  ad: { kind: "ad", cta: "Boost your token →" },
};

const arg = (process.argv[2] || "all").toLowerCase();
let jobs;
if (process.env.BANNER_DATA) {
  jobs = JSON.parse(process.env.BANNER_DATA);
} else if (arg === "all") {
  jobs = Object.values(DEFAULTS);
} else if (DEFAULTS[arg]) {
  jobs = [DEFAULTS[arg]];
} else {
  console.error(`unknown template "${arg}" — use listing | trending | ad | all`);
  process.exit(1);
}

const browser = await chromium.launch(CHROMIUM ? { executablePath: CHROMIUM } : {});
for (const job of jobs) await render(browser, job.kind, job);
await browser.close();
console.log(`\nbanners written to public/brand/templates/`);
