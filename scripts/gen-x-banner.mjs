// Renders the Dexvra X/Twitter header (1500x500) via Chromium.
//   CHROMIUM_PATH=/opt/pw-browsers/chromium node scripts/gen-x-banner.mjs
import { chromium } from "playwright";
import { mkdirSync, readFileSync } from "node:fs";
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
    <rect x="2" y="2" width="44" height="44" rx="13" fill="none" stroke="url(#bg)" stroke-opacity=".45" stroke-width="1.5"/>
    <path d="M15 12 H33 L39 19 L24 37 L9 19 Z" fill="url(#bg)"/>
    <g stroke="#0A0E16" stroke-width="1.3" stroke-opacity=".5" fill="none">
      <path d="M9 19 H39"/><path d="M15 12 L20 19"/><path d="M33 12 L28 19"/><path d="M20 19 H28"/><path d="M20 19 L24 37"/><path d="M28 19 L24 37"/></g>
    <path d="M15.6 12.5 H22 L19 18.5 H10.5 Z" fill="#fff" fill-opacity=".14"/>
  </svg>`;

// small chain marks
const chains = {
  sol: `<svg viewBox="0 0 24 24" width="30" height="30"><defs><linearGradient id="s" x1="3" y1="20" x2="21" y2="4" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#9945FF"/><stop offset="1" stop-color="#19FB9B"/></linearGradient></defs><g fill="url(#s)"><path d="M6.4 4.6H21l-3.4 3.2H3z"/><path d="M3 10.4h14.6L21 13.6H6.4z"/><path d="M6.4 16.2H21l-3.4 3.2H3z"/></g></svg>`,
  bnb: `<svg viewBox="0 0 24 24" width="30" height="30"><circle cx="12" cy="12" r="10" fill="#F3BA2F"/><g fill="#fff"><path d="M12 4.5 14.5 7 12 9.5 9.5 7z"/><path d="M7 9.5 9.5 12 7 14.5 4.5 12z"/><path d="M17 9.5 19.5 12 17 14.5 14.5 12z"/><path d="M12 14.5 14.5 17 12 19.5 9.5 17z"/><path d="M12 9.5 14.5 12 12 14.5 9.5 12z"/></g></svg>`,
  eth: `<svg viewBox="0 0 24 24" width="30" height="30"><g fill="#8A92B2"><path d="M12 2 5.5 12.3 12 16z"/><path d="M12 2 18.5 12.3 12 16z" fill="#62688F"/><path d="M12 17.2 5.5 13.5 12 22z"/><path d="M12 17.2 18.5 13.5 12 22z" fill="#62688F"/></g></svg>`,
  base: `<svg viewBox="0 0 24 24" width="30" height="30"><circle cx="12" cy="12" r="10" fill="#0052FF"/><path d="M12 5.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 6.4-5.4H8.6v-2.2h9.8A6.5 6.5 0 0 0 12 5.5z" fill="#fff"/></svg>`,
  tron: `<svg viewBox="0 0 24 24" width="30" height="30"><circle cx="12" cy="12" r="10" fill="#EF0027"/><path d="M6.2 7.4 15.4 8.9c.3 0 .5.2.6.4l2 3.3c.2.3.1.6-.1.8L11.6 18c-.3.3-.8.1-.9-.3L6 8c-.1-.4.2-.7.6-.6z" fill="#fff"/></svg>`,
  ton: `<svg viewBox="0 0 24 24" width="30" height="30"><circle cx="12" cy="12" r="10" fill="#0098EA"/><path d="M7.5 8.5h9L12 17zM12 9.7 9.6 9.7 12 14.4 14.4 9.7z" fill="#fff"/></svg>`,
};
const chainRow = Object.values(chains).map((c) => `<span style="display:grid;place-items:center;width:44px;height:44px;border-radius:50%;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1)">${c}</span>`).join("");

const banner = `
<div style="width:1500px;height:500px;position:relative;overflow:hidden;font-family:${FONT};background:
  radial-gradient(820px 540px at 85% -20%, rgba(34,211,238,.20), transparent 60%),
  radial-gradient(760px 520px at 8% 122%, rgba(75,252,166,.15), transparent 58%),
  #0A0E16;">
  <div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:26px;text-align:center;padding:0 120px">
    <div style="display:flex;align-items:center;gap:30px">
      ${gem(120)}
      <div style="text-align:left">
        <div style="font-size:96px;font-weight:800;letter-spacing:-.035em;color:#EEF3FB;line-height:.95">Dexvra</div>
        <div style="font-family:${MONO};font-size:19px;font-weight:700;letter-spacing:.36em;color:${CYAN};text-transform:uppercase;margin-top:10px">Multi‑chain Discovery</div>
      </div>
    </div>
    <div style="font-size:32px;font-weight:500;color:#9FB0C6;max-width:60ch;line-height:1.4">Find the next moonshot first — trending boards, token safety scans &amp; paid listings across every chain.</div>
    <div style="display:flex;align-items:center;gap:16px;margin-top:4px">
      ${chainRow}
      <span style="font-family:${MONO};font-size:20px;font-weight:700;letter-spacing:.18em;color:${MINT};text-transform:uppercase;margin-left:10px">dexvra.io</span>
    </div>
  </div>
</div>`;

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const page = await browser.newPage({ viewport: { width: 1500, height: 500 }, deviceScaleFactor: 2 });
await page.setContent(`<!doctype html><html><head><style>*{margin:0;padding:0;box-sizing:border-box}</style></head><body>${banner}</body></html>`, { waitUntil: "networkidle" });
await page.screenshot({ path: resolve(BRAND, "x-header.png"), clip: { x: 0, y: 0, width: 1500, height: 500 } });
await browser.close();
console.log("x-header written to public/brand/x-header.png");
