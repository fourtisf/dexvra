// The pump alert's "Boost Gauge" clip (pumpMotion) and its wiring.
//
// "pastikan semuanya sesuai dari logo mc name ticker dll — tidak ada yang salah":
// every figure on the banner is asserted against the CAPTION's own figure,
// spelt by the caption's own function, because two spellings of one number on
// one post is how a reader is told two different things.
//
// The suite runs with PUMP_MOTION=0 (scripts/run-tests.js) so every other pump
// test keeps the ladder it was written for; this file turns it back on.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-pumpmotion-"));

const test = require("node:test");
const assert = require("node:assert");
const kit = require("../src/helpers/canvasKit");
const pm = require("../src/pumpMotion");
const fmt = require("../src/channels/format");

const cv = kit.canvasLib();
const HAVE = !!cv;
const { IN0, T_LAND, HOLD } = pm._timeline;

const COIN = { symbol: "$CHOO", name: "Choo Train", pct: 100, firstMc: "$1.9M", lastMc: "$4.5M" };

/** Every fillText call made while `fn` runs: [{ text, x, y }]. */
async function drawnDuring(fn) {
  const proto = Object.getPrototypeOf(cv.createCanvas(1, 1).getContext("2d"));
  const orig = proto.fillText;
  const out = [];
  proto.fillText = function (text, x, y, ...rest) {
    out.push({ text: String(text), x, y });
    return orig.call(this, text, x, y, ...rest);
  };
  try {
    await fn();
  } finally {
    proto.fillText = orig;
  }
  return out;
}
const texts = (calls) => calls.map((c) => c.text);
/** Glyphs drawn one at a time (tracked labels, the per-letter ticker) on one baseline. */
const runAt = (calls, y) => calls.filter((c) => Math.abs(c.y - y) < 0.01).map((c) => c.text).join("");
const logoPng = (color) => {
  const c = cv.createCanvas(200, 200), x = c.getContext("2d");
  x.fillStyle = color; x.fillRect(0, 0, 200, 200);
  return c.toBuffer("image/png");
};

test("PUMP_MOTION: blank or unset is ON, an explicit off is off", () => {
  const prev = process.env.PUMP_MOTION;
  try {
    delete process.env.PUMP_MOTION; assert.equal(pm.enabled(), true);
    process.env.PUMP_MOTION = ""; assert.equal(pm.enabled(), true, "blank is not false");
    process.env.PUMP_MOTION = "0"; assert.equal(pm.enabled(), false);
    process.env.PUMP_MOTION = "off"; assert.equal(pm.enabled(), false);
  } finally {
    if (prev === undefined) delete process.env.PUMP_MOTION; else process.env.PUMP_MOTION = prev;
  }
});

test("the dial's readout is the caption's own multiple, at every step of the count", () => {
  // the caption says "2×" for +100%; a banner saying "2.0×" under it is a second spelling
  for (const pct of [100, 150, 200, 900, 1150, 1900]) assert.equal(pm._readout(1 + pct / 100), fmt.xMultiple(pct), `+${pct}%`);
  assert.equal(pm._readout(2), "2×");
  assert.equal(pm._readout(2.5), "2.5×");
});

test("a market cap nobody read is TBA on the caption, never $0", () => {
  assert.equal(fmt.pumpMc(0), "TBA");
  assert.equal(fmt.pumpMc(null), "TBA");
  assert.equal(fmt.pumpMc(4_500_000), "$4.5M");
  const card = fmt.pumpPost({ symbol: "$CHOO", name: "Choo Train", chain: "solana", address: "So1111" }, 100, null, 4_500_000);
  const body = typeof card === "string" ? card : card.text;
  assert.doesNotMatch(body, /\$0\b/, "a fabricated zero");
  assert.match(body, /TBA/);
});

test("the scale puts round labels round the true multiple", () => {
  assert.deepEqual(pm._scaleFor(2), { min: 1, max: 3, step: 1 });
  const big = pm._scaleFor(20);
  assert.ok(big.max >= 20 * 1.2 && big.step === 10, JSON.stringify(big));
});

test("frame 0 is the full card, and every figure on it is the coin's own", { skip: !HAVE }, async () => {
  const calls = await drawnDuring(() => pm.frames(COIN, logoPng("#F2B33D"), { times: [0], badge: "Solana" }));
  const t = texts(calls);
  assert.equal(runAt(calls, 262), "$CHOO", "the ticker, letter by letter, exactly one $");
  assert.ok(t.includes("Choo Train"), "the name");
  assert.ok(t.includes("+100%"), "the step the caption announces");
  assert.ok(t.includes("$1.9M") && t.includes("$4.5M"), "MC at listing → MC now");
  assert.ok(t.includes("2×"), "the readout, spelt like the caption");
  assert.equal(runAt(calls, 171), "PUMP ALERT");
  assert.equal(runAt(calls, 470 + 32), "MC AT LISTINGMC NOW", "the panel labels, both cells");
  assert.ok(!t.some((s) => /\$0\b|TBA|NaN|undefined/.test(s)), `no fabricated figure: ${t.filter((s) => /\$0|TBA|NaN|undefined/.test(s))}`);
});

test("a ticker that already carries $ is not drawn with two", { skip: !HAVE }, async () => {
  const calls = await drawnDuring(() => pm.frames({ ...COIN, symbol: "$$choo" }, null, { times: [0] }));
  assert.equal(runAt(calls, 262), "$CHOO");
});

test("an unread MC at listing leaves its cell OUT — never $0, never TBA on the art", { skip: !HAVE }, async () => {
  const calls = await drawnDuring(() => pm.frames({ ...COIN, firstMc: null }, null, { times: [0] }));
  const t = texts(calls);
  assert.ok(t.includes("$4.5M"), "MC now still drawn");
  assert.ok(!t.includes("$1.9M"));
  const labels = runAt(calls, 470 + 32);
  assert.match(labels, /MC NOW/);
  assert.doesNotMatch(labels, /MC AT LISTING/, "no label for a figure nobody read");
  assert.ok(!t.some((s) => /\$0\b|TBA/.test(s)));
});

test("no MC at all → no panel", { skip: !HAVE }, async () => {
  const calls = await drawnDuring(() => pm.frames({ ...COIN, firstMc: null, lastMc: null }, null, { times: [0] }));
  assert.equal(runAt(calls, 470 + 32), "", "no panel labels");
});

test("while the needle overshoots, neither the readout nor the gain passes the truth", { skip: !HAVE }, async () => {
  const times = [];
  for (let t = IN0; t < IN0 + 1.4; t += 0.04) times.push(t);
  const calls = await drawnDuring(() => pm.frames(COIN, null, { times }));
  // the readout sits at the dial texture's (360, 610); tick labels elsewhere
  const reads = calls.filter((c) => Math.abs(c.y - 610) < 0.01 && /×$/.test(c.text)).map((c) => parseFloat(c.text));
  assert.ok(reads.length > 10, "the readout was sampled");
  assert.ok(Math.max(...reads) <= 2, `readout went past the true 2×: ${Math.max(...reads)}`);
  const gains = calls.filter((c) => /^\+\d+%$/.test(c.text)).map((c) => Number(c.text.slice(1, -1)));
  assert.ok(gains.length > 5 && Math.max(...gains) <= 100, `the gain went past +100%: ${Math.max(...gains)}`);
  assert.ok(Math.min(...gains) < 100, "and it does count up");
});

test("the loop is exact: t = 6 draws what t = 0 draws", { skip: !HAVE }, async () => {
  const [a, b] = await pm.frames(COIN, logoPng("#3355ff"), { times: [0, pm.SECONDS] });
  let off = 0;
  for (let i = 0; i < a.length; i += 4) if (Math.abs(a[i] - b[i]) > 12 || Math.abs(a[i + 1] - b[i + 1]) > 12 || Math.abs(a[i + 2] - b[i + 2]) > 12) off++;
  assert.ok(off < 60, `${off} pixels differ across the seam`);
});

test("the intro is not frame 0: the needle really moves and the flare fires", { skip: !HAVE }, async () => {
  const [a, b] = await pm.frames(COIN, null, { times: [0, T_LAND + 0.05] });
  let off = 0;
  for (let i = 0; i < a.length; i += 4) if (Math.abs(a[i] - b[i]) > 20) off++;
  assert.ok(off > 20000, `only ${off} pixels changed`);
  assert.ok(HOLD < T_LAND && T_LAND < pm.SECONDS - 0.2, "the landing sits inside the intro");
});

test("the token's logo is what the hub shows; no logo draws the ticker's monogram", { skip: !HAVE }, async () => {
  const red = await pm.frames(COIN, logoPng("#ff0000"), { times: [0] });
  const blue = await pm.frames(COIN, logoPng("#0000ff"), { times: [0] });
  // the hub is near the gauge's centre on the frame: ~ (660 + 300, 20 + 300)
  let redder = 0;
  for (let y = 300; y < 340; y++) for (let x = 940; x < 980; x++) {
    const i = (y * pm.W + x) * 4;
    if (red[0][i] > blue[0][i] + 40) redder++;
  }
  assert.ok(redder > 300, `the logo did not reach the hub (${redder} px)`);
  const calls = await drawnDuring(() => pm.frames(COIN, null, { times: [0] }));
  assert.ok(texts(calls).includes("CH"), "the monogram");
});

test("an unreadable logo draws the monogram, never fails the clip", { skip: !HAVE }, async () => {
  const fr = await pm.frames(COIN, Buffer.from("not an image"), { times: [0] });
  assert.ok(fr && fr.length === 1);
});

test("render() writes a real, silent MP4 (an autoplaying Telegram animation)", { skip: !HAVE }, async () => {
  const out = path.join(os.tmpdir(), `pm-test-${process.pid}.mp4`);
  const r = await pm.render(COIN, logoPng("#F2B33D"), { badge: "Solana", outPath: out, count: 8 });
  assert.ok(r, "rendered");
  assert.equal(r.type, "animation");
  assert.ok(fss.statSync(out).size > 2000);
  fss.unlinkSync(out);
});

test("a cancelled render stops and hands nothing on", { skip: !HAVE }, async () => {
  const out = path.join(os.tmpdir(), `pm-cancel-${process.pid}.mp4`);
  const r = await pm.render(COIN, null, { outPath: out, cancel: { cancelled: true } });
  assert.equal(r, null);
  assert.ok(!fss.existsSync(out), "a half-written clip is deleted");
});

test("the gauge body is marched once and cached on disk", { skip: !HAVE }, async () => {
  const a = await pm._gaugeBody();
  const b = await pm._gaugeBody();
  assert.strictEqual(a, b, "one body per process");
  // the cache write is fire-and-forget; give it a moment
  for (let i = 0; i < 50 && !fss.existsSync(pm._cacheFile()); i++) await new Promise((r) => setTimeout(r, 100));
  assert.ok(fss.existsSync(pm._cacheFile()), "cached for the next process");
});

// ── the wiring: pumpChecker hands pumpMotion exactly the caption's figures ──
test("pumpMedia: the clip gets the caption's figures, the chain label and the token's logo", async () => {
  const pc = require("../src/services/pumpChecker");
  const ful = require("../src/fulfillment");
  const bt = require("../src/bannerTemplate");
  const saved = { render: pm.render, logo: ful.fetchLogoUrlX, posting: bt.postingEnabled, env: process.env.PUMP_MOTION };
  let got = null;
  try {
    process.env.PUMP_MOTION = "1";
    bt.postingEnabled = () => true;
    ful.fetchLogoUrlX = async (url) => ({ bytes: Buffer.from(`logo:${url}`), why: null });
    pm.render = async (coin, logo, opts) => { got = { coin, logo, opts }; return { type: "animation", source: "/tmp/x.mp4" }; };
    const r = { sym: "$CHOO", name: "Choo Train", chain: "solana", address: "So1111", logoUrl: "https://cdn/x.png" };
    const media = await pc._pumpMedia(r, { price: 1, mcap: 1_900_000 }, { priceUsd: 2.3, mcap: 4_500_000 }, 100);
    assert.deepEqual(media, { type: "animation", source: "/tmp/x.mp4" });
    assert.equal(got.coin.symbol, "$CHOO");
    assert.equal(got.coin.name, "Choo Train");
    assert.equal(got.coin.pct, 100, "the STEP the caption announces, not the raw +130%");
    assert.equal(got.coin.firstMc, fmt.pumpMc(1_900_000));
    assert.equal(got.coin.lastMc, fmt.pumpMc(4_500_000));
    assert.equal(got.opts.badge, "Solana");
    assert.equal(String(got.logo), "logo:https://cdn/x.png", "the logo through the ONE logo fetch");

    // a baseline recorded without a cap: the cell is left out, not "$0"
    await pc._pumpMedia(r, { price: 1, mcap: null }, { priceUsd: 2.3, mcap: 4_500_000 }, 100);
    assert.equal(got.coin.firstMc, null);

    // the admin's banner switch and PUMP_MOTION=0 both keep the clip off
    got = null; bt.postingEnabled = () => false;
    await pc._pumpMedia(r, { price: 1, mcap: 1 }, { priceUsd: 2, mcap: 2 }, 100);
    assert.equal(got, null, "banners switched off");
    bt.postingEnabled = () => true; process.env.PUMP_MOTION = "0";
    await pc._pumpMedia(r, { price: 1, mcap: 1 }, { priceUsd: 2, mcap: 2 }, 100);
    assert.equal(got, null, "PUMP_MOTION=0");
  } finally {
    pm.render = saved.render; ful.fetchLogoUrlX = saved.logo; bt.postingEnabled = saved.posting;
    if (saved.env === undefined) delete process.env.PUMP_MOTION; else process.env.PUMP_MOTION = saved.env;
  }
});

test("the old private raw logo fetch is gone from pumpChecker", () => {
  const src = fss.readFileSync(require.resolve("../src/services/pumpChecker.js"), "utf8").replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(src, /function fetchLogoBuffer/);
  assert.match(src, /fulfillment\.fetchLogoUrlX\(/);
});
