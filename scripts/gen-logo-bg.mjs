// Renders Dexvra logo images WITH a full premium background (not transparent):
//   - logo-full.png  (1200x1200) gem + wordmark card
//   - pfp.png        (1024x1024) gem-only, safe for a circular avatar crop
//   CHROMIUM_PATH=/opt/pw-browsers/chromium node scripts/gen-logo-bg.mjs
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BRAND = resolve(ROOT, "public/brand");
mkdirSync(BRAND, { recursive: true });

const MINT = "#4BFCA6", CYAN = "#22D3EE", DEEP = "#12B9E0";
const FONT = `'Space Grotesk','Liberation Sans','DejaVu Sans',system-ui,sans-serif`;
const MONO = `'DejaVu Sans Mono',ui-monospace,monospace`;

const gem = (size) => `
  <svg viewBox="0 0 48 48" width="${size}" height="${size}" style="display:block">
    <defs><linearGradient id="bg" x1="9" y1="12" x2="39" y2="37" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="${MINT}"/><stop offset=".55" stop-color="${CYAN}"/><stop offset="1" stop-color="${DEEP}"/></linearGradient></defs>
    <rect x="2" y="2" width="44" height="44" rx="13" fill="#0A0E16"/>
    <rect x="2" y="2" width="44" height="44" rx="13" fill="none" stroke="url(#bg)" stroke-opacity=".5" stroke-width="1.5"/>
    <path d="M15 12 H33 L39 19 L24 37 L9 19 Z" fill="url(#bg)"/>
    <g stroke="#0A0E16" stroke-width="1.3" stroke-opacity=".5" fill="none">
      <path d="M9 19 H39"/><path d="M15 12 L20 19"/><path d="M33 12 L28 19"/><path d="M20 19 H28"/><path d="M20 19 L24 37"/><path d="M28 19 L24 37"/></g>
    <path d="M15.6 12.5 H22 L19 18.5 H10.5 Z" fill="#fff" fill-opacity=".14"/>
  </svg>`;

const premiumBg = (extra = "") => `
  radial-gradient(60% 40% at 50% -8%, rgba(255,255,255,.05), transparent 60%),
  radial-gradient(52% 52% at 50% 46%, rgba(34,211,238,.14), transparent 62%),
  radial-gradient(60% 40% at 50% 120%, rgba(75,252,166,.07), transparent 60%),
  ${extra} #080B11`;

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});

async function render(html, size, out) {
  const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 2 });
  await page.setContent(`<!doctype html><html><head><style>*{margin:0;padding:0;box-sizing:border-box}</style></head><body>${html}</body></html>`, { waitUntil: "networkidle" });
  await page.screenshot({ path: resolve(BRAND, out), clip: { x: 0, y: 0, width: size, height: size } });
  await page.close();
  console.log("wrote", out);
}

// 1) full logo card (gem + wordmark) — 1200x1200
const dot = `<div style="position:absolute;inset:0;background-image:radial-gradient(rgba(255,255,255,.03) 1px,transparent 1px);background-size:30px 30px;opacity:.5"></div>`;
await render(`
  <div style="width:1200px;height:1200px;position:relative;overflow:hidden;font-family:${FONT};background:${premiumBg()}">
    ${dot}
    <div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:52px;text-align:center">
      <div style="filter:drop-shadow(0 26px 70px rgba(34,211,238,.5))">${gem(400)}</div>
      <div>
        <div style="font-size:150px;font-weight:800;letter-spacing:-.04em;color:#F2F6FC;line-height:.9">Dexvra</div>
        <div style="font-family:${MONO};font-size:27px;font-weight:700;letter-spacing:.42em;color:${CYAN};text-transform:uppercase;margin-top:26px">Multi‑chain Discovery</div>
      </div>
      <div style="font-family:${MONO};font-size:26px;font-weight:700;letter-spacing:.2em;color:${MINT};text-transform:uppercase;border:1px solid rgba(75,252,166,.35);border-radius:999px;padding:13px 30px;background:rgba(75,252,166,.06)">dexvra.io</div>
    </div>
  </div>`, 1200, "logo-full.png");

// 2) PFP (gem only, centered, glow) — 1024x1024, safe for circular crop
await render(`
  <div style="width:1024px;height:1024px;position:relative;overflow:hidden;font-family:${FONT};background:${premiumBg()}">
    ${dot}
    <div style="position:absolute;inset:0;display:grid;place-items:center">
      <div style="filter:drop-shadow(0 30px 80px rgba(34,211,238,.55))">${gem(560)}</div>
    </div>
  </div>`, 1024, "pfp.png");

await browser.close();
console.log("done");
