// The PREMIUM Top-Gainers set, and the removal of the motion boards it replaced.
//
// "hapus top gainer yang vidio ganti ke foto banner aja … buatkan template
// banner top 1 sampai 10 banner premium yang berbeda" (2026-10-03). Two
// promises: every board is a still now, and the panel's front screen offers
// ten premium designs — one per board size, none sharing a silhouette or a
// backdrop with another.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "dexvra-gainers-premium-"));
process.env.BOT_DATA_DIR = DIR;

const gb = require("../src/gainersBanner");
const gr = require("../src/gainersRender");
const cfg = require("../src/services/gainersConfig");
const kit = require("../src/helpers/canvasKit");

const coin = (i, extra = {}) => ({
  chain: "solana",
  address: "So" + i,
  symbol: "TOK" + i,
  name: "Token " + i,
  pct: 220 - i * 17,
  price: 0.004 * i,
  mcap: 1_000_000 * (12 - i),
  liq: 90_000,
  ...extra,
});
const many = (n, extra) => Array.from({ length: n }, (_, i) => coin(i + 1, extra));

test("the premium ladder is ten designs, Top 1 → Top 10, in order", () => {
  assert.strictEqual(gr.PREMIUM_IDS.length, 10);
  assert.deepStrictEqual(gr.PREMIUM_IDS.map((id) => gb.countOf(id)), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    "the home screen is built from this list — a gap or a swap reads as a missing size");
  for (const id of gr.PREMIUM_IDS) {
    assert.ok(gb.specOf(id).premium, `${id} is not marked premium`);
    assert.ok(gb._internals.LAYOUTS[gb.specOf(id).layout], `${id} names a layout that doesn't exist`);
  }
  // one design each — a premium layout that is just another one renamed is not "berbeda"
  const layouts = gr.PREMIUM_IDS.map((id) => gb.specOf(id).layout);
  assert.strictEqual(new Set(layouts).size, 10);
  const labels = gr.PREMIUM_IDS.map((id) => gb.labelOf(id));
  assert.strictEqual(new Set(labels).size, 10, "two premium buttons would read the same");
  // …and nothing from the classic set
  for (const id of gr.PREMIUM_IDS) assert.ok(!gr.CLASSIC_IDS.includes(id));
});

test("every premium design renders at its own size AND every smaller one", async () => {
  if (!gb.available()) return;
  for (const id of gr.PREMIUM_IDS) {
    for (let n = 1; n <= gb.countOf(id); n++) {
      const buf = await gb.render({ template: id, coins: many(n), dateText: "Saturday · October 3 · 2026" });
      assert.ok(Buffer.isBuffer(buf) && buf.length > 10_000, `${id} with ${n} coin(s) produced no banner`);
    }
  }
});

test("a short board draws the premium design FOR THAT COUNT — not slots with holes", async () => {
  if (!gb.available()) return;
  // With a background image the mood never paints, so two templates that differ
  // only in mood render identically — which is exactly what a correct
  // delegation produces: Hall of Fame handed three coins IS the Medal Arc.
  const CV = kit.canvasLib();
  const bgCanvas = CV.createCanvas(1600, 900);
  const b = bgCanvas.getContext("2d");
  b.fillStyle = "#223344";
  b.fillRect(0, 0, 1600, 900);
  const bgPath = path.join(DIR, "bg.png");
  fs.writeFileSync(bgPath, await bgCanvas.encode("png"));
  const coins = many(3);
  const hall = await gb.render({ template: "p10_hall", coins: coins.map((c) => ({ ...c })), dateText: "", bgPath });
  const arc = await gb.render({ template: "p3_arc", coins: coins.map((c) => ({ ...c })), dateText: "", bgPath });
  assert.ok(hall && arc);
  assert.ok(hall.equals(arc), "p10_hall with three coins did not draw the Top 3 design");
  // …and the positive control: at full size it is its own design
  const hall10 = await gb.render({ template: "p10_hall", coins: many(10), dateText: "", bgPath });
  const spot10 = await gb.render({ template: "spot10", coins: many(10), dateText: "", bgPath });
  assert.ok(!hall10.equals(spot10), "the control is vacuous — two different designs rendered identically");
});

test("⚠️ the equalizer's bar is the % as a LENGTH, so it goes with the figure", async () => {
  if (!gb.available()) return;
  // Hidden figure → the render may not depend on pct at all. Two boards that
  // differ ONLY in their percentages must then be byte-identical.
  const a = many(8);
  const b2 = many(8).map((c, i) => ({ ...c, pct: 900 - i * 3 }));
  const offA = await gb.render({ template: "p8_equalizer", coins: a, dateText: "", showPct: false });
  const offB = await gb.render({ template: "p8_equalizer", coins: b2, dateText: "", showPct: false });
  assert.ok(offA.equals(offB), "with the % hidden, the equalizer still drew something sized by it");
  // …positive control, or the assertion above proves nothing
  const onA = await gb.render({ template: "p8_equalizer", coins: many(8), dateText: "", showPct: true });
  const onB = await gb.render({ template: "p8_equalizer", coins: many(8).map((c, i) => ({ ...c, pct: 900 - i * 3 })), dateText: "", showPct: true });
  assert.ok(!onA.equals(onB), "the bars do not follow the percentage when it is shown");
});

test("🎲 random with no rotation rolls the PREMIUM set", () => {
  for (const r of [0, 0.13, 0.5, 0.77, 0.999]) {
    assert.ok(gr.PREMIUM_IDS.includes(gr.pickTemplate("random", { pool: [], rng: () => r })), `rng ${r}`);
  }
  // a concrete id is still honoured, classic included
  assert.strictEqual(gr.pickTemplate("list5"), "list5");
});

test("every board is a still — the motion path is gone", async () => {
  assert.ok(!fs.existsSync(path.join(__dirname, "..", "src", "gainersMotion.js")), "the motion renderer is back");
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "gainersRender.js"), "utf8");
  assert.ok(!/require\(["']\.\/gainersMotion["']\)/.test(src));
  if (!gb.available()) return;
  for (const id of ["random", gr.PREMIUM_IDS[4], "list5"]) {
    const out = await gr.render({ template: gr.pickTemplate(id), coins: many(5), dateText: "" });
    assert.ok(out, `${id} did not render`);
    assert.strictEqual(out.mediaType, "photo");
    assert.strictEqual(out.ext, "png");
    assert.ok(out.still.equals(out.media));
  }
});

test("a stored motion layout or format from before the removal degrades, never wedges", () => {
  fs.writeFileSync(path.join(DIR, cfg.FILE), JSON.stringify({ template: "v5", format: "animated", pool: ["v3", "p4_hex", "list5"] }));
  const c = cfg.get();
  assert.strictEqual(c.template, "random", "a video template id must fall back to random");
  assert.deepStrictEqual(c.pool, ["p4_hex", "list5"], "video ids must leave the rotation");
  assert.ok(!("format" in c), "format is no longer a setting");
  fs.rmSync(path.join(DIR, cfg.FILE), { force: true });
});

test("the panel's front screen is the premium set, with the classic stills one tap away and no video", () => {
  const menu = require("../src/admin/gainersMenu");
  const home = JSON.stringify(menu._panels.homeKb());
  for (const id of gr.PREMIUM_IDS) assert.ok(home.includes(`gn_t:${id}`), `${id} is not on the home screen`);
  for (const id of gr.CLASSIC_IDS) assert.ok(!home.includes(`gn_t:${id}"`), `${id} crowds the home screen`);
  assert.ok(home.includes("gn_img"), "no way to reach the classic layouts");
  assert.ok(!/video|🎬|MP4/i.test(home), "the home keyboard still offers video");
  assert.ok(!/video|MP4|Format:/i.test(menu._panels.homeText()), "the home text still talks about video");
  const set = JSON.stringify(menu._panels.setKb());
  assert.ok(!set.includes("gn_fmt"), "the settings card still offers the format switch");
  assert.ok(!/Format:/.test(menu._panels.setText()));
});

test("the premium set draws on its OWN page — black and gold, not the classic chrome", async () => {
  if (!gb.available()) return;
  // "buat lebih premium lagi bannernya": the first cut shared the classic
  // header (mint title, mint keyline) and read as the classic board with new
  // cards in it. Measured by what the renderer actually DRAWS: the premium
  // lockup says "Premium board", the classic one says "Discovery".
  const CV = kit.canvasLib();
  const proto = Object.getPrototypeOf(CV.createCanvas(4, 4).getContext("2d"));
  const real = proto.fillText;
  const texts = [];
  proto.fillText = function (t, ...rest) { texts.push(String(t)); return real.call(this, t, ...rest); };
  const run = async (id) => {
    texts.length = 0;
    await gb.render({ template: id, coins: many(gb.countOf(id)), dateText: "" });
    return texts.filter((t) => [...t].length === 1).join("");
  };
  try {
    const premium = await run("p5_stairs");
    const classic = await run("list5");
    assert.ok(premium.includes("PREMIUM BOARD"), "the premium page did not draw its own lockup");
    assert.ok(!premium.includes("DISCOVERY"), "the premium page drew the classic lockup");
    assert.ok(classic.includes("DISCOVERY") && !classic.includes("PREMIUM BOARD"), "the classic page changed — the control is vacuous");
  } finally {
    proto.fillText = real;
  }
});
