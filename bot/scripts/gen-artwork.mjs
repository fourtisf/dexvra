// Generate the bundled Dexvra channel-banner ARTWORK (illustration-grade, via
// Chromium/CSS: real gaussian blur, glass, specular light — things raw canvas
// can't do). Output: assets/banner-artwork-listing.png / -trending.png at
// 2560×1280 (2x of 1280×640). The bannerTemplate compositor pastes each
// token's logo into the glowing ring (see DEFAULTS there for the ring coords).
//   cd /home/user/dexvra && node bot/scripts/gen-artwork.mjs
import { chromium } from "playwright";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, "..", "assets");
const FONTS = path.join(OUT, "fonts");

const page_html = (KIND) => {
  const isTrend = KIND === "trending";
  const ACC = isTrend ? "#38D8F0" : "#4EE6A8"; // accent
  const ACC2 = isTrend ? "#0E9BD6" : "#22D3EE";
  const LABEL = isTrend ? "TRENDING NOW" : "NEW LISTING";
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  @font-face { font-family:'Sora'; font-weight:800; src:url('file://${FONTS}/Sora-800.ttf'); }
  @font-face { font-family:'Sora'; font-weight:700; src:url('file://${FONTS}/Sora-700.ttf'); }
  @font-face { font-family:'Sora'; font-weight:600; src:url('file://${FONTS}/Sora-600.ttf'); }
  @font-face { font-family:'Sora'; font-weight:500; src:url('file://${FONTS}/Sora-500.ttf'); }
  * { margin:0; padding:0; box-sizing:border-box; }
  body { width:1280px; height:640px; overflow:hidden; font-family:'Sora',sans-serif; position:relative;
    background:
      radial-gradient(90% 120% at 8% 0%, #0a1b1a 0%, transparent 55%),
      radial-gradient(110% 130% at 96% 100%, #082026 0%, transparent 60%),
      radial-gradient(70% 90% at 85% 10%, #071a20 0%, transparent 55%),
      #04080c; }

  /* ── smoky depth background (all gradients fade out well inside their box —
        no hard edges) ── */
  .blob { position:absolute; border-radius:50%; filter:blur(70px); }
  .b1 { width:900px; height:700px; left:-320px; top:-300px; background:radial-gradient(circle, ${ACC}1c 0%, transparent 55%); }
  .b2 { width:1100px; height:900px; right:-380px; bottom:-460px; background:radial-gradient(circle, ${ACC2}20 0%, transparent 55%); }
  .smoke { position:absolute; border-radius:50%; filter:blur(40px); }
  .s1 { width:820px; height:820px; left:-260px; top:80px;
    background:radial-gradient(circle, transparent 52%, rgba(120,220,205,.05) 62%, transparent 74%); }
  .s2 { width:1000px; height:1000px; right:-320px; top:-440px;
    background:radial-gradient(circle, transparent 52%, rgba(90,210,230,.055) 63%, transparent 75%); }
  .s3 { width:640px; height:640px; left:400px; bottom:-380px;
    background:radial-gradient(circle, transparent 50%, rgba(120,220,205,.045) 61%, transparent 73%); }
  .vig { position:absolute; inset:0; background:radial-gradient(120% 120% at 50% 45%, transparent 55%, rgba(0,0,0,.5)); }

  /* ── brand ── */
  .brand { position:absolute; left:56px; top:44px; display:flex; align-items:center; gap:16px; }
  .brand svg { filter:drop-shadow(0 4px 14px ${ACC2}66); }
  .brand .word { font-weight:800; font-size:40px; color:#F2FAF8; letter-spacing:1px; }

  /* ── glossy status pill ── */
  .pill { position:absolute; left:210px; top:170px; padding:3px; border-radius:40px;
    background:linear-gradient(135deg, ${ACC}cc, ${ACC2}55 45%, ${ACC}cc);
    box-shadow:0 0 44px ${ACC}59, 0 10px 30px rgba(0,0,0,.5); }
  .pill .in { border-radius:37px; padding:14px 42px; position:relative; overflow:hidden;
    background:linear-gradient(180deg, #10231f, #0a1613);
    display:flex; align-items:center; gap:14px; }
  .pill .in::after { content:''; position:absolute; left:8%; top:2px; width:84%; height:46%;
    border-radius:30px; background:linear-gradient(180deg, rgba(255,255,255,.22), rgba(255,255,255,0)); }
  .pill .dot { width:13px; height:13px; border-radius:50%; background:${ACC};
    box-shadow:0 0 16px ${ACC}, 0 0 34px ${ACC}aa; }
  .pill .txt { font-weight:800; font-size:30px; letter-spacing:3px; color:#ECFFF7;
    text-shadow:0 0 22px ${ACC}88; }

  /* ── socials row ── */
  .socials { position:absolute; left:60px; bottom:52px; display:flex; gap:44px; }
  .soc { display:flex; align-items:center; gap:13px; }
  .soc .ic { width:46px; height:46px; border-radius:50%;
    background:linear-gradient(160deg, ${ACC}2b, #0d1a17 70%);
    border:1.5px solid ${ACC}59; display:flex; align-items:center; justify-content:center;
    box-shadow:0 6px 18px rgba(0,0,0,.45), inset 0 1px 0 rgba(255,255,255,.14); }
  .soc .tt { line-height:1.25; }
  .soc .lab { font-weight:500; font-size:17px; color:#8FA7A4; }
  .soc .val { font-weight:700; font-size:20px; color:#EAF6F2; }

  /* ── hero: gem + ring + pedestal (right) ── */
  .hero { position:absolute; right:0; top:0; width:520px; height:640px; }
  .halo { position:absolute; right:-110px; top:40px; width:640px; height:640px; border-radius:50%;
    background:radial-gradient(circle, ${ACC2}30, transparent 62%); filter:blur(50px); }

  /* glowing ring — the token logo is composited into its center */
  .ring { position:absolute; left:158px; top:178px; width:264px; height:264px; border-radius:50%;
    background:conic-gradient(from 140deg, ${ACC2}, ${ACC} 25%, #BFFFE4 40%, ${ACC} 55%, ${ACC2} 78%, #0E9BD6 90%, ${ACC2});
    box-shadow:0 0 70px ${ACC}59, 0 0 150px ${ACC2}38, 0 24px 50px rgba(0,0,0,.55);
    display:flex; align-items:center; justify-content:center; }
  .ring .hole { width:214px; height:214px; border-radius:50%; position:relative;
    background:radial-gradient(circle at 38% 30%, #0f1c21, #060c10 75%);
    box-shadow:inset 0 8px 28px rgba(0,0,0,.85), inset 0 -2px 12px rgba(255,255,255,.06); }
  .ring .hole::after { content:''; position:absolute; inset:0; border-radius:50%;
    border:1.5px solid rgba(255,255,255,.16); }
  .ring::after { content:''; position:absolute; inset:-24px; border-radius:50%;
    border:2px dashed ${ACC}42; }
  /* specular arc along the ring's upper edge */
  .ringShine { position:absolute; left:158px; top:178px; width:264px; height:264px; border-radius:50%;
    background:conic-gradient(from 300deg, transparent 0 12%, rgba(255,255,255,.55) 22%, transparent 34% 100%);
    -webkit-mask:radial-gradient(circle, transparent 0 102px, #000 104px 130px, transparent 133px);
    filter:blur(1.5px); }

  /* faceted gem docked behind the ring's top edge */
  .gem { position:absolute; left:216px; top:34px; z-index:0;
    filter:drop-shadow(0 16px 30px rgba(0,0,0,.6)) drop-shadow(0 0 30px ${ACC2}77); }
  .gemGlow { position:absolute; left:180px; top:10px; width:230px; height:190px; border-radius:50%;
    background:radial-gradient(circle, ${ACC}36, transparent 66%); filter:blur(26px); }
  .ring, .ringShine { z-index:1; }

  /* glass slab platform + light pool */
  .ped { position:absolute; left:150px; top:474px; width:280px; height:120px; }
  .ped .slab { position:absolute; left:14px; top:14px; width:252px; height:26px; border-radius:13px;
    background:linear-gradient(90deg, ${ACC2}22, ${ACC}44 50%, ${ACC2}22);
    border:1.4px solid ${ACC}55;
    box-shadow:0 0 36px ${ACC2}40, inset 0 2px 5px rgba(255,255,255,.22), inset 0 -6px 12px rgba(0,0,0,.35); }
  .ped .pool { position:absolute; left:0; top:34px; width:280px; height:42px; border-radius:50%;
    background:radial-gradient(ellipse, ${ACC2}38, transparent 68%); filter:blur(14px); }
  .ped .refl { position:absolute; left:64px; top:48px; width:152px; height:56px; border-radius:50%;
    background:radial-gradient(ellipse, ${ACC}20, transparent 70%); filter:blur(16px); }

  /* floating gem-coins */
  .coin { position:absolute; border-radius:50%; display:flex; align-items:center; justify-content:center;
    background:radial-gradient(circle at 34% 28%, #1b3a37, #0a1a1c 72%);
    border:1.6px solid ${ACC}66; box-shadow:0 10px 24px rgba(0,0,0,.5), inset 0 2px 6px rgba(255,255,255,.14), 0 0 26px ${ACC}33; }
  .coin svg { opacity:.95; }
  .c1 { width:74px; height:74px; left:66px;  top:150px; transform:rotate(-14deg); }
  .c2 { width:56px; height:56px; left:452px; top:130px; transform:rotate(12deg);  filter:blur(1px); }
  .c3 { width:64px; height:64px; left:56px;  top:388px; transform:rotate(10deg);  filter:blur(.6px); }
  .c4 { width:46px; height:46px; left:460px; top:372px; transform:rotate(-18deg); filter:blur(1.6px); }
  .c5 { width:38px; height:38px; left:120px; top:16px;  transform:rotate(20deg);  filter:blur(2.2px); }
  .spark { position:absolute; color:#EAFFF7; text-shadow:0 0 12px ${ACC}; font-size:26px; }
  .sp1 { left:452px; top:296px; } .sp2 { left:96px; top:296px; font-size:18px; opacity:.8; }

  /* grain */
  .grain { position:absolute; inset:0; opacity:.05; }
  </style></head><body>
  <div class="blob b1"></div><div class="blob b2"></div><div class="blob b3"></div>
  <div class="smoke s1"></div><div class="smoke s2"></div><div class="smoke s3"></div>

  <div class="hero">
    <div class="halo"></div>
    <div class="gemGlow"></div>
    <div class="gem">${gemSvg(160)}</div>
    <div class="ped"><div class="pool"></div><div class="slab"></div><div class="refl"></div></div>
    <div class="ring"><div class="hole"></div></div>
    <div class="ringShine"></div>
    <div class="coin c1">${gemSvg(38)}</div>
    <div class="coin c2">${gemSvg(28)}</div>
    <div class="coin c3">${gemSvg(32)}</div>
    <div class="coin c4">${gemSvg(22)}</div>
    <div class="coin c5">${gemSvg(18)}</div>
    <div class="spark sp1">✦</div><div class="spark sp2">✦</div>
  </div>

  <div class="vig"></div>

  <div class="brand">${gemSvg(52)}<div class="word">Dexvra</div></div>

  <div class="pill"><div class="in"><div class="dot"></div><div class="txt">${LABEL}</div></div></div>

  <div class="socials">
    <div class="soc"><div class="ic">${globeSvg(22)}</div><div class="tt"><div class="lab">Website:</div><div class="val">dexvra.io</div></div></div>
    <div class="soc"><div class="ic">${tgSvg(22)}</div><div class="tt"><div class="lab">Telegram:</div><div class="val">@dexvra${isTrend ? "trending" : "listing"}</div></div></div>
    <div class="soc"><div class="ic">${xSvg(19)}</div><div class="tt"><div class="lab">X:</div><div class="val">@dexvra</div></div></div>
  </div>

  <svg class="grain"><filter id="n"><feTurbulence type="fractalNoise" baseFrequency="0.8" numOctaves="2"/></filter><rect width="100%" height="100%" filter="url(#n)"/></svg>
  </body></html>`;
};

// Faceted Dexvra gem (brand mark) with per-facet gradients + specular hints.
function gemSvg(size) {
  const id = Math.random().toString(36).slice(2, 7);
  return `<svg width="${size}" height="${size}" viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="ga${id}" x1="9" y1="12" x2="39" y2="37" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#7CFFC8"/><stop offset=".5" stop-color="#38D8F0"/><stop offset="1" stop-color="#0E9BD6"/>
    </linearGradient>
    <linearGradient id="gb${id}" x1="24" y1="19" x2="24" y2="37" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#4EE6A8"/><stop offset="1" stop-color="#0B86BE"/>
    </linearGradient>
  </defs>
  <polygon points="15,12 33,12 39,19 24,37 9,19" fill="url(#ga${id})"/>
  <polygon points="20,19 28,19 24,37" fill="url(#gb${id})"/>
  <polygon points="15,12 20,19 9,19" fill="#8FFAD2" opacity=".85"/>
  <polygon points="33,12 39,19 28,19" fill="#2CC4E8" opacity=".9"/>
  <polygon points="15,12 33,12 28,19 20,19" fill="#B7FFE3" opacity=".75"/>
  <polygon points="9,19 20,19 24,37" fill="#1FB5DE" opacity=".85"/>
  <polygon points="16,13 20,13 18.4,15.4" fill="#fff" opacity=".8"/>
  <path d="M9 19 L39 19" stroke="rgba(6,14,18,.4)" stroke-width="1"/>
  <path d="M20 19 L24 37 L28 19" stroke="rgba(6,14,18,.35)" stroke-width="1" fill="none"/>
</svg>`;
}
const globeSvg = (s) =>
  `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="#CFF3E8" stroke-width="1.7"><circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18M4.6 7h14.8M4.6 17h14.8"/></svg>`;
const tgSvg = (s) =>
  `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="#CFF3E8"><path d="M23.91 3.79L20.3 20.84c-.25 1.21-.98 1.5-2 .94l-5.5-4.07-2.66 2.57c-.3.3-.55.56-1.1.56-.72 0-.6-.27-.84-.95L6.3 13.7l-5.45-1.7c-1.18-.36-1.19-1.16.26-1.75l21.26-8.2c.97-.36 1.9.23 1.53 1.73z"/></svg>`;
const xSvg = (s) =>
  `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="#CFF3E8"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>`;

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  args: ["--no-sandbox", "--disable-setuid-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 640 }, deviceScaleFactor: 2 });
for (const kind of ["listing", "trending"]) {
  await page.setContent(page_html(kind), { waitUntil: "networkidle" });
  await page.waitForTimeout(250);
  const out = path.join(OUT, `banner-artwork-${kind}.png`);
  await page.screenshot({ path: out });
  console.log("wrote", out);
}
await browser.close();
