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

// ── EVERY CARD, EVERY TEMPLATE ──────────────────────────────────────────────
// "mc sudah on tapi yang di show mc on hanya top 1 gainers" (2026-11-07). The
// test above gives every coin the SAME cap, so "the cap is drawn" passes when
// ANY card draws it — one cap out of ten passed. And it walked gb.TEMPLATE_IDS,
// so the 💠 Prism set was never in it at all. Measured, the same defect sat on
// four premium stills too (the cap printed only as a fallback when the % was
// hidden). So: distinct figures per coin, asserted per card, over the ONE list
// the panel offers — a template set added later is in this guard the day it
// ships, or the first assertion below fails.
const gr = require("../src/gainersRender");
const prism = require("../src/gainersPrism");
// An id from neither set THROWS rather than reaching gb.render, which would
// draw its fallback board and pass on somebody else's figures. (Neutral to a
// mutation run today — every id is one of the two sets — it fires the day a
// third set is added to gr.TEMPLATE_IDS without being taught here.)
const drawStill = (id, o) => {
  if (gr.isPrism(id)) return prism.still({ ...o, template: id });
  if (gb.isTemplate(id)) return gb.render({ ...o, template: id });
  throw new Error(`${id}: a template set this guard cannot render — teach drawStill the new set`);
};
const distinct = (n) => many(n).map((c, i) => ({ ...c, price: 0.000417 + i * 0.0000131, mcap: 1_234_567 * (i + 1) + i * 98_765 }));
const bare = (s) => s.replace(/^\$/, "").toUpperCase();

// Dense boards whose cards carry the market cap and NOT the price, by design:
// the price is the lead card's (or appears only when there is no cap). Each is
// a decision written down. A template NOT listed prints its price on every card
// when 💲 is on; a listed one that starts doing so fails as a dead entry.
const PRICE_NOT_ON_EVERY_CARD = {
  p8_equalizer: "eight meter columns — the bar is the %, the floor line is the MC",
  p9_cover: "the cover story carries the price; the index tiles carry MC only, clear of the deco corners",
  p10_hall: "the podium plaques carry the price; the seven gallery frames carry MC only",
  list5: "a gain-bar leaderboard — each row's figure is its MC",
  tier6: "the lower tier is a board of rows — each row's figure is its MC",
  crown7: "the champion band and the two boards show MC as their figure",
  rail8: "film-strip mini-frames — one figure each, the MC",
  mosaic9: "nine compact tiles — one figure each, the MC",
  grid10: "the terminal board — one line per token, MC column",
  spot10: "the champion card carries the price; the pack's rows carry MC",
};

test("⚠️ with 🏦 / 💲 ON, EVERY card of EVERY template carries its own figure — not just #1 — and OFF removes every one", async () => {
  if (!gb.available()) return;
  for (const id of Object.keys(PRICE_NOT_ON_EVERY_CARD)) assert.ok(gr.TEMPLATE_IDS.includes(id), `${id}: an exemption for a template that does not exist`);
  for (const id of gr.TEMPLATE_IDS) {
    const coins = distinct(gr.countOf(id));
    const caps = coins.map((c) => bare(fmtCap(c.mcap)));
    const prices = coins.map((c) => bare(fmtPrice(c.price)));
    assert.strictEqual(new Set([...caps, ...prices]).size, 2 * coins.length, "fixture: every figure distinct");
    const on = await drawn(() => drawStill(id, { coins, dateText: "" }));
    caps.forEach((t, i) => assert.ok(on.includes(t), `${id}: card ${i + 1} shows no market cap with 🏦 ON (${t})`));
    const priceMissing = prices.filter((t) => !on.includes(t)).length;
    if (PRICE_NOT_ON_EVERY_CARD[id]) {
      assert.ok(priceMissing > 0, `${id} now prints the price on every card — remove it from PRICE_NOT_ON_EVERY_CARD`);
    } else {
      prices.forEach((t, i) => assert.ok(on.includes(t), `${id}: card ${i + 1} shows no price with 💲 ON (${t})`));
    }
    const noCap = await drawn(() => drawStill(id, { coins, dateText: "", showMcap: false }));
    caps.forEach((t, i) => assert.ok(!noCap.includes(t), `${id}: card ${i + 1} kept its market cap with 🏦 OFF`));
    const noPrice = await drawn(() => drawStill(id, { coins, dateText: "", showPrice: false }));
    prices.forEach((t, i) => assert.ok(!noPrice.includes(t), `${id}: card ${i + 1} kept its price with 💲 OFF`));
  }
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
