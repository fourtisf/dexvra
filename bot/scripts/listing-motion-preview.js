// Render the premium listing clip for a sample token, plus stills at the key
// moments of the loop and a contact sheet of them, so the design can be judged
// by LOOKING at it (the drawGem rule). No network.
//
// Run from bot/: node scripts/listing-motion-preview.js [outDir]
const path = require("node:path");
const fs = require("node:fs");
// .env before anything reaches config/constants — `loadEnv()` is the one owner
// of which .env counts (the footer prints the channel handles from it).
require("../src/config/loadEnv").loadEnv();
const lm = require("../src/listingMotion");
const { canvasLib } = require("../src/helpers/canvasKit");

(async () => {
  const outDir = process.argv[2] || path.join(process.cwd(), "listing-motion-preview");
  fs.mkdirSync(outDir, { recursive: true });
  const cv = canvasLib();
  // a stand-in logo: a red disc with a white wordmark
  const c = cv.createCanvas(400, 400);
  const x = c.getContext("2d");
  x.fillStyle = "#C8102E";
  x.beginPath();
  x.arc(200, 200, 200, 0, Math.PI * 2);
  x.fill();
  x.fillStyle = "#fff";
  x.font = "800 110px sans-serif";
  x.textAlign = "center";
  x.textBaseline = "middle";
  x.fillText("AMD", 200, 210);
  const logo = c.toBuffer("image/png");
  const coin = { symbol: "$AMD", name: "A Meme Dog", chain: "SOLANA", price: "$0.001618", mcap: "$1.6M", liq: "$131.2K" };
  const t0 = Date.now();
  const res = await lm.render(coin, logo, { badge: "Xpress Listing", outPath: path.join(outDir, "listing-premium.mp4") });
  console.log("render:", res, `${Date.now() - t0}ms`);

  const toCanvas = (buf) => {
    const cvs = cv.createCanvas(lm.W, lm.H);
    const ctx = cvs.getContext("2d");
    const id = ctx.createImageData(lm.W, lm.H);
    id.data.set(buf);
    ctx.putImageData(id, 0, 0);
    return cvs;
  };
  // the moments worth looking at, in seconds
  const moments = [0, 1.45, 3.5, 4.2, 4.72, 4.95, 5.3, 5.6];
  const want = new Set(moments.map((s) => Math.round(s * lm.FPS)));
  const shots = [];
  const all = await lm.frames(coin, logo, { count: Math.max(...want) + 1, badge: "Xpress Listing" });
  for (const f of [...want].sort((a, b) => a - b)) {
    const cvs = toCanvas(all[f]);
    fs.writeFileSync(path.join(outDir, `t${(f / lm.FPS).toFixed(2)}.png`), cvs.toBuffer("image/png"));
    shots.push([f, cvs]);
  }
  // contact sheet: 2 columns at half size
  const cols = 2;
  const sw = lm.W / 2;
  const sh = lm.H / 2;
  const sheet = cv.createCanvas(sw * cols, sh * Math.ceil(shots.length / cols));
  const sx = sheet.getContext("2d");
  shots.forEach(([f, cvs], i) => {
    const X = (i % cols) * sw;
    const Y = Math.floor(i / cols) * sh;
    sx.drawImage(cvs, X, Y, sw, sh);
    sx.fillStyle = "rgba(0,0,0,.7)";
    sx.fillRect(X + 6, Y + 6, 70, 22);
    sx.fillStyle = "#fff";
    sx.font = "600 14px sans-serif";
    sx.fillText(`t=${(f / lm.FPS).toFixed(2)}s`, X + 12, Y + 22);
  });
  fs.writeFileSync(path.join(outDir, "sheet.png"), sheet.toBuffer("image/png"));

  const noLogo = await lm.frames({ ...coin, symbol: "$ANONVOYAGE", name: "Anon Voyage" }, null, { count: 1, badge: "Diamond Tier" });
  fs.writeFileSync(path.join(outDir, "nologo.png"), toCanvas(noLogo[0]).toBuffer("image/png"));
  console.log("wrote", outDir);
})();
