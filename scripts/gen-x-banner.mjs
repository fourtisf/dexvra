// Renders a premium Dexvra X/Twitter header (1500x500): the live website shown
// as a floating, tilted product screen with rim-light + glow, brand on the left,
// on the site's own premium background.
//   SITE_URL=http://127.0.0.1:3232/ CHROMIUM_PATH=/opt/pw-browsers/chromium node scripts/gen-x-banner.mjs
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
const SITE = process.env.SITE_URL || "http://127.0.0.1:3232/";

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

const coin = (svg) => `<span style="display:grid;place-items:center;width:40px;height:40px;border-radius:50%;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1)">${svg}</span>`;
const chainRow = [
  `<svg viewBox="0 0 24 24" width="26" height="26"><defs><linearGradient id="cs" x1="3" y1="20" x2="21" y2="4" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#9945FF"/><stop offset="1" stop-color="#19FB9B"/></linearGradient></defs><g fill="url(#cs)"><path d="M6.4 4.6H21l-3.4 3.2H3z"/><path d="M3 10.4h14.6L21 13.6H6.4z"/><path d="M6.4 16.2H21l-3.4 3.2H3z"/></g></svg>`,
  `<svg viewBox="0 0 24 24" width="26" height="26"><circle cx="12" cy="12" r="10" fill="#F3BA2F"/><g fill="#fff" transform="translate(12 12) scale(0.64) translate(-12 -12)"><path d="M16.624 13.9202l2.7175 2.7175-7.353 7.353-7.353-7.352 2.7175-2.7175 4.6355 4.6355 4.6355-4.6365zm4.6355-4.6355L24 12l-2.7415 2.7415L18.5415 12l2.7175-2.7153zm-9.271.0005l2.7188 2.7167-2.7189 2.7186-2.7175-2.7168.0006-.0006.4762-.4763.2307-.2304 2.0093-2.011zM5.458 9.2842l2.7175 2.7178L5.458 14.72l-2.7176-2.718L5.458 9.2842zM11.9885.2842l7.353 7.3525-2.7168 2.7175-4.6362-4.6355-4.6355 4.6383L4.6362 7.6372 11.9885.2842z"/></g></svg>`,
  `<svg viewBox="0 0 24 24" width="26" height="26"><g fill="#8A92B2"><path d="M12 2 5.5 12.3 12 16z"/><path d="M12 2 18.5 12.3 12 16z" fill="#62688F"/><path d="M12 17.2 5.5 13.5 12 22z"/><path d="M12 17.2 18.5 13.5 12 22z" fill="#62688F"/></g></svg>`,
  `<svg viewBox="0 0 24 24" width="26" height="26"><circle cx="12" cy="12" r="10" fill="#0052FF"/><path d="M12 5.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 6.4-5.4H8.6v-2.2h9.8A6.5 6.5 0 0 0 12 5.5z" fill="#fff"/></svg>`,
  `<svg viewBox="0 0 24 24" width="26" height="26"><circle cx="12" cy="12" r="10" fill="#EF0027"/><path d="M6.2 7.4 15.4 8.9c.3 0 .5.2.6.4l2 3.3c.2.3.1.6-.1.8L11.6 18c-.3.3-.8.1-.9-.3L6 8c-.1-.4.2-.7.6-.6z" fill="#fff"/></svg>`,
  `<svg viewBox="0 0 24 24" width="26" height="26"><circle cx="12" cy="12" r="10" fill="#0098EA"/><path d="M7.5 8.5h9L12 17zM12 9.7 9.6 9.7 12 14.4 14.4 9.7z" fill="#fff"/></svg>`,
].map(coin).join("");

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});

// 1) product screenshot of the live homepage (hero + cards — the premium slice)
const shotPage = await browser.newPage({ viewport: { width: 1340, height: 900 }, deviceScaleFactor: 2 });
await shotPage.goto(SITE, { waitUntil: "networkidle", timeout: 30000 }).catch(() => {});
await shotPage.waitForTimeout(2800);
const shotBuf = await shotPage.screenshot({ clip: { x: 0, y: 0, width: 1340, height: 616 } });
const shot = shotBuf.toString("base64");
await shotPage.close();

// 2) compose the premium banner
const banner = `
<div style="width:1500px;height:500px;position:relative;overflow:hidden;font-family:${FONT};background:
  radial-gradient(1100px 520px at 30% -34%, rgba(255,255,255,.05), transparent 60%),
  radial-gradient(900px 700px at 96% 52%, rgba(34,211,238,.10), transparent 60%),
  radial-gradient(700px 520px at 60% 128%, rgba(75,252,166,.06), transparent 60%),
  #080B11;">
  <!-- faint dot grid for texture -->
  <div style="position:absolute;inset:0;background-image:radial-gradient(rgba(255,255,255,.035) 1px,transparent 1px);background-size:24px 24px;opacity:.5"></div>
  <!-- glow behind the screen -->
  <div style="position:absolute;right:40px;top:50%;transform:translateY(-50%);width:820px;height:540px;border-radius:50%;background:radial-gradient(closest-side,rgba(34,211,238,.28),rgba(75,252,166,.08) 55%,transparent 72%);filter:blur(26px)"></div>

  <!-- tilted product screen -->
  <div style="position:absolute;right:-70px;top:50%;transform:translateY(-50%) perspective(2200px) rotateY(-19deg) rotateX(4deg) scale(1.02);transform-origin:left center">
    <div style="border-radius:20px;overflow:hidden;border:1px solid rgba(255,255,255,.14);
      box-shadow:0 0 0 1px rgba(34,211,238,.16), 0 60px 130px rgba(0,0,0,.72), 0 24px 70px rgba(34,211,238,.14);">
      <img src="data:image/png;base64,${shot}" style="display:block;width:1000px"/>
      <div style="position:absolute;inset:0;background:linear-gradient(120deg,rgba(255,255,255,.10),transparent 26%)"></div>
    </div>
  </div>

  <!-- left scrim so the brand reads over the screen -->
  <div style="position:absolute;inset:0;background:linear-gradient(90deg,#080B11 31%,rgba(8,11,17,.74) 44%,rgba(8,11,17,0) 60%)"></div>

  <!-- brand lockup -->
  <div style="position:absolute;left:100px;top:0;bottom:0;width:600px;display:flex;flex-direction:column;justify-content:center;gap:20px">
    <div style="display:flex;align-items:center;gap:24px">
      <div style="filter:drop-shadow(0 10px 26px rgba(34,211,238,.45))">${gem(102)}</div>
      <div>
        <div style="font-size:80px;font-weight:800;letter-spacing:-.035em;color:#F2F6FC;line-height:.94">Dexvra</div>
        <div style="font-family:${MONO};font-size:16.5px;font-weight:700;letter-spacing:.36em;color:${CYAN};text-transform:uppercase;margin-top:10px">Multi‑chain Discovery</div>
      </div>
    </div>
    <div style="width:190px;height:3px;border-radius:99px;background:linear-gradient(90deg,${MINT},${CYAN} 60%,transparent)"></div>
    <div style="font-size:29px;font-weight:500;color:#AEBCCF;max-width:18ch;line-height:1.35">Find the next moonshot first — across every chain.</div>
    <div style="display:flex;align-items:center;gap:14px;margin-top:2px">
      <div style="display:flex;align-items:center;gap:9px">${chainRow}</div>
    </div>
    <div style="display:flex;align-items:center;gap:12px;margin-top:2px">
      <span style="font-family:${MONO};font-size:18px;font-weight:700;letter-spacing:.16em;color:${MINT};text-transform:uppercase;border:1px solid rgba(75,252,166,.35);border-radius:999px;padding:8px 16px;background:rgba(75,252,166,.06)">dexvra.io</span>
      <span style="font-size:15px;color:#7b8aa0">Trending · Scanner · Paid listings</span>
    </div>
  </div>
</div>`;

const page = await browser.newPage({ viewport: { width: 1500, height: 500 }, deviceScaleFactor: 2 });
await page.setContent(`<!doctype html><html><head><style>*{margin:0;padding:0;box-sizing:border-box}</style></head><body>${banner}</body></html>`, { waitUntil: "networkidle" });
await page.screenshot({ path: resolve(BRAND, "x-header.png"), clip: { x: 0, y: 0, width: 1500, height: 500 } });
await browser.close();
console.log("premium x-header written to public/brand/x-header.png");
