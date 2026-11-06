// 💠 PRISM — the animated Top-Gainers set, ADDED beside the premium stills.
//
// "thats good buatkan dari top 1 sampai 10 premium visual dan annimasinya
// bagus" + "Tambahan saja" (2026-11): ten animated boards, Top 1 → Top 10, as
// an extra row on the panel. What is pinned here:
//   • it is ADDITIVE — the premium still set stays the front set and the 🎲
//     random default, the classic stills stay one tap away;
//   • a Prism board posts as an ANIMATION end to end (preview, 📤 Post through
//     the queue, the daily post) with its frame 0 as the still for X;
//   • the bot's renderer rules hold: never throws, nothing invented, 📈 / 🏦 /
//     💲 off remove the figure (and 📈 the bars), one composition per count;
//   • frame 0 IS the still and the loop has no seam;
//   • no clip on this host → the still frame goes out instead of nothing.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "dexvra-gainers-prism-"));
process.env.BOT_DATA_DIR = DIR;
process.env.ADMIN_BOT_TOKEN = process.env.ADMIN_BOT_TOKEN || "123456:TEST_ADMIN_PRISM";

const pr = require("../src/gainersPrism");
const gr = require("../src/gainersRender");
const gb = require("../src/gainersBanner");
const cfg = require("../src/services/gainersConfig");
const kit = require("../src/helpers/canvasKit");
const { fmtCap, fmtPrice } = require("../src/helpers/format");

const MCAP = 7_654_321;
const PRICE = 0.0123456;
const coin = (i, extra = {}) => ({
  chain: "solana", address: "So" + i, symbol: "TOK" + i, name: "Token " + i,
  pct: 220 - i * 17, price: PRICE, mcap: MCAP, liq: 90_000, ...extra,
});
const many = (n, extra) => Array.from({ length: n }, (_, i) => coin(i + 1, extra));
const canDraw = () => Boolean(kit.canvasLib());
const isMp4 = (b) => Buffer.isBuffer(b) && b.length > 1000 && b.subarray(4, 8).toString("latin1") === "ftyp";
const isPng = (b) => Buffer.isBuffer(b) && b.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"));

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
const meanDiff = (a, b) => {
  let d = 0;
  for (let i = 0; i < a.length; i += 4) d += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
  return d / (a.length / 4) / 3;
};

// ── the set ─────────────────────────────────────────────────────────────────

test("the Prism ladder is ten boards, Top 1 → Top 10, each with its own composition", () => {
  assert.strictEqual(pr.IDS.length, 10);
  assert.deepStrictEqual(pr.IDS.map((id) => pr.countOf(id)), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.deepStrictEqual(pr.IDS.map((id) => pr.buttonOf(id)), ["💠1", "💠2", "💠3", "💠4", "💠5", "💠6", "💠7", "💠8", "💠9", "💠10"]);
  assert.strictEqual(new Set(pr.IDS.map(pr.labelOf)).size, 10, "two Prism boards would read the same in the picker");
  for (let n = 1; n <= 10; n++) assert.ok(pr.COMPOSITIONS[n], `no composition for ${n} coins`);
  for (const id of pr.IDS) {
    assert.ok(!gr.PREMIUM_IDS.includes(id) && !gr.CLASSIC_IDS.includes(id), `${id} leaked into a still set`);
    assert.ok(gr.isTemplate(id) && gr.isPrism(id), `${id} is not reachable through the render door`);
    assert.strictEqual(gr.countOf(id), pr.countOf(id));
  }
});

test("it is ADDED: the premium set stays the front set and the 🎲 default; Prism is its own row", () => {
  const menu = require("../src/admin/gainersMenu");
  const home = JSON.stringify(menu._panels.homeKb());
  for (const id of gr.PREMIUM_IDS) assert.ok(home.includes(`gn_t:${id}"`), `${id} left the front screen`);
  for (const id of pr.IDS) assert.ok(home.includes(`gn_t:${id}"`), `${id} has no button`);
  assert.ok(home.indexOf(`gn_t:${gr.PREMIUM_IDS[9]}"`) < home.indexOf(`gn_t:${pr.IDS[0]}"`), "Prism must sit UNDER the premium set");
  assert.ok(home.includes("gn_img"), "the classic layouts are no longer reachable");
  assert.match(menu._panels.homeText(), /Prism/);
  // the random default never rolls a clip by itself…
  for (const r of [0, 0.13, 0.5, 0.77, 0.999]) {
    assert.ok(gr.PREMIUM_IDS.includes(gr.pickTemplate("random", { pool: [], rng: () => r })), `rng ${r}`);
  }
  // …but an operator can pick one, as the default or in the rotation
  assert.strictEqual(gr.pickTemplate("prism7"), "prism7");
  assert.ok(pr.IDS.includes(gr.pickTemplate("random", { pool: ["prism3", "prism4"], rng: () => 0.5 })));
});

test("the settings accept a Prism board as the daily layout and in the rotation", async () => {
  await cfg.set({ template: "prism5", pool: ["prism2", "p3_arc", "nope"] });
  assert.strictEqual(cfg.get().template, "prism5");
  assert.deepStrictEqual(cfg.get().pool, ["prism2", "p3_arc"]);
  const pick = JSON.stringify(require("../src/admin/gainersMenu")._panels.tplPickKb());
  for (const id of pr.IDS) {
    assert.ok(pick.includes(`gn_dt:${id}"`), `${id} cannot be made the daily layout`);
    assert.ok(pick.includes(`gn_pool:${id}"`), `${id} cannot join the rotation`);
  }
  await cfg.reset();
});

// ── the render door ─────────────────────────────────────────────────────────

test("a Prism board renders to a looping MP4 with its frame 0 as the still", async () => {
  if (!pr.available()) return;
  const out = await gr.render({ template: "prism5", coins: many(5), dateText: "Friday · November 6 · 2026" });
  assert.ok(out, "nothing rendered");
  assert.strictEqual(out.mediaType, "animation");
  assert.strictEqual(out.ext, "mp4");
  assert.ok(isMp4(out.media), "media is not an MP4");
  assert.ok(isPng(out.still), "the still (X, thumbnails) is not a PNG");
  // frame 0 IS the still: decode it and compare against the frame the clip starts on
  const CV = kit.canvasLib();
  const img = await CV.loadImage(out.still);
  const c = CV.createCanvas(pr.OUT_W, pr.OUT_H);
  c.getContext("2d").drawImage(img, 0, 0);
  const still = c.getContext("2d").getImageData(0, 0, pr.OUT_W, pr.OUT_H).data;
  const [f0] = await pr._internals.frames({ template: "prism5", coins: many(5), dateText: "Friday · November 6 · 2026" }, [0]);
  assert.ok(meanDiff(still, f0) < 0.5, "the still is not the clip's first frame");
});

test("the loop has no seam, and the deal really moves the cards", async () => {
  if (!canDraw()) return;
  const [f0, last, mid] = await pr._internals.frames({ template: "prism10", coins: many(10), dateText: "" }, [0, 0.99999, 0.8]);
  assert.ok(meanDiff(f0, last) < 0.3, `the last frame does not flow into the first (${meanDiff(f0, last).toFixed(2)})`);
  assert.ok(meanDiff(f0, mid) > 1, "the enter phase draws the resting board — the cards never move");
});

test("every Prism board renders at its own size AND every smaller one", async () => {
  if (!canDraw()) return;
  for (let n = 1; n <= 10; n++) {
    const png = await pr.still({ template: "prism10", coins: many(n), dateText: "Saturday · October 3 · 2026" });
    assert.ok(isPng(png) && png.length > 10_000, `prism10 with ${n} coin(s) drew nothing`);
  }
  for (const id of pr.IDS) {
    assert.ok(isPng(await pr.still({ template: id, coins: many(10), dateText: "" })), `${id} drew nothing`);
  }
});

test("one composition per count: a card per coin, inside the stage, none overlapping, the leader biggest", async () => {
  if (!canDraw()) return;
  const [sx0, sy0, sx1, sy1] = pr._internals.STAGE;
  for (let n = 1; n <= 10; n++) {
    const { B } = await pr._internals.board({ template: "prism10", coins: many(n), dateText: "" });
    const boxes = B.items.map((it) => it.box);
    assert.strictEqual(boxes.length, n, `top ${n}: ${boxes.length} cards`);
    for (const [x0, y0, x1, y1] of boxes) {
      assert.ok(x0 >= sx0 - 0.5 && y0 >= sy0 - 0.5 && x1 <= sx1 + 0.5 && y1 <= sy1 + 0.5, `top ${n}: a card leaves the stage`);
      assert.ok(x0 >= pr._internals.PANEL[2], `top ${n}: a card covers the poster panel`);
    }
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i], b = boxes[j];
        const overlap = Math.min(a[2], b[2]) - Math.max(a[0], b[0]) > 1 && Math.min(a[3], b[3]) - Math.max(a[1], b[1]) > 1;
        assert.ok(!overlap, `top ${n}: cards ${i + 1} and ${j + 1} overlap`);
      }
    }
    const area = boxes.map(([x0, y0, x1, y1]) => (x1 - x0) * (y1 - y0));
    assert.strictEqual(area[0], Math.max(...area), `top ${n}: the leader's card is not the biggest`);
  }
});

// ── the switches, measured ──────────────────────────────────────────────────

test("📈 off: no percentage drawn anywhere — and no bars, which are the % as a length", async () => {
  if (!canDraw()) return;
  const on = await drawn(() => pr.still({ template: "prism10", coins: many(10), dateText: "" }));
  assert.match(on, /%/, "positive control: with 📈 on the gains are drawn");
  const off = await drawn(() => pr.still({ template: "prism10", coins: many(10), dateText: "", showPct: false }));
  assert.doesNotMatch(off, /%/, "a figure survived 📈 off");
  assert.doesNotMatch(off, /24H CHANGE/, "the figure's own label survived 📈 off");
  // bars: two boards differing ONLY in their gains must render identically when hidden
  const a = await pr._internals.frames({ template: "prism5", coins: many(5), dateText: "", showPct: false }, [0]);
  const b = await pr._internals.frames({ template: "prism5", coins: many(5).map((c, i) => ({ ...c, pct: 900 - i * 3 })), dateText: "", showPct: false }, [0]);
  assert.strictEqual(meanDiff(a[0], b[0]), 0, "something still follows the percentage with 📈 off");
  const c = await pr._internals.frames({ template: "prism5", coins: many(5).map((x, i) => ({ ...x, pct: 900 - i * 3 })), dateText: "" }, [0]);
  const d = await pr._internals.frames({ template: "prism5", coins: many(5), dateText: "" }, [0]);
  assert.ok(meanDiff(c[0], d[0]) > 0, "positive control: with 📈 on, the gains and bars follow the data");
});

test("🏦 / 💲 off remove the market cap / the price from the artwork", async () => {
  if (!canDraw()) return;
  const capText = fmtCap(MCAP).replace(/^\$/, "");
  const priceText = fmtPrice(PRICE).replace(/^\$/, "");
  const on = await drawn(() => pr.still({ template: "prism1", coins: many(1), dateText: "" }));
  assert.ok(on.includes(capText) && on.includes(priceText), "positive control: both figures are drawn when on");
  const noMc = await drawn(() => pr.still({ template: "prism1", coins: many(1), dateText: "", showMcap: false }));
  assert.ok(!noMc.includes(capText) && noMc.includes(priceText), "🏦 off left the cap (or took the price)");
  const noPr = await drawn(() => pr.still({ template: "prism1", coins: many(1), dateText: "", showPrice: false }));
  assert.ok(!noPr.includes(priceText) && noPr.includes(capText), "💲 off left the price (or took the cap)");
});

test("nothing is invented: a coin with no 24h change gets no figure, no price and no cap get no cells", async () => {
  if (!canDraw()) return;
  const bare = { chain: "solana", address: "SoX", symbol: "BARE", name: "Bare", pct: null, price: null, mcap: null };
  const t = await drawn(() => pr.still({ template: "prism1", coins: [bare], dateText: "" }));
  assert.match(t, /\$BARE/);
  assert.doesNotMatch(t, /%|MC \$|\$0/, "a figure nobody measured was drawn");
});

test("never throws: junk coins, unreadable logos, an empty board, an unknown id", async () => {
  if (!canDraw()) return;
  const junk = [
    { symbol: "SUPERLONGTICKERNAME", name: "A Very Long Project Name That Goes On And On", pct: 98765, price: 1e-12, mcap: 9e12, logo: Buffer.from("not an image") },
    { symbol: "$DUMP", pct: -42.5, price: 1.5 },
    { name: "no symbol", pct: 3 },
    null,
    { symbol: "牛来", name: "牛来 Finance", pct: 12 },
  ];
  for (const id of ["prism1", "prism3", "prism5", "prism10"]) {
    assert.ok(isPng(await pr.still({ template: id, coins: junk, dateText: "x" })), `${id} failed on junk`);
  }
  assert.strictEqual(await pr.still({ template: "prism5", coins: [] }), null, "an empty board must draw nothing");
  assert.strictEqual(await pr.still({ template: "nope", coins: many(3) }), null);
  assert.strictEqual(await gr.render({ template: "prism5", coins: [] }), null);
});

test("no clip on this host → the approved still goes out instead of nothing", async () => {
  if (!canDraw()) return;
  const real = pr.render;
  pr.render = async () => null; // ffmpeg missing / the encoder died
  try {
    const out = await gr.render({ template: "prism4", coins: many(4), dateText: "" });
    assert.ok(out, "a failed clip took the whole post with it");
    assert.strictEqual(out.mediaType, "photo");
    assert.ok(isPng(out.media) && out.still.equals(out.media));
  } finally {
    pr.render = real;
  }
});

// ── end to end, through the panel and the poster ────────────────────────────

const { Telegram } = require("telegraf");
const REAL_CALL_API = Telegram.prototype.callApi;
const ADMIN_ID = Number(require("../src/config/constants").ADMIN_IDS[0]);
const ADMIN = { id: ADMIN_ID, is_bot: false, first_name: "Owner", username: "owner" };
const CHAT = { id: 4343, type: "private" };

function harness() {
  const bot = require("../src/admin/adminBot").build();
  bot.botInfo = { id: 777, is_bot: true, first_name: "Dexvra Admin", username: "dexvraadminbot", can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false };
  bot.catch((e) => {
    throw e;
  });
  const calls = [];
  let mid = 100;
  let uid = 0;
  Telegram.prototype.callApi = async function stubbed(method, payload) {
    calls.push({ method, payload });
    if (["sendMessage", "sendPhoto", "sendAnimation"].includes(method)) return { message_id: ++mid, date: 0, chat: CHAT, text: payload && payload.text };
    return true;
  };
  const tap = (data) => bot.handleUpdate({
    update_id: ++uid,
    callback_query: { id: String(++uid), from: ADMIN, chat_instance: "1", data, message: { message_id: ++mid, date: 0, chat: CHAT, from: ADMIN, text: "panel" } },
  });
  const sent = () => calls.filter((c) => c.method === "sendMessage" || c.method === "editMessageText").map((c) => String(c.payload.text || ""));
  return { calls, tap, sent };
}

const BOARD = {
  live: true,
  tokens: ["HOODRAT", "KOMA", "GTAVI", "ESPRESSO", "IFHOOD"].map((symbol, i) => ({
    chain: "solana", address: "So" + symbol, symbol: "$" + symbol, name: symbol + " Token", logoUrl: null,
    links: { twitter: `https://x.com/${symbol.toLowerCase()}` }, priceUsd: 0.0042, mcap: 12_400_000 - i * 1e6,
    liq: 300_000, vol: { "24h": 1e5 }, chg: { "24h": 204 - i * 40 }, source: "live", tier: "DIAMOND",
  })),
};
function stubBoardFetch() {
  const real = global.fetch;
  global.fetch = async (url) => (String(url).endsWith("/api/tokens")
    ? { ok: true, status: 200, json: async () => BOARD, headers: { get: () => "application/json" } }
    : { ok: false, status: 404, json: async () => ({}), headers: { get: () => "text/plain" } });
  return () => {
    global.fetch = real;
  };
}

test.afterEach(() => {
  Telegram.prototype.callApi = REAL_CALL_API;
});
test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));

test("💠 on the panel previews an ANIMATION, says so, and 📤 Post publishes it as one", async () => {
  if (!pr.available()) return;
  const post = require("../src/channels/post");
  const poster = require("../src/services/gainersPoster");
  const store = require("../src/gainerspost/store");
  const restore = stubBoardFetch();
  const h = harness();
  try {
    await h.tap("gn_t:prism3");
    const anims = h.calls.filter((c) => c.method === "sendAnimation");
    assert.strictEqual(anims.length, 1, "the Prism preview must be the clip itself");
    assert.strictEqual(h.calls.filter((c) => c.method === "sendPhoto").length, 0, "an MP4 sent as a photo is refused by Telegram");
    assert.match(String(anims[0].payload.caption), /HOODRAT/, "the caption is the one the channel will get");
    const out = h.sent().join("\n");
    assert.match(out, /animated preview/, "the tap said nothing while the clip encoded");
    assert.match(out, /💠 animated/, "the card does not say this one moves");

    const realMedia = post.sendMedia;
    const realPhoto = post.sendPhoto;
    const seen = [];
    post.sendMedia = async (channel, media, caption) => {
      seen.push({ channel, media, caption, existed: fs.existsSync(media.source) });
      return { message_id: 9911 };
    };
    post.sendPhoto = async () => assert.fail("a Prism board was published as a photo");
    // The main bot polls forever; this one polls for 20 s. A clip encodes for a
    // few seconds BEFORE it is queued, so a short loop would give up first.
    const drain = (async () => {
      for (let i = 0; i < 100; i++) {
        await new Promise((r) => setTimeout(r, 200));
        await poster._drainQueue();
        if (seen.length) return;
      }
    })();
    try {
      await Promise.all([h.tap("gn_post"), drain]);
    } finally {
      post.sendMedia = realMedia;
      post.sendPhoto = realPhoto;
    }
    assert.strictEqual(seen.length, 1, "the main bot never published the queued clip");
    assert.strictEqual(seen[0].media.type, "animation");
    assert.ok(seen[0].existed && /\.mp4$/.test(seen[0].media.source), "published from the queued .mp4");
    assert.match(String(seen[0].caption.text), /HOODRAT/);
    assert.match(h.sent().join("\n"), /Posted/);
    // the job carried its still for the tweet
    const jobs = fs.readdirSync(store.GP_DIR).filter((n) => n.endsWith(".json")).map((n) => JSON.parse(fs.readFileSync(path.join(store.GP_DIR, n), "utf8")));
    const job = jobs.find((j) => j.template === "prism3");
    assert.ok(job && job.mediaType === "animation" && job.stillPath, "the queued job lost its still frame");
  } finally {
    restore();
  }
});

test("the daily post sends a Prism board as an animation, from a temp .mp4 it then removes", async () => {
  if (!pr.available()) return;
  const post = require("../src/channels/post");
  const poster = require("../src/services/gainersPoster");
  const restore = stubBoardFetch();
  const realMedia = post.sendMedia;
  const realPhoto = post.sendPhoto;
  const seen = [];
  post.sendMedia = async (channel, media) => {
    seen.push({ channel, media, existed: fs.existsSync(media.source) });
    return { message_id: 5150 };
  };
  post.sendPhoto = async () => assert.fail("a Prism board was posted as a photo");
  try {
    await cfg.set({ minGainPct: 1 });
    const res = await poster.postNow({ template: "prism4", by: "test" });
    assert.ok(res.ok, `the daily post failed: ${res.reason}`);
    assert.strictEqual(res.template, "prism4");
  } finally {
    post.sendMedia = realMedia;
    post.sendPhoto = realPhoto;
    restore();
    await cfg.reset();
  }
  assert.strictEqual(seen.length, 1);
  assert.strictEqual(seen[0].media.type, "animation");
  assert.ok(seen[0].existed && /\.mp4$/.test(seen[0].media.source), "GramJS names a Buffer photo.png — the clip must travel as a .mp4 file");
  assert.ok(!fs.existsSync(seen[0].media.source), "the temp clip was left on disk");
});
