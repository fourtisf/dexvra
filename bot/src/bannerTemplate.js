// Fourtis-style banner TEMPLATE compositor. An admin uploads a designed
// artwork (illustration/3D mascot/etc — the thing code can't draw) via
// @dexvraadminbot; every listing/trending channel post then composites the
// token's logo into the artwork's logo spot (circle-clipped) plus an optional
// $TICKER + name overlay. This is exactly how fourtis produces the banners the
// operator considers good — the art is designed once, the code only pastes.
//
// No template uploaded → compose() returns null and callers fall back to the
// programmatic dynamic banner (bannerRender.js). Never throws.
const path = require("node:path");
const fss = require("node:fs");
const { loadJSONSync, saveJSON, DATA_DIR } = require("./helpers/persist");
const log = require("./helpers/logger");

const CONFIG_FILE = "bannerTemplate.json";
const KINDS = ["listing", "trending"];
const templatePath = (kind) => path.join(DATA_DIR, `banner-template-${kind}.png`);

const DEFAULTS = {
  logoSize: 180, // px, diameter of the circle the logo is clipped into
  logoX: "center", // number | "center"
  logoY: "center",
  showText: true, // draw $TICKER + name overlay
  tickerFontSize: 44,
  tickerX: 60, // number | "center"
  tickerY: 300,
  tickerColor: "#FFFFFF",
  nameFontSize: 26,
  nameColor: "#CFDDD9",
  nameOffsetY: 44,
};

function loadConfig() {
  const saved = loadJSONSync(CONFIG_FILE, {});
  const out = {};
  for (const k of KINDS) out[k] = { ...DEFAULTS, ...(saved[k] || {}) };
  return out;
}
async function updateSettings(kind, settings) {
  const saved = loadJSONSync(CONFIG_FILE, {});
  saved[kind] = { ...DEFAULTS, ...(saved[kind] || {}), ...settings };
  await saveJSON(CONFIG_FILE, saved);
  return saved[kind];
}
function getSettings(kind) {
  return loadConfig()[kind] || { ...DEFAULTS };
}

function hasTemplate(kind) {
  try {
    const p = templatePath(kind);
    return fss.existsSync(p) && fss.statSync(p).size > 0;
  } catch {
    return false;
  }
}

let CV = null; // lazy canvas (shared native lib with bannerRender)
function canvasLib() {
  if (CV === undefined) return null;
  if (CV) return CV;
  try {
    CV = require("@napi-rs/canvas");
    const FONTS = path.join(__dirname, "..", "assets", "fonts");
    const reg = (f, fam) => {
      const p = path.join(FONTS, f);
      if (fss.existsSync(p)) CV.GlobalFonts.registerFromPath(p, fam);
    };
    reg("Sora-800.ttf", "TplBold");
    reg("Sora-500.ttf", "TplReg");
  } catch (e) {
    log.warn(`[bannerTpl] canvas unavailable: ${e.message}`);
    CV = undefined;
    return null;
  }
  return CV;
}

/** Composite the kind's template with the token logo (+ optional text).
 *  Returns a PNG Buffer, or null when no template / any failure. */
async function compose(kind, logoBuffer, { symbol, name } = {}) {
  if (!hasTemplate(kind)) return null;
  const cv = canvasLib();
  if (!cv) return null;
  try {
    const cfg = getSettings(kind);
    const tpl = await cv.loadImage(templatePath(kind));
    const W = tpl.width;
    const H = tpl.height;
    const canvas = cv.createCanvas(W, H);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(tpl, 0, 0, W, H);

    // Token logo, circle-clipped into the artwork's logo spot.
    const size = Number(cfg.logoSize) || DEFAULTS.logoSize;
    const lx = cfg.logoX === "center" ? (W - size) / 2 : Number(cfg.logoX) || 0;
    const ly = cfg.logoY === "center" ? (H - size) / 2 : Number(cfg.logoY) || 0;
    if (logoBuffer) {
      try {
        const img = await cv.loadImage(logoBuffer);
        ctx.save();
        ctx.beginPath();
        ctx.arc(lx + size / 2, ly + size / 2, size / 2, 0, Math.PI * 2);
        ctx.closePath();
        ctx.clip();
        const s = Math.max(size / img.width, size / img.height);
        const w = img.width * s;
        const h = img.height * s;
        ctx.drawImage(img, lx + size / 2 - w / 2, ly + size / 2 - h / 2, w, h);
        ctx.restore();
        ctx.beginPath();
        ctx.arc(lx + size / 2, ly + size / 2, size / 2 + 2, 0, Math.PI * 2);
        ctx.strokeStyle = "rgba(255,255,255,.55)";
        ctx.lineWidth = 3;
        ctx.stroke();
      } catch (e) {
        log.debug(`[bannerTpl] logo overlay: ${e.message}`); // artwork still posts
      }
    }

    // $TICKER + name overlay (position/size admin-tunable; off if artwork has
    // its own text or the admin prefers the art clean).
    if (cfg.showText && symbol) {
      const ticker = `$${String(symbol).replace(/^\$+/, "").toUpperCase()}`;
      ctx.textBaseline = "middle";
      ctx.shadowColor = "rgba(0,0,0,.7)";
      ctx.shadowBlur = 8;
      ctx.shadowOffsetY = 2;
      ctx.font = `800 ${cfg.tickerFontSize}px TplBold, sans-serif`;
      ctx.fillStyle = cfg.tickerColor;
      const tx =
        cfg.tickerX === "center"
          ? (W - ctx.measureText(ticker).width) / 2
          : Number(cfg.tickerX) || 0;
      const ty = cfg.tickerY === "center" ? H / 2 : Number(cfg.tickerY) || 0;
      ctx.fillText(ticker, tx, ty);
      if (name) {
        ctx.font = `500 ${cfg.nameFontSize}px TplReg, sans-serif`;
        ctx.fillStyle = cfg.nameColor;
        const nx = cfg.tickerX === "center" ? (W - ctx.measureText(name).width) / 2 : tx;
        ctx.fillText(String(name).slice(0, 32), nx, ty + Number(cfg.nameOffsetY));
      }
      ctx.shadowColor = "transparent";
      ctx.shadowBlur = 0;
    }

    return canvas.toBuffer("image/png");
  } catch (e) {
    log.warn(`[bannerTpl] compose(${kind}) failed: ${e.message}`);
    return null;
  }
}

async function saveTemplate(kind, buffer) {
  await fss.promises.mkdir(DATA_DIR, { recursive: true });
  await fss.promises.writeFile(templatePath(kind), buffer);
}
async function removeTemplate(kind) {
  try {
    await fss.promises.unlink(templatePath(kind));
  } catch {
    /* already gone */
  }
}

module.exports = {
  KINDS,
  compose,
  hasTemplate,
  saveTemplate,
  removeTemplate,
  getSettings,
  updateSettings,
  templatePath,
  DEFAULTS,
};
