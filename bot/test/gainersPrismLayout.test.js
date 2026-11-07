// "SAYA INGIN PRICE DAN MC NYA AGAK KE BAWAH" (2026-11-07): on a Prism row card
// the price · MC line sat pressed up under the ticker (≈0.4 of the way to the
// bar) with the gap below it left empty. It belongs in the middle of that gap.
// The MC then moved right, under the gain ("agak ke kanan, jangan terlalu ke
// kiri"), the price staying under the ticker.
// Measured from what the renderer DRAWS — the ticker's and the price's
// fillText y, the bar track's rect — because a source scan cannot see a y.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

process.env.BOT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "dexvra-prism-layout-"));

// gainersPrism destructures roundRect from the kit at require time, so the
// recorder has to be in place BEFORE the module is loaded.
const kit = require("../src/helpers/canvasKit");
const rects = [];
const realRR = kit.roundRect;
kit.roundRect = (ctx, x, y, w, h, r) => { rects.push({ x, y, w, h }); return realRR(ctx, x, y, w, h, r); };
const prism = require("../src/gainersPrism");
const { fmtPrice, fmtCap } = require("../src/helpers/format");

const SYMS = ["HODL", "COGE", "DONNA", "HMM", "JOB", "FAPCOIN", "ORBIO", "SWORD", "AKE", "BATON"];
const coins = (n) => SYMS.slice(0, n).map((s, i) => ({
  chain: "solana", address: "So" + i, symbol: s, name: "", pct: 900 - i * 80,
  price: 0.000417 + i * 0.0000131, mcap: 1_234_567 * (i + 1),
}));

async function geometry(n, list = coins(n)) {
  const CV = kit.canvasLib();
  const proto = Object.getPrototypeOf(CV.createCanvas(4, 4).getContext("2d"));
  const real = proto.fillText;
  const texts = [];
  proto.fillText = function (t, x, y, ...rest) { texts.push({ t: String(t), x, y, w: this.measureText(String(t)).width }); return real.call(this, t, x, y, ...rest); };
  rects.length = 0;
  try {
    await prism.still({ template: "prism" + n, coins: list, dateText: "" });
  } finally {
    proto.fillText = real;
  }
  return { texts, rects: rects.slice() };
}

for (const n of [10, 9, 8, 6, 5, 2]) {
  test(`prism${n}: each row card's price · MC sits in the middle of the gap between ticker and bar`, async () => {
    if (!kit.canvasLib()) return;
    const { texts, rects: rr } = await geometry(n);
    const list = coins(n);
    let measured = 0;
    for (let i = 1; i < n; i++) {
      const tick = texts.find((e) => e.t === "$" + list[i].symbol);
      const price = texts.find((e) => e.t === fmtPrice(list[i].price));
      assert.ok(tick && price, `prism${n} card ${i + 1}: ticker or price was not drawn`);
      // the bar track starts at the ticker's x, 5 high
      // the nearest bar BELOW this card's price — cards in one column share an x
      const bar = rr.filter((r) => Math.abs(r.x - tick.x) < 1 && Math.abs(r.h - 5) < 0.01 && r.y > price.y).sort((a, b) => a.y - b.y)[0];
      if (!bar) continue; // a portrait / stacked card in this composition — not a row card
      const barY = bar.y + bar.h / 2;
      const f = (price.y - tick.y) / (barY - tick.y);
      assert.ok(f >= 0.5, `prism${n} card ${i + 1}: price · MC is only ${(f * 100).toFixed(0)}% of the way from the ticker to the bar — pressed up under the ticker`);
      assert.ok(price.y < bar.y - 8, `prism${n} card ${i + 1}: price · MC runs into the bar`);
      // "mc nya … agak ke kanan, jangan terlalu ke kiri": the price stays under
      // the ticker, the MC is right-aligned to the card's right edge (under the
      // gain) — the bar track spans exactly ticker-x → that edge
      const cap = texts.find((e) => e.t === fmtCap(list[i].mcap));
      assert.ok(cap, `prism${n} card ${i + 1}: market cap was not drawn`);
      const edge = bar.x + bar.w;
      assert.ok(Math.abs(cap.x + cap.w - edge) < 1.5, `prism${n} card ${i + 1}: MC ends at ${(cap.x + cap.w).toFixed(1)}, not at the card's right edge ${edge.toFixed(1)}`);
      assert.ok(Math.abs(price.x - tick.x) < 0.5, `prism${n} card ${i + 1}: the price left the ticker's column`);
      assert.ok(cap.x > price.x + price.w + 10, `prism${n} card ${i + 1}: price and MC run together`);
      measured++;
    }
    assert.ok(measured > 0, `prism${n}: no row card was measured — this test checks nothing`);
  });
}

test("prism10: figures too wide to sit apart fall back to one line — never overlapping, never off the card", async () => {
  if (!kit.canvasLib()) return;
  // the widest spellings the two formatters produce: a 20-character price and a
  // 14-character cap — on the narrowest row card these cannot sit apart
  const list = coins(10).map((c, i) => (i ? { ...c, price: 0.0000000000000042 + i * 1e-17, mcap: 9.87e17 } : c));
  const { texts, rects: rr } = await geometry(10, list);
  for (let i = 1; i < 10; i++) {
    const tick = texts.find((e) => e.t === "$" + list[i].symbol);
    // the nearest bar BELOW this ticker — cards in one column share an x
    const bar = rr.filter((r) => Math.abs(r.x - tick.x) < 1 && Math.abs(r.h - 5) < 0.01 && r.y > tick.y).sort((a, b) => a.y - b.y)[0];
    // the meta line only — the gain figure is drawn right-aligned (its x IS its right edge)
    const mine = texts.filter((e) => e.y > tick.y && e.y < bar.y && e.x >= tick.x - 0.5 && e.x < bar.x + bar.w && !e.t.includes("%"));
    assert.ok(mine.length > 0, `card ${i + 1}: no meta line measured — this test checks nothing`);
    const all = mine.map((e) => e.t).join("");
    assert.ok(all.includes(fmtCap(list[i].mcap).replace(/^\$/, "")) || all.includes("…"), `card ${i + 1}: the market cap vanished`);
    for (const e of mine) assert.ok(e.x + e.w <= bar.x + bar.w + 1.5, `card ${i + 1}: "${e.t}" runs off the card`);
    // vacuity: these figures really took the one-line fallback
    assert.ok(mine.some((e) => e.t.includes("…") || e.t.includes("·")), `card ${i + 1}: the fallback was never reached — this test checks nothing`);
    const sorted = mine.slice().sort((a, b) => a.x - b.x);
    for (let k = 1; k < sorted.length; k++) assert.ok(sorted[k].x >= sorted[k - 1].x + sorted[k - 1].w - 0.5, `card ${i + 1}: "${sorted[k - 1].t}" and "${sorted[k].t}" overlap`);
  }
});
