// Top-Gainers MOTION banners — "saya igin versi gif atau vidio bukan gambar lgi
// … top 1 sampai top 10 dengan style ui ux berbeda". Ten layouts, each one a
// looping MP4 Telegram plays as a GIF, reaching the channel through the same
// admin preview → queue → main-bot publish path the still banners use.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "dexvra-gainers-motion-"));
process.env.BOT_DATA_DIR = DIR;

const gm = require("../src/gainersMotion");
const gr = require("../src/gainersRender");
const gainers = require("../src/gainers");
const cfg = require("../src/services/gainersConfig");
const store = require("../src/gainerspost/store");
const post = require("../src/channels/post");
const poster = require("../src/services/gainersPoster");
const kit = require("../src/helpers/canvasKit");
const { fmtPct } = require("../src/helpers/format");

const coin = (symbol, pct, extra = {}) => ({
  chain: "solana",
  address: "So" + symbol,
  symbol,
  name: symbol + " Token",
  pct,
  price: 0.0042,
  mcap: 12_400_000,
  liq: 90_000,
  url: `https://dexvra.io/token/solana/So${symbol}`,
  ...extra,
});
const many = (n) => Array.from({ length: n }, (_, i) => coin(`TOK${i + 1}`, 420 - i * 37));
// ISO BMFF: bytes 4..8 of an MP4 are the "ftyp" box type.
const isMp4 = (b) => Buffer.isBuffer(b) && b.length > 1000 && b.slice(4, 8).toString("latin1") === "ftyp";
const isPng = (b) => Buffer.isBuffer(b) && b.slice(1, 4).toString("latin1") === "PNG";
const tiny = { scale: 0.25, seconds: 1, fps: 10 };

test("ten motion layouts, one per board size, and no two alike", () => {
  assert.deepStrictEqual(gm.TEMPLATE_IDS, ["v1", "v2", "v3", "v4", "v5", "v6", "v7", "v8", "v9", "v10"]);
  assert.deepStrictEqual(gm.TEMPLATES.map((t) => t.n), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], "top 1 through top 10");
  const layouts = new Set(gm.TEMPLATES.map((t) => t.layout));
  const backs = new Set(gm.TEMPLATES.map((t) => t.bg));
  assert.strictEqual(layouts.size, 10, "two templates share a layout — that is a recolour, not a variation");
  assert.strictEqual(backs.size, 10, "two templates share a backdrop");
  for (const t of gm.TEMPLATES) assert.ok(gm._internals.LAYOUTS[t.layout], `${t.id} names a layout that does not exist`);
  // the still banners and the motion ones may never share an id — the queue,
  // the config and the picker all key off it
  for (const id of gm.TEMPLATE_IDS) assert.ok(!require("../src/gainersBanner").isTemplate(id), `${id} collides with a still layout`);
});

test("every motion layout encodes a real MP4, full and on a thin day", { timeout: 120_000 }, async (t) => {
  if (!gm.available()) return t.skip("canvas unavailable");
  for (const id of gm.TEMPLATE_IDS) {
    const n = gm.countOf(id);
    for (const k of new Set([1, n])) {
      const b = await gm.render({ template: id, coins: many(k), dateText: "26 SEP 2026", ...tiny });
      assert.ok(isMp4(b), `${id} with ${k} coin(s) did not encode`);
    }
  }
});

test("render never throws, and answers null for nothing to draw", async () => {
  assert.strictEqual(await gm.render({ template: "v5", coins: [] }), null);
  assert.strictEqual(await gm.render({ template: "nope", coins: many(3) }), null);
  assert.strictEqual(await gm.renderStill({ template: "v5", coins: null }), null);
});

test("the count-up lands EXACTLY on the live figure, and shows nothing before it starts", () => {
  const { pctOf } = gm._internals;
  const c = coin("A", 188.4);
  assert.strictEqual(pctOf({ showPct: true }, c, 1), fmtPct(188.4));
  assert.strictEqual(pctOf({ showPct: true }, c, 0), "", "a 0.0% frame is a figure nobody measured");
  assert.strictEqual(pctOf({ showPct: false }, c, 1), "", "a hidden figure is hidden");
  assert.strictEqual(pctOf({ showPct: true }, coin("B", null), 1), "", "an unreadable change is not a 0%");
});

// fillText / fillStyle spy — the same trick gainersPct uses on the stills
async function drawn(fn) {
  const CV = kit.canvasLib();
  const proto = Object.getPrototypeOf(CV.createCanvas(4, 4).getContext("2d"));
  const real = proto.fillText;
  const texts = [];
  proto.fillText = function (t, ...rest) {
    texts.push(String(t));
    return real.call(this, t, ...rest);
  };
  try {
    await fn();
  } finally {
    proto.fillText = real;
  }
  return texts;
}

test("showPct:false removes the figure from every motion layout — split-flap glyphs included", async (t) => {
  if (!gm.available()) return t.skip("canvas unavailable");
  for (const id of gm.TEMPLATE_IDS) {
    const coins = many(gm.countOf(id));
    const hidden = await drawn(() => gm.renderStill({ template: id, coins, dateText: "", showPct: false, scale: 0.25 }));
    assert.ok(!hidden.some((s) => s.includes("%")), `${id} drew a percentage with the switch OFF`);
    // vacuity: with the switch ON the same frame does draw one
    const shown = await drawn(() => gm.renderStill({ template: id, coins, dateText: "", showPct: true, scale: 0.25 }));
    assert.ok(shown.some((s) => s.includes("%")), `${id} draws no percentage at all — the OFF check above proved nothing`);
  }
});

test("the render never mutates the caller's sample", async (t) => {
  if (!gm.available()) return t.skip("canvas unavailable");
  const coins = many(3);
  const before = JSON.stringify(coins);
  await gm.renderStill({ template: "v3", coins, scale: 0.25 });
  assert.strictEqual(JSON.stringify(coins), before);
});

// ── the facade ──────────────────────────────────────────────────────────────
test("random rolls the configured FORMAT; a concrete id is honoured as given", () => {
  const rng = () => 0.99;
  assert.ok(gm.isTemplate(gr.pickTemplate("random", { format: "animated", rng })));
  assert.ok(!gm.isTemplate(gr.pickTemplate("random", { format: "image", rng })), "an image setting rolled a video");
  assert.strictEqual(gr.pickTemplate("random", { pool: ["list5", "v7"], format: "animated", rng }), "v7", "the pool is filtered to the format");
  assert.strictEqual(gr.pickTemplate("list5", { format: "animated" }), "list5");
  assert.strictEqual(gr.pickTemplate("v2", { format: "image" }), "v2");
});

test("the facade hands back an animation AND a PNG still for the tweet", async (t) => {
  if (!gm.available()) return t.skip("canvas unavailable");
  const real = gm.render;
  gm.render = (o) => real({ ...o, ...tiny });
  try {
    const out = await gr.render({ template: "v5", coins: many(5), dateText: "" });
    assert.strictEqual(out.mediaType, "animation");
    assert.strictEqual(out.ext, "mp4");
    assert.ok(isMp4(out.media));
    assert.ok(isPng(out.still), "no still to tweet");
  } finally {
    gm.render = real;
  }
});

test("a video that does not encode degrades to its still frame as a photo — never to nothing", async (t) => {
  if (!gm.available()) return t.skip("canvas unavailable");
  const real = gm.render;
  gm.render = async () => null; // no ffmpeg on the box, an encode error…
  try {
    const out = await gr.render({ template: "v3", coins: many(3), dateText: "" });
    assert.strictEqual(out.mediaType, "photo");
    assert.ok(isPng(out.media));
  } finally {
    gm.render = real;
  }
});

test("the format setting ships as video, and survives a reset", async () => {
  fs.rmSync(path.join(DIR, cfg.FILE), { force: true });
  assert.strictEqual(cfg.get().format, "animated");
  await cfg.set({ format: "image" });
  assert.strictEqual(cfg.get().format, "image");
  await assert.rejects(() => cfg.set({ format: "gif" }), /unknown format/);
  await cfg.set({ template: "v8" });
  assert.strictEqual(cfg.get().template, "v8", "a motion layout can be the default");
  await cfg.reset();
  assert.strictEqual(cfg.get().format, "animated");
});

// ── queue → main bot ────────────────────────────────────────────────────────
test("a queued motion banner is published as an ANIMATION and tweeted as its still", async () => {
  const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom"), Buffer.alloc(2000)]);
  const png = Buffer.from("89504e470d0a1a0a" + "00".repeat(64), "hex");
  const job = await store.request({
    image: mp4,
    mediaType: "animation",
    ext: "mp4",
    still: png,
    caption: { text: "hi", entities: [] },
    channel: "@dexvratrending",
    template: "v5",
    symbols: ["A"],
  });
  assert.match(job.imagePath, /\.mp4$/);
  assert.ok(fs.existsSync(job.stillPath));
  const seen = [];
  const realMedia = post.sendMedia;
  const realPhoto = post.sendPhoto;
  post.sendMedia = async (channel, media, caption) => (seen.push({ channel, media, caption }), { message_id: 77 });
  post.sendPhoto = async () => {
    throw new Error("a motion banner must not go out as a photo");
  };
  try {
    await poster._drainQueue();
  } finally {
    post.sendMedia = realMedia;
    post.sendPhoto = realPhoto;
  }
  assert.strictEqual(seen.length, 1);
  assert.strictEqual(seen[0].media.type, "animation");
  assert.strictEqual(seen[0].media.source, job.imagePath);
  const done = store.get(job.id);
  assert.strictEqual(done.status, "done");
  assert.ok(!fs.existsSync(job.imagePath) && !fs.existsSync(job.stillPath), "both files are cleaned up");
});

test("the tweet of a queued motion banner uses the still, not the MP4", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "src/services/gainersPoster.js"), "utf8");
  assert.match(src, /tweetBoard\(job\.xList, job\.xDate \|\| "", job\.stillPath \|\| job\.imagePath\)/);
  assert.match(src, /tweetGainers\(res\.coins, out\.still, cfg\)/);
});

// ── every token has its logo ────────────────────────────────────────────────
test("an ipfs:// logo is fetched through our proxy, never glued onto the site url", () => {
  const { logoCandidates, proxyCandidates } = gainers._internals;
  const c = { chain: "robinhood", address: "0xabc", logoUrl: "ipfs://bafkreiabc", liveLogoUrl: "https://cdn.example/x.png" };
  assert.ok(!logoCandidates(c).some((u) => u.includes("ipfs://")), "ipfs:// was turned into a site path");
  const p = proxyCandidates(c);
  assert.ok(p.some((u) => /\/api\/logo\?u=ipfs%3A%2F%2Fbafkreiabc$/.test(u)), "no proxied candidate for the ipfs logo");
  assert.ok(p.some((u) => /\/api\/logo\?u=https%3A%2F%2Fcdn\.example%2Fx\.png$/.test(u)));
});

test("when every url fails, the resolver the listing cleanup uses is asked — and its logo is drawn", async (t) => {
  if (!kit.canvasLib()) return t.skip("canvas unavailable");
  const cv = kit.canvasLib();
  const c = cv.createCanvas(8, 8);
  c.getContext("2d").fillRect(0, 0, 8, 8);
  const PNG = c.toBuffer("image/png");
  const realFetch = global.fetch;
  global.fetch = async (url) => {
    if (String(url) === "https://found.example/logo.png") {
      return { ok: true, status: 200, headers: { get: () => "image/png" }, arrayBuffer: async () => PNG };
    }
    return { ok: false, status: 404, headers: { get: () => "text/plain" }, arrayBuffer: async () => new ArrayBuffer(0) };
  };
  let asked = 0;
  try {
    const coinX = { chain: "nosuchchain", address: "0xdead", symbol: "X", logoUrl: "https://gone.example/x.png" };
    const buf = await gainers._internals.resolveLogo(coinX, {
      deps: { lookup: async () => (asked++, { ok: true, url: "https://found.example/logo.png" }) },
    });
    assert.strictEqual(asked, 1);
    assert.ok(Buffer.isBuffer(buf) && buf.equals(PNG), "the resolver's logo was not used");
  } finally {
    global.fetch = realFetch;
  }
});

test("a direct hit never pays for the resolver", async (t) => {
  if (!kit.canvasLib()) return t.skip("canvas unavailable");
  const cv = kit.canvasLib();
  const c = cv.createCanvas(8, 8);
  c.getContext("2d").fillRect(0, 0, 8, 8);
  const PNG = c.toBuffer("image/png");
  const realFetch = global.fetch;
  global.fetch = async () => ({ ok: true, status: 200, headers: { get: () => "image/png" }, arrayBuffer: async () => PNG });
  let asked = 0;
  try {
    const buf = await gainers._internals.resolveLogo(
      { chain: "nosuchchain", address: "0x1", symbol: "Y", logoUrl: "https://direct.example/y.png" },
      { deps: { lookup: async () => (asked++, null) } },
    );
    assert.ok(buf);
    assert.strictEqual(asked, 0);
  } finally {
    global.fetch = realFetch;
  }
});

test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));
