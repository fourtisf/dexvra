// Renders every Dexvra brand asset from one vector source via Chromium, so
// favicons / app icons / social image all stay pixel-identical to the SVG mark.
//   CHROMIUM_PATH=/opt/pw-browsers/chromium node scripts/gen-brand-assets.mjs
import { chromium } from "playwright";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ICONS = resolve(ROOT, "public/icons");
const BRAND = resolve(ROOT, "public/brand");
mkdirSync(ICONS, { recursive: true });
mkdirSync(BRAND, { recursive: true });

const MINT = "#4BFCA6", CYAN = "#22D3EE", INK = "#03150B", BG = "#090C12";

// The vector gem badge (dark tile + gradient brilliant-cut gem — matches the
// in-app Logo). `square` = full-bleed (maskable); otherwise rounded.
// `pad` shrinks the glyph to leave a maskable safe zone.
function badgeSvg({ square = false, pad = 0 } = {}) {
  const rx = square ? 0 : 118;
  const scale = 1 - pad;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="b" x1="96" y1="128" x2="416" y2="395" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="${MINT}"/><stop offset="0.55" stop-color="${CYAN}"/><stop offset="1" stop-color="#12B9E0"/>
    </linearGradient>
  </defs>
  <rect x="0" y="0" width="512" height="512" rx="${rx}" fill="#0A0E16"/>
  <g transform="translate(${256 * pad} ${256 * pad}) scale(${scale})">
    <path d="M160 128 H352 L416 203 L256 395 L96 203 Z" fill="url(#b)"/>
    <g stroke="#0A0E16" stroke-width="14" stroke-opacity="0.5" fill="none">
      <path d="M96 203 H416"/><path d="M160 128 L213 203"/><path d="M352 128 L299 203"/>
      <path d="M213 203 H299"/><path d="M213 203 L256 395"/><path d="M299 203 L256 395"/>
    </g>
    <path d="M166 133 H235 L203 197 H112 Z" fill="#ffffff" fill-opacity="0.14"/>
  </g>
</svg>`;
}

// glowing gem badge as a standalone element (matches the app's .brand-logo)
function markHtml(size) {
  return `<div style="width:${size}px;height:${size}px;border-radius:${size * 0.27}px;
    background:#0A0E16;border:1px solid rgba(75,252,166,.35);
    box-shadow:0 ${size*0.05}px ${size*0.14}px rgba(34,211,238,.32);
    display:grid;place-items:center;position:relative;overflow:hidden">
    <svg viewBox="0 0 512 512" style="width:74%;height:74%;position:relative">
      <defs><linearGradient id="m${size}" x1="96" y1="128" x2="416" y2="395" gradientUnits="userSpaceOnUse">
        <stop offset="0" stop-color="${MINT}"/><stop offset="0.55" stop-color="${CYAN}"/><stop offset="1" stop-color="#12B9E0"/></linearGradient></defs>
      <path d="M160 128 H352 L416 203 L256 395 L96 203 Z" fill="url(#m${size})"/>
      <g stroke="#0A0E16" stroke-width="14" stroke-opacity="0.5" fill="none">
        <path d="M96 203 H416"/><path d="M213 203 H299"/><path d="M213 203 L256 395"/><path d="M299 203 L256 395"/>
      </g>
    </svg></div>`;
}

const WORDMARK_FONT = `'Space Grotesk','Liberation Sans','DejaVu Sans',system-ui,sans-serif`;
function wordmark(px, color = "#F1F5FB") {
  return `<span style="font-family:${WORDMARK_FONT};font-weight:700;font-size:${px}px;letter-spacing:-0.02em;color:${color};line-height:1">Dexvra</span>`;
}

const browser = await chromium.launch(
  process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
);

async function shoot(html, w, h, outPath, { omit = true, scale = 1 } = {}) {
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: scale });
  await page.setContent(
    `<!doctype html><html><head><style>*{margin:0;padding:0;box-sizing:border-box}
     html,body{width:${w}px;height:${h}px}</style></head><body>${html}</body></html>`,
    { waitUntil: "networkidle" },
  );
  await page.screenshot({ path: outPath, omitBackground: omit, clip: { x: 0, y: 0, width: w, height: h } });
  await page.close();
}

const svgToImg = (svg, size) =>
  `<img src="data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}" width="${size}" height="${size}" style="display:block"/>`;

// ---- favicons + app icons (rounded, "any") ----
for (const s of [16, 32, 48, 64, 180, 192, 512]) {
  await shoot(svgToImg(badgeSvg(), s), s, s, resolve(ICONS, `icon-${s}.png`));
}
// ---- maskable (full-bleed square, padded glyph) ----
await shoot(svgToImg(badgeSvg({ square: true, pad: 0.14 }), 512), 512, 512, resolve(ICONS, "icon-maskable-512.png"));
// apple-touch expects a specific name
writeFileSync(resolve(ICONS, "apple-touch-icon.png"), readFileSync(resolve(ICONS, "icon-180.png")));

// ---- standalone glowing logomark (transparent) ----
await shoot(`<div style="padding:60px">${markHtml(440)}</div>`, 560, 560, resolve(BRAND, "logomark.png"));

// ---- horizontal lockup (transparent, light + dark text) ----
const lockup = (color) =>
  `<div style="display:flex;align-items:center;gap:26px;padding:40px 48px">${markHtml(104)}${wordmark(72, color)}</div>`;
await shoot(lockup("#F1F5FB"), 470, 184, resolve(BRAND, "logo-horizontal-light.png"));
await shoot(lockup("#0B0E15"), 470, 184, resolve(BRAND, "logo-horizontal-dark.png"));

// ---- social / OG banner (1200x630, dark) ----
const og = `<div style="width:1200px;height:630px;background:
   radial-gradient(900px 480px at 82% -10%, rgba(61,245,159,.16), transparent 58%),
   radial-gradient(760px 460px at -6% 12%, rgba(34,211,238,.14), transparent 55%), ${BG};
   display:flex;flex-direction:column;align-items:center;justify-content:center;gap:34px;font-family:${WORDMARK_FONT}">
   <div style="display:flex;align-items:center;gap:34px">${markHtml(150)}<span style="font-weight:700;font-size:110px;letter-spacing:-0.02em;color:#F1F5FB">Dexvra</span></div>
   <div style="font-weight:600;font-size:34px;color:#9AA6BC;letter-spacing:.01em">Find the next moonshot first — across every chain.</div>
   <div style="font-family:'DejaVu Sans Mono',monospace;font-weight:700;font-size:22px;color:#3DF59F;letter-spacing:.22em;text-transform:uppercase">dexvra.io</div>
 </div>`;
await shoot(og, 1200, 630, resolve(BRAND, "og-image.png"), { omit: false });

await browser.close();

// ---- pack favicon.ico (16/32/48, PNG-embedded, Vista+) ----
function packIco(pngPaths) {
  const imgs = pngPaths.map((p) => {
    const buf = readFileSync(p.path);
    return { size: p.size, buf };
  });
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(imgs.length, 4);
  const entries = [];
  let offset = 6 + imgs.length * 16;
  for (const im of imgs) {
    const e = Buffer.alloc(16);
    e.writeUInt8(im.size >= 256 ? 0 : im.size, 0);
    e.writeUInt8(im.size >= 256 ? 0 : im.size, 1);
    e.writeUInt8(0, 2);
    e.writeUInt8(0, 3);
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(im.buf.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += im.buf.length;
    entries.push(e);
  }
  return Buffer.concat([header, ...entries, ...imgs.map((i) => i.buf)]);
}
writeFileSync(
  resolve(ROOT, "public/favicon.ico"),
  packIco([16, 32, 48].map((s) => ({ size: s, path: resolve(ICONS, `icon-${s}.png`) }))),
);

console.log("brand assets written to public/icons and public/brand, favicon.ico packed");
