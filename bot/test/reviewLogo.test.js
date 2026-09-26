// "harusnya bot mengirim teks pake logo juga" — the $HAPPYCAT review card said
// "Logo: added ✓" and went out as TEXT. The logo is an IPFS url on one gateway;
// handing Telegram that url made TELEGRAM fetch a cold CID, it failed, and the
// card fell back to text with a debug line nobody sees. The card now uploads
// the bytes the bot fetched itself — the same fetch the paid post uses.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-reviewlogo-"));
process.env.REVIEW_LOGO_MS = "1000";

const test = require("node:test");
const assert = require("node:assert");
const fulfil = require("../src/fulfillment");
const listing = require("../src/handlers/listing");

const PNG = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.alloc(24, 1)]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
const LOGO = "https://gateway.pinata.cloud/ipfs/Qmc3yP4sXVhzfvhd9ngdD9sxRvfoouuXcFeUbGjiYULZyn";

function stubFetch(answer) {
  const orig = global.fetch;
  const asked = [];
  global.fetch = async (url) => {
    asked.push(String(url));
    return answer(String(url));
  };
  return { asked, restore: () => (global.fetch = orig) };
}
const bytes = (buf) => ({ ok: true, status: 200, headers: { get: () => null }, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length) });
const miss = () => ({ ok: false, status: 404, headers: { get: (k) => (k === "x-logo-why" ? "no gateway had it" : null) }, arrayBuffer: async () => new ArrayBuffer(0) });

function fakeCtx(form) {
  const sent = [];
  const ctx = {
    session: { form, type: "listing" },
    chat: { id: 1 },
    from: { id: 1 },
    replyWithPhoto: async (photo, extra) => (sent.push({ kind: "photo", photo, extra }), { message_id: 10 }),
    reply: async (text, extra) => (sent.push({ kind: "text", text, extra }), { message_id: 11 }),
    deleteMessage: async () => true,
    telegram: { deleteMessage: async () => true },
  };
  return { ctx, sent };
}
const form = (over = {}) => ({
  chain: "robinhood",
  address: "0x113ff96E9392a6501f65B3BD4AACB89D3D0945cC",
  name: "HAPPYCAT",
  sym: "HAPPYCAT",
  logoUrl: LOGO,
  twitter: "https://x.com/MEADGod",
  ...over,
});

test("⚠️ THE POSITIVE TEST: the review card UPLOADS the logo bytes the bot fetched — Telegram is never handed the gateway url", async () => {
  fulfil._resetWarm();
  const { restore } = stubFetch(() => bytes(PNG));
  try {
    const { ctx, sent } = fakeCtx(form());
    await listing.showReview(ctx);
    assert.strictEqual(sent[0] && sent[0].kind, "photo", `the card went out as ${sent[0] && sent[0].kind}`);
    assert.ok(Buffer.isBuffer(sent[0].photo.source), "a buffer upload, not a url Telegram must fetch itself");
    assert.ok(sent[0].photo.source.equals(PNG), "…and exactly the bytes that were fetched");
  } finally {
    restore();
  }
});

test("…through the proxy with gateway failover, and warmed for the post after payment", async () => {
  fulfil._resetWarm();
  const { asked, restore } = stubFetch(() => bytes(PNG));
  try {
    const { ctx } = fakeCtx(form());
    await listing.showReview(ctx);
    assert.ok(asked.some((u) => u.includes("/api/logo")), `asked: ${asked.join(", ")}`);
    const before = asked.length;
    await fulfil._fetchLogoUrlWarm(LOGO);
    assert.strictEqual(asked.length, before, "the post must read the review card's bytes back, not fetch again");
  } finally {
    restore();
  }
});

test("a logo that will not load falls back to the url, as before — this can only ADD a picture", async () => {
  fulfil._resetWarm();
  const { restore } = stubFetch(() => miss());
  try {
    const { ctx, sent } = fakeCtx(form());
    await listing.showReview(ctx);
    assert.strictEqual(sent[0].kind, "photo");
    assert.strictEqual(sent[0].photo, LOGO);
  } finally {
    restore();
  }
});

test("⚠️ an SVG is never uploaded through sendPhoto — Telegram refuses it and the card would lose the picture", async () => {
  fulfil._resetWarm();
  const { restore } = stubFetch(() => bytes(SVG));
  try {
    const { ctx, sent } = fakeCtx(form());
    await listing.showReview(ctx);
    assert.notStrictEqual(typeof sent[0].photo, "object", "an SVG buffer must not be uploaded as a photo");
  } finally {
    restore();
  }
});

test("…a buyer's own upload goes as its Telegram file id, with no fetch at all", async () => {
  fulfil._resetWarm();
  const { asked, restore } = stubFetch(() => bytes(PNG));
  try {
    const { ctx, sent } = fakeCtx(form({ logoFileId: "AgACfileid", logoUrl: undefined }));
    await listing.showReview(ctx);
    assert.strictEqual(sent[0].photo, "AgACfileid");
    assert.strictEqual(asked.length, 0);
  } finally {
    restore();
  }
});

test("⚠️ a gateway that hangs cannot hold the card past REVIEW_LOGO_MS", async () => {
  fulfil._resetWarm();
  const { restore } = stubFetch(() => new Promise(() => {}));
  try {
    const { ctx, sent } = fakeCtx(form());
    const t0 = Date.now();
    await listing.showReview(ctx);
    assert.ok(Date.now() - t0 < 3000, `the card waited ${Date.now() - t0}ms`);
    assert.strictEqual(sent.length, 1, "the card still went out");
  } finally {
    restore();
  }
});

test("photoFormat reads magic bytes, not a file name", () => {
  const f = listing._photoFormat;
  assert.strictEqual(f(PNG), "png");
  assert.strictEqual(f(Buffer.concat([Buffer.from("ffd8ffe0", "hex"), Buffer.alloc(12)])), "jpeg");
  assert.strictEqual(f(Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP"), Buffer.alloc(4)])), "webp");
  assert.strictEqual(f(Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(10)])), "gif");
  assert.strictEqual(f(SVG), null);
  assert.strictEqual(f(null), null);
});
