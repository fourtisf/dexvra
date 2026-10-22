// "ga hanya gainers bisa di on off tpi mc dan price juga" (2026-10-03): the
// market cap and the price on the Top-Gainers ARTWORK are switchable like the
// percentage. Measured by running every template with fillText wrapped — a
// source scan cannot tell "the figure is not drawn" from a comment saying so.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "dexvra-gainers-mcprice-"));
process.env.BOT_DATA_DIR = DIR;

const gb = require("../src/gainersBanner");
const cfg = require("../src/services/gainersConfig");
const kit = require("../src/helpers/canvasKit");
const { fmtCap, fmtPrice } = require("../src/helpers/format");

// Figures nobody else on the banner could print by accident.
const MCAP = 7_654_321;
const PRICE = 0.0123456;
const coin = (i) => ({
  chain: "solana", address: "So" + i, symbol: "TOK" + i, name: "Token " + i,
  pct: 220 - i * 17, price: PRICE, mcap: MCAP, liq: 90_000,
});
const many = (n) => Array.from({ length: n }, (_, i) => coin(i + 1));
const capText = fmtCap(MCAP).replace(/^\$/, ""); // "7.65M"
const priceText = fmtPrice(PRICE).replace(/^\$/, "");

/** Everything the renderer drew, as one string (per-glyph labels joined). */
async function drawn(fn) {
  const CV = kit.canvasLib();
  const proto = Object.getPrototypeOf(CV.createCanvas(4, 4).getContext("2d"));
  const real = proto.fillText;
  const texts = [];
  proto.fillText = function (t, ...rest) { texts.push(String(t)); return real.call(this, t, ...rest); };
  try {
    await fn();
  } finally {
    proto.fillText = real;
  }
  return texts.join("").toUpperCase();
}

test("both switches ship ON and persist — what every board drew before they existed", async () => {
  fs.rmSync(path.join(DIR, cfg.FILE), { force: true });
  assert.strictEqual(cfg.get().bannerMcap, true);
  assert.strictEqual(cfg.get().bannerPrice, true);
  await cfg.set({ bannerMcap: false, bannerPrice: false });
  const disk = JSON.parse(fs.readFileSync(path.join(DIR, cfg.FILE), "utf8"));
  assert.strictEqual(disk.bannerMcap, false, "on DISK — the poster is another process");
  assert.strictEqual(disk.bannerPrice, false);
  assert.strictEqual(cfg.get().showMcap, false, "the CAPTION's market-cap switch is a different setting and did not move");
  await cfg.reset();
  assert.strictEqual(cfg.get().bannerMcap, true);
  assert.strictEqual(cfg.get().bannerPrice, true);
});

test("⚠️ with MC OFF no template draws the market cap or an MCap heading; with price OFF none draws the price", async () => {
  if (!gb.available()) return;
  for (const id of gb.TEMPLATE_IDS) {
    const n = gb.countOf(id);
    const on = await drawn(() => gb.render({ template: id, coins: many(n), dateText: "" }));
    const noCap = await drawn(() => gb.render({ template: id, coins: many(n), dateText: "", showMcap: false }));
    const noPrice = await drawn(() => gb.render({ template: id, coins: many(n), dateText: "", showPrice: false }));
    assert.ok(!noCap.includes(capText), `${id} drew the market cap with the switch off`);
    assert.ok(!/MCAP|MARKET CAP/.test(noCap), `${id} drew a market-cap heading over a column it did not draw`);
    assert.ok(!noPrice.includes(priceText), `${id} drew the price with the switch off`);
    // positive controls, or the two assertions above prove nothing
    if (on.includes(capText)) assert.ok(noPrice.includes(capText), `${id}: hiding the PRICE took the market cap with it`);
    if (on.includes(priceText)) assert.ok(noCap.includes(priceText), `${id}: hiding the MC took the price with it`);
  }
  // …and at least most templates DO draw them when on — a vacuity check
  let caps = 0;
  let prices = 0;
  for (const id of gb.TEMPLATE_IDS) {
    const on = await drawn(() => gb.render({ template: id, coins: many(gb.countOf(id)), dateText: "" }));
    if (on.includes(capText)) caps++;
    if (on.includes(priceText)) prices++;
  }
  assert.ok(caps >= gb.TEMPLATE_IDS.length - 2, `only ${caps} templates draw a market cap at all — the OFF assertion is near vacuous`);
  assert.ok(prices >= 6, `only ${prices} templates draw a price at all`);
});

test("the render does not write onto the caller's coins", async () => {
  if (!gb.available()) return;
  const coins = many(5);
  await gb.render({ template: "p5_stairs", coins, dateText: "", showMcap: false, showPrice: false });
  assert.strictEqual(coins[0].mcap, MCAP, "hiding the MC nulled the caller's market cap — the caption reads it next");
  assert.strictEqual(coins[0].price, PRICE);
});

test("every render site in the panel AND the poster passes both switches", () => {
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
  for (const f of ["src/admin/gainersMenu.js", "src/services/gainersPoster.js"]) {
    const src = strip(fs.readFileSync(path.join(__dirname, "..", f), "utf8"));
    const sites = src.split("gr.render(").length - 1;
    assert.ok(sites > 0, `${f}: no render site found — this guard checks nothing`);
    assert.strictEqual(src.split("showMcap: cfg.bannerMcap").length - 1, sites, `${f}: a render site forgot the MC switch`);
    assert.strictEqual(src.split("showPrice: cfg.bannerPrice").length - 1, sites, `${f}: a render site forgot the price switch`);
  }
});

test("the switches are on the preview card AND under ⚙️ Settings", () => {
  const menu = require("../src/admin/gainersMenu");
  const card = JSON.stringify(menu._panels.previewKb("p5_stairs"));
  assert.ok(card.includes("gn_pvmc") && card.includes("gn_pvpr"), "the preview card has no MC / price switch");
  const set = JSON.stringify(menu._panels.setKb());
  assert.ok(set.includes("gn_bmc") && set.includes("gn_bpr"), "settings has no MC / price switch");
});
