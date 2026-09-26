// "saya ingin setiap listing token harus ada logonya jika punya logo".
//
// `$DLYN`, `$ORCHFLOWS` and `$GG` each went out drawing the Dexvra mark over a
// logo that existed. Every earlier fix made the FIRST fetch likelier; none could
// make it certain, because whether a public gateway holds a fresh CID this
// minute is a fact about somebody else's cache. So the artwork now has two more
// layers, and both are DRIVEN here rather than scanned — a wiring that does
// nothing refuses beautifully (the `curveBuyPath` scar):
//   1. `readArtwork` — a second pass, across every url the token is known by;
//   2. `logoRepair` — the published posts are EDITED in place once it loads.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-logorepair-"));
process.env.POST_LOGO_PAUSE_MS = "0"; // the pause is measured below by counting passes, not by sleeping

const test = require("node:test");
const assert = require("node:assert");
const fulfil = require("../src/fulfillment");
const repair = require("../src/services/logoRepair");
const post = require("../src/channels/post");
const gramjs = require("../src/gramjs");
const log = require("../src/helpers/logger");
const { CHANNELS } = require("../src/config/constants");

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const LOGO = "https://ipfs.io/ipfs/bafkreidualynelogoexample";
const CHAIN_LOGO = "https://gateway.pinata.cloud/ipfs/bafkreichainrecordlogo";

const ok = (url) => ({ bytes: PNG, reached: true, status: 200, why: null, via: "x 10ms", source: "proxy", url });
const cold = () => ({ bytes: null, reached: true, status: 404, why: "ipfs.io: no answer after 12000ms" });
const dirCid = () => ({ bytes: null, reached: true, status: 404, why: "ipfs.io: served text/html" });

// ── 1. readArtwork ──────────────────────────────────────────────────────────

test("⚠️ a cold CID is ASKED AGAIN — the second pass is what loads it", async () => {
  const asked = [];
  const r = await fulfil.readArtwork([LOGO], {
    tries: 2,
    pauseMs: 0,
    fetch: async (u, pass) => (asked.push(`${pass}:${u}`), pass === 0 ? cold() : ok()),
  });
  assert.ok(r.bytes, "one cold fetch may not be the whole post");
  assert.strictEqual(r.passes, 2);
  assert.strictEqual(r.url, LOGO);
  assert.deepStrictEqual(asked, [`0:${LOGO}`, `1:${LOGO}`]);
});

test("the chain record's logo is a SECOND candidate, asked when the row's own does not load", async () => {
  const r = await fulfil.readArtwork([LOGO, CHAIN_LOGO], {
    tries: 1,
    pauseMs: 0,
    fetch: async (u) => (u === CHAIN_LOGO ? ok() : cold()),
  });
  assert.ok(r.bytes);
  assert.strictEqual(r.url, CHAIN_LOGO, "the caller must know WHICH url loaded — only the row's own is pinned");
});

test("a DETERMINISTIC failure is not retried — a directory CID answers the same on every pass", async () => {
  let n = 0;
  const r = await fulfil.readArtwork([LOGO], { tries: 3, pauseMs: 0, fetch: async () => (n++, dirCid()) });
  assert.strictEqual(r.bytes, null);
  assert.strictEqual(n, 1, "waiting out a pause for an answer that cannot change is the cost this avoids");
  assert.match(r.why, /text\/html/, "the reason travels to the watch");
});

test("the FIRST candidate's reason is what is reported — it is the url the row carries", async () => {
  const r = await fulfil.readArtwork([LOGO, CHAIN_LOGO], {
    tries: 1,
    pauseMs: 0,
    fetch: async (u) => (u === LOGO ? cold() : dirCid()),
  });
  assert.match(r.why, /no answer/);
});

test("an unfetchable spelling is dropped, and nothing at all asks nothing", async () => {
  let n = 0;
  const r = await fulfil.readArtwork(["ipfs://bafkreix", "", null, LOGO, LOGO], { tries: 1, pauseMs: 0, fetch: async () => (n++, cold()) });
  assert.strictEqual(n, 1, "ipfs:// would be read as a path on our own site; a duplicate is one url");
  const none = await fulfil.readArtwork([], { fetch: async () => assert.fail("asked with no url") });
  assert.strictEqual(none.bytes, null);
});

// ── 2. logoRepair ───────────────────────────────────────────────────────────

const CAP = { text: "🆕 $DLYN listed", entities: [{ type: "bold", offset: 0, length: 5 }] };
const job = (over = {}) => ({
  kind: "listing",
  chain: "robinhood",
  address: "0x45614B7a71a97Ed66A63D35d14934F83a9768Ee6",
  sym: "DLYN",
  name: "DUALYNE",
  urls: [LOGO],
  pinFrom: LOGO,
  bannerCoin: { symbol: "DLYN" },
  posts: [
    { channel: "@dexvraio", message_id: 11, via: "gramjs", media: "listing", badge: "Xpress Listing", caption: CAP },
    { channel: "@dexvraann", message_id: 12, via: null, media: "listing", badge: "Xpress Listing", caption: CAP },
  ],
  ...over,
});

function deps(over = {}) {
  const calls = { edits: [], pins: [], built: [], alerts: [], market: 0, inFileDuringEdit: [] };
  return {
    calls,
    d: {
      readArtwork: async (urls) => (over.art ? over.art(urls) : ok(urls[0])),
      readMarket: async () => (calls.market++, over.live ? over.live() : { live: null }),
      adoptChainLogo: fulfil._adoptChainLogo,
      pinLogo: async (row, url) => (calls.pins.push(url), "/api/media/0123456789abcdef01234567.png"),
      postMedia: async (kind, coin, bytes, fileId, url, badge) => (calls.built.push({ kind, url, badge, bytes: !!bytes }), { source: bytes }),
      replaceMedia: async (channel, msg, media, caption) => {
        calls.inFileDuringEdit.push(repair._load().length);
        calls.edits.push({ channel, id: msg.message_id, via: msg.via, caption, media: !!media });
        return over.edit ? over.edit(channel) : { ok: true, via: "bot" };
      },
      alert: (html) => calls.alerts.push(html),
    },
  };
}

test("⚠️ THE POSITIVE TEST: once the artwork loads, EVERY post is edited in place with its own caption, and the row is pinned", async () => {
  await repair._reset();
  const t0 = 1_000_000;
  assert.strictEqual(await repair.enqueue(job(), t0), true);
  const { d, calls } = deps();
  const early = await repair.runOnce({ now: t0 + 1000, deps: d });
  assert.strictEqual(early.due, 0, "not due before the first delay — a repair must not race the post it repairs");
  const r = await repair.runOnce({ now: t0 + repair.DELAYS_MS[0], deps: d });
  assert.strictEqual(r.repaired, 2);
  assert.deepStrictEqual(calls.edits.map((e) => [e.channel, e.id, e.via]), [["@dexvraio", 11, "gramjs"], ["@dexvraann", 12, null]]);
  for (const e of calls.edits) assert.deepStrictEqual(e.caption, CAP, "the caption is RE-SENT — editMessageMedia would otherwise wipe the card");
  assert.deepStrictEqual(calls.pins, [LOGO], "the row is moved onto our own copy, so no later post asks a gateway");
  assert.strictEqual(calls.built.length, 1, "two posts sharing one banner render it once");
  assert.strictEqual(calls.built[0].bytes, true, "the banner is rebuilt WITH the logo");
  assert.strictEqual(calls.built[0].badge, "Xpress Listing", "the same badge the post went out with");
  assert.strictEqual(repair._load().length, 0, "a repaired job leaves the queue");
  assert.match(calls.alerts.join("\n"), /Logo repaired[\s\S]*2\/2/, "a recovery is an alert too");
});

test("⚠️ the job is CLAIMED before the first edit — a crash mid-repair cannot re-edit on every boot", async () => {
  await repair._reset();
  await repair.enqueue(job(), 0);
  const { d, calls } = deps();
  await repair.runOnce({ now: repair.DELAYS_MS[0], deps: d });
  assert.deepStrictEqual(calls.inFileDuringEdit, [0, 0], "the job must be out of the file while its posts are edited");
});

test("a logo that still does not load is RESCHEDULED on the widening schedule, and persisted", async () => {
  await repair._reset();
  await repair.enqueue(job(), 0);
  const { d, calls } = deps({ art: () => cold() });
  const now = repair.DELAYS_MS[0];
  const r = await repair.runOnce({ now, deps: d });
  assert.strictEqual(r.rescheduled, 1);
  assert.strictEqual(calls.edits.length, 0, "nothing to edit with");
  const [j] = repair._load();
  assert.strictEqual(j.attempts, 1);
  assert.strictEqual(j.nextAt, now + repair.DELAYS_MS[1]);
  assert.match(j.why, /no answer/);
});

test("⚠️ the schedule ENDS, and giving up is said with the token and the last reason", async () => {
  await repair._reset();
  await repair.enqueue(job(), 0);
  const { d, calls } = deps({ art: () => cold() });
  let now = 0;
  for (let i = 0; i < repair.DELAYS_MS.length; i++) {
    now += repair.DELAYS_MS[i];
    await repair.runOnce({ now, deps: d });
  }
  assert.strictEqual(repair._load().length, 0, "a job retried for ever is a request per tick for nothing");
  const html = calls.alerts.join("\n");
  assert.match(html, /gave up/i);
  assert.match(html, /DLYN/);
  assert.match(html, /no answer/);
  assert.match(html, /logos:check -- robinhood 0x45614B7a71a97Ed66A63D35d14934F83a9768Ee6/, "the remedy carries real values");
});

test("a borrowed url is NOT pinned — the CAS moves a row off the url it holds, and this is not it", async () => {
  await repair._reset();
  await repair.enqueue(job({ urls: [LOGO, CHAIN_LOGO] }), 0);
  const { d, calls } = deps({ art: () => ok(CHAIN_LOGO) });
  await repair.runOnce({ now: repair.DELAYS_MS[0], deps: d });
  assert.deepStrictEqual(calls.pins, []);
  assert.strictEqual(calls.built[0].url, CHAIN_LOGO);
  assert.strictEqual(calls.edits.length, 2);
});

test("a BLANK row whose chain could not be asked asks the chain again for its logo", async () => {
  await repair._reset();
  await repair.enqueue(job({ urls: [], pinFrom: null }), 0);
  const seen = [];
  const { d, calls } = deps({ live: () => ({ live: { logoUrl: CHAIN_LOGO } }), art: (urls) => (seen.push(...urls), ok(urls[0])) });
  await repair.runOnce({ now: repair.DELAYS_MS[0], deps: d });
  assert.strictEqual(calls.market, 1);
  assert.deepStrictEqual(seen, [CHAIN_LOGO]);
  assert.strictEqual(calls.edits.length, 2);
});

test("…and one whose chain now ANSWERS with no artwork is done — that is the project's choice, not a fault", async () => {
  await repair._reset();
  await repair.enqueue(job({ urls: [], pinFrom: null }), 0);
  const { d, calls } = deps({ live: () => ({ live: { priceUsd: 1 } }) });
  await repair.runOnce({ now: repair.DELAYS_MS[0], deps: d });
  assert.strictEqual(repair._load().length, 0);
  assert.strictEqual(calls.edits.length, 0);
  assert.strictEqual(calls.alerts.length, 0, "not a repair and not a failure");
});

test("an edit the channel refuses is NAMED in the repaired alert, not dropped", async () => {
  await repair._reset();
  await repair.enqueue(job(), 0);
  const { d, calls } = deps({ edit: (ch) => (ch === "@dexvraann" ? { ok: false, why: "bot: MESSAGE_AUTHOR_REQUIRED" } : { ok: true }) });
  await repair.runOnce({ now: repair.DELAYS_MS[0], deps: d });
  assert.match(calls.alerts.join("\n"), /1\/2[\s\S]*MESSAGE_AUTHOR_REQUIRED/);
});

test("a second enqueue for the same post kind MERGES — one repair, never two edits of one post", async () => {
  await repair._reset();
  await repair.enqueue(job(), 0);
  await repair.enqueue(job({ urls: [CHAIN_LOGO], posts: [{ channel: "@dexvraio", message_id: 11, media: "listing", caption: CAP }, { channel: "@dexvratrending", message_id: 13, media: "trending", caption: CAP }] }), 0);
  const jobs = repair._load();
  assert.strictEqual(jobs.length, 1);
  assert.deepStrictEqual(jobs[0].posts.map((p) => p.message_id), [11, 12, 13]);
  assert.deepStrictEqual(jobs[0].urls, [LOGO, CHAIN_LOGO]);
});

test("nothing that went out means nothing is queued", async () => {
  await repair._reset();
  assert.strictEqual(await repair.enqueue(job({ posts: [null, { channel: "@x" }] }), 0), false);
  assert.strictEqual(repair._load().length, 0);
});

// ── 3. replaceMedia ─────────────────────────────────────────────────────────

function stubTg() {
  const calls = [];
  const saved = post.telegram();
  post.attach({
    editMessageMedia: async (chat, id, inline, media) => {
      calls.push({ via: "bot", chat, id, media });
      if (calls.botFails) throw new Error(calls.botFails);
      return true;
    },
  });
  const realAvail = gramjs.available;
  const realEdit = gramjs.editChannelMedia;
  gramjs.available = () => true;
  gramjs.editChannelMedia = async (chat, id, args) => {
    calls.push({ via: "gramjs", chat, id, args });
    if (calls.gramFails) throw new Error(calls.gramFails);
    return { message_id: id };
  };
  return {
    calls,
    restore: () => {
      post.attach(saved);
      gramjs.available = realAvail;
      gramjs.editChannelMedia = realEdit;
    },
  };
}

test("⚠️ the BOT API edit re-sends the caption and its entities — editMessageMedia otherwise wipes the listing card", async () => {
  const s = stubTg();
  try {
    const r = await post.replaceMedia("@dexvraio", { message_id: 5 }, { source: PNG }, CAP);
    assert.deepStrictEqual(r, { ok: true, via: "bot" });
    const m = s.calls[0].media;
    assert.strictEqual(m.type, "photo");
    assert.strictEqual(m.caption, CAP.text);
    assert.deepStrictEqual(m.caption_entities, CAP.entities);
    assert.ok(Buffer.isBuffer(m.media.source), "the upload wrapper is preserved");
  } finally {
    s.restore();
  }
});

test("a post the PREMIUM account sent is edited by that account first — and an animated banner keeps its type", async () => {
  const s = stubTg();
  try {
    const r = await post.replaceMedia("@dexvraio", { message_id: 6, via: "gramjs" }, { type: "animation", source: "/tmp/x.mp4" }, CAP);
    assert.strictEqual(r.via, "gramjs");
    assert.strictEqual(s.calls[0].via, "gramjs");
    assert.strictEqual(s.calls[0].args.mediaType, "animation", "without it the clip is swapped in as a file card");
    assert.deepStrictEqual(s.calls[0].args.entities, CAP.entities);
  } finally {
    s.restore();
  }
});

test("…and when the author cannot, the OTHER account is tried — both reasons travel when neither can", async () => {
  const s = stubTg();
  try {
    s.calls.gramFails = "CHAT_ADMIN_REQUIRED";
    const r1 = await post.replaceMedia("@dexvraio", { message_id: 7, via: "gramjs" }, { source: PNG }, CAP);
    assert.deepStrictEqual(r1, { ok: true, via: "bot" });
    s.calls.botFails = "MESSAGE_AUTHOR_REQUIRED";
    const r2 = await post.replaceMedia("@dexvraio", { message_id: 8, via: "gramjs" }, { source: PNG }, CAP);
    assert.strictEqual(r2.ok, false);
    assert.match(r2.why, /CHAT_ADMIN_REQUIRED/);
    assert.match(r2.why, /MESSAGE_AUTHOR_REQUIRED/);
  } finally {
    s.restore();
  }
});

test("'not modified' is the outcome we wanted, not a failure", async () => {
  const s = stubTg();
  try {
    s.calls.botFails = "Bad Request: message is not modified";
    const r = await post.replaceMedia("@dexvraio", { message_id: 9 }, { source: PNG }, CAP);
    assert.strictEqual(r.ok, true);
  } finally {
    s.restore();
  }
});

// ── 4. fulfilment queues the repair ─────────────────────────────────────────

function stubWorld({ artOk }) {
  const api = require("../src/api/dexvra");
  const market = require("../src/marketdata");
  const x = require("../src/twitter");
  const br = require("../src/bannerRender");
  const bt = require("../src/bannerTemplate");
  const postids = require("../src/channels/postids");
  const te = require("../src/tokenEmoji");
  const saved = {
    api: { ...api }, market: { ...market }, x: { ...x }, send: post.sendMedia,
    br: [br.renderListingBanner, br.renderTrendingBanner], bt: bt.compose, ids: postids.set, te: te.ensureTokenEmoji,
    fetch: global.fetch, alert: log.alert,
  };
  const alerts = [];
  let n = 100;
  api.createListing = async () => ({ id: "L1", ok: true });
  api.bookTrending = async (chain, address) => ({ chain, address, sym: "DLYN", name: "DUALYNE", logoUrl: LOGO });
  api.uploadImage = async () => null;
  market.fetchMarket = async () => ({ priceUsd: 1, mcap: 1000, liq: 100, vol24: 10 });
  x.postListing = async () => null;
  x.postTrending = async () => null;
  post.sendMedia = async (channel) => ({ message_id: n++, via: channel === CHANNELS.listing ? "gramjs" : undefined });
  br.renderListingBanner = async () => null;
  br.renderTrendingBanner = async () => null;
  bt.compose = async () => null;
  postids.set = async () => {};
  te.ensureTokenEmoji = async () => null;
  log.alert = (h) => alerts.push(h);
  global.fetch = async () =>
    artOk
      ? { ok: true, status: 200, headers: { get: () => null }, arrayBuffer: async () => PNG.buffer.slice(PNG.byteOffset, PNG.byteOffset + PNG.length) }
      : { ok: false, status: 404, headers: { get: (k) => (k === "x-logo-why" ? "ipfs.io: no answer after 12000ms" : null) }, arrayBuffer: async () => new ArrayBuffer(0) };
  return {
    alerts,
    restore: () => {
      Object.assign(api, saved.api);
      Object.assign(market, saved.market);
      Object.assign(x, saved.x);
      post.sendMedia = saved.send;
      [br.renderListingBanner, br.renderTrendingBanner] = saved.br;
      bt.compose = saved.bt;
      postids.set = saved.ids;
      te.ensureTokenEmoji = saved.te;
      global.fetch = saved.fetch;
      log.alert = saved.alert;
    },
  };
}

const ctx = () => ({ from: { id: 9 }, chat: { id: 9 }, telegram: { sendMessage: async () => ({}) }, reply: async () => ({}) });
const listingOrder = () => ({
  id: "o1",
  kind: "xpress_listing",
  payload: {
    listingInput: { chain: "robinhood", address: "0x45614B7a71a97Ed66A63D35d14934F83a9768Ee6", sym: "DLYN", name: "DUALYNE", tier: "XPRESS", logoUrl: LOGO },
    logoFileId: null,
    trendHours: 0,
  },
});

test("⚠️ DRIVEN: a listing whose artwork did not load QUEUES its posts for repair — with the gramjs author recorded", async () => {
  await repair._reset();
  fulfil._resetWarm();
  const w = stubWorld({ artOk: false });
  try {
    await fulfil.fulfillListing(ctx(), listingOrder());
  } finally {
    w.restore();
  }
  const [j] = repair._load();
  assert.ok(j, "the post went out without its logo — nothing now would ever fix it");
  assert.strictEqual(j.kind, "listing");
  assert.strictEqual(j.pinFrom, LOGO);
  assert.ok(j.urls.includes(LOGO));
  assert.strictEqual(j.posts[0].channel, CHANNELS.listing);
  assert.strictEqual(j.posts[0].via, "gramjs");
  assert.strictEqual(j.posts[0].media, "listing");
  assert.ok(j.posts[0].caption && (j.posts[0].caption.text || j.posts[0].caption.html), "the caption to re-send travels with the job");
  assert.match(w.alerts.join("\n"), /Repair: the bot keeps retrying/, "the ops alert says a repair is coming, so nobody races it");
});

test("…and one whose artwork DID load queues nothing", async () => {
  await repair._reset();
  fulfil._resetWarm();
  const w = stubWorld({ artOk: true });
  try {
    await fulfil.fulfillListing(ctx(), listingOrder());
  } finally {
    w.restore();
  }
  assert.strictEqual(repair._load().length, 0);
});

test("⚠️ DRIVEN: the trending sibling queues its repair too — a trending slot is a purchase", async () => {
  await repair._reset();
  fulfil._resetWarm();
  const w = stubWorld({ artOk: false });
  try {
    await fulfil.fulfillTrending(ctx(), { id: "o2", kind: "trending", payload: { chain: "robinhood", address: "0x45614B7a71a97Ed66A63D35d14934F83a9768Ee6", hours: 24 } });
  } finally {
    w.restore();
  }
  const [j] = repair._load();
  assert.ok(j, "a trending slot that lost its artwork must be repaired as well");
  assert.strictEqual(j.kind, "trending");
  assert.deepStrictEqual(j.posts.map((p) => p.channel), [CHANNELS.trending, CHANNELS.announce]);
  assert.strictEqual(j.posts[0].badge, "Trending 24H");
});

test("a message the premium account sent says so — the repair asks the author first (source guard: sendToChannel needs a live MTProto client)", () => {
  const src = fss.readFileSync(path.join(__dirname, "../src/gramjs.js"), "utf8").replace(/\/\/[^\n]*/g, "");
  const body = src.slice(src.indexOf("async function sendToChannel("), src.indexOf("async function pinChannelMessage("));
  assert.match(body, /return \{ message_id: sent\.id,.*via: "gramjs" \};/);
  assert.match(fss.readFileSync(path.join(__dirname, "../src/services/attach.js"), "utf8"), /add\("logoRepair", \(\) => require\("\.\/logoRepair"\)\.start\(\)\)/, "a service nobody starts repairs nothing");
});
