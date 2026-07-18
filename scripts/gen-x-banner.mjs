// Renders the Dexvra X/Twitter header (1500x500) as a product shot of the real
// website on the site's own premium background.
//   SITE_URL=http://127.0.0.1:3231/ CHROMIUM_PATH=/opt/pw-browsers/chromium node scripts/gen-x-banner.mjs
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
const SITE = process.env.SITE_URL || "http://127.0.0.1:3231/";

const gem = (size) => `
  <svg viewBox="0 0 48 48" width="${size}" height="${size}" style="display:block">
    <defs><linearGradient id="bg" x1="9" y1="12" x2="39" y2="37" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="${MINT}"/><stop offset=".55" stop-color="${CYAN}"/><stop offset="1" stop-color="${DEEP}"/></linearGradient></defs>
    <rect x="2" y="2" width="44" height="44" rx="13" fill="#0A0E16"/>
    <rect x="2" y="2" width="44" height="44" rx="13" fill="none" stroke="url(#bg)" stroke-opacity=".45" stroke-width="1.5"/>
    <path d="M15 12 H33 L39 19 L24 37 L9 19 Z" fill="url(#bg)"/>
    <g stroke="#0A0E16" stroke-width="1.3" stroke-opacity=".5" fill="none">
      <path d="M9 19 H39"/><path d="M15 12 L20 19"/><path d="M33 12 L28 19"/><path d="M20 19 H28"/><path d="M20 19 L24 37"/><path d="M28 19 L24 37"/></g>
    <path d="M15.6 12.5 H22 L19 18.5 H10.5 Z" fill="#fff" fill-opacity=".14"/>
  </svg>`;

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});

// 1) grab a clean product screenshot of the live homepage
const shotPage = await browser.newPage({ viewport: { width: 1320, height: 900 }, deviceScaleFactor: 1.5 });
await shotPage.goto(SITE, { waitUntil: "networkidle", timeout: 30000 }).catch(() => {});
await shotPage.waitForTimeout(2800);
const shotBuf = await shotPage.screenshot({ clip: { x: 0, y: 0, width: 1320, height: 812 } });
const shot = shotBuf.toString("base64");
await shotPage.close();

// 2) compose the banner: brand on the left, product panel bleeding off the right
const banner = `
<div style="width:1500px;height:500px;position:relative;overflow:hidden;font-family:${FONT};background:
  radial-gradient(1200px 620px at 22% -30%, rgba(255,255,255,.05), transparent 62%),
  radial-gradient(760px 500px at 96% 118%, rgba(61,220,151,.06), transparent 60%),
  #090C12;">
  <img src="data:image/png;base64,${shot}"
    style="position:absolute;right:-150px;top:-46px;height:592px;border-radius:18px;
    border:1px solid rgba(255,255,255,.10);box-shadow:-46px 34px 100px rgba(0,0,0,.6)"/>
  <div style="position:absolute;inset:0;background:linear-gradient(90deg,#090C12 33%,rgba(9,12,18,.72) 45%,rgba(9,12,18,0) 63%)"></div>
  <div style="position:absolute;left:100px;top:0;bottom:0;width:640px;display:flex;flex-direction:column;justify-content:center;gap:22px">
    <div style="display:flex;align-items:center;gap:24px">
      ${gem(104)}
      <div>
        <div style="font-size:82px;font-weight:800;letter-spacing:-.035em;color:#EEF3FB;line-height:.95">Dexvra</div>
        <div style="font-family:${MONO};font-size:17px;font-weight:700;letter-spacing:.34em;color:${CYAN};text-transform:uppercase;margin-top:9px">Multi‑chain Discovery</div>
      </div>
    </div>
    <div style="font-size:29px;font-weight:500;color:#A6B4C8;max-width:19ch;line-height:1.4">Find the next moonshot first — across every chain.</div>
    <div style="display:flex;align-items:center;gap:12px">
      <span style="font-family:${MONO};font-size:20px;font-weight:700;letter-spacing:.16em;color:${MINT};text-transform:uppercase">dexvra.io</span>
      <span style="width:5px;height:5px;border-radius:50%;background:#3b4a5e"></span>
      <span style="font-size:16px;color:#7b8aa0">Trending · Scanner · Paid listings</span>
    </div>
  </div>
</div>`;

const page = await browser.newPage({ viewport: { width: 1500, height: 500 }, deviceScaleFactor: 2 });
await page.setContent(`<!doctype html><html><head><style>*{margin:0;padding:0;box-sizing:border-box}</style></head><body>${banner}</body></html>`, { waitUntil: "networkidle" });
await page.screenshot({ path: resolve(BRAND, "x-header.png"), clip: { x: 0, y: 0, width: 1500, height: 500 } });
await browser.close();
console.log("x-header written to public/brand/x-header.png");
