// "SAYA INGIN PRICE DAN MC NYA AGAK KE BAWAH" (2026-11-07): on a Prism row card
// the price · MC line sat pressed up under the ticker (≈0.4 of the way to the
// bar) with the gap below it left empty. It belongs in the middle of that gap.
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
const { fmtPrice } = require("../src/helpers/format");

const SYMS = ["HODL", "COGE", "DONNA", "HMM", "JOB", "FAPCOIN", "ORBIO", "SWORD", "AKE", "BATON"];
const coins = (n) => SYMS.slice(0, n).map((s, i) => ({
  chain: "solana", address: "So" + i, symbol: s, name: "", pct: 900 - i * 80,
  price: 0.000417 + i * 0.0000131, mcap: 1_234_567 * (i + 1),
}));

async function geometry(n) {
  const CV = kit.canvasLib();
  const proto = Object.getPrototypeOf(CV.createCanvas(4, 4).getContext("2d"));
  const real = proto.fillText;
  const texts = [];
  proto.fillText = function (t, x, y, ...rest) { texts.push({ t: String(t), x, y }); return real.call(this, t, x, y, ...rest); };
  rects.length = 0;
  try {
    await prism.still({ template: "prism" + n, coins: coins(n), dateText: "" });
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
      const bar = rr.find((r) => Math.abs(r.x - tick.x) < 1 && Math.abs(r.h - 5) < 0.01 && r.y > price.y);
      if (!bar) continue; // a portrait / stacked card in this composition — not a row card
      const barY = bar.y + bar.h / 2;
      const f = (price.y - tick.y) / (barY - tick.y);
      assert.ok(f >= 0.5, `prism${n} card ${i + 1}: price · MC is only ${(f * 100).toFixed(0)}% of the way from the ticker to the bar — pressed up under the ticker`);
      assert.ok(price.y < bar.y - 8, `prism${n} card ${i + 1}: price · MC runs into the bar`);
      measured++;
    }
    assert.ok(measured > 0, `prism${n}: no row card was measured — this test checks nothing`);
  });
}
