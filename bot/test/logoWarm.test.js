// "bot gagal proses logo mukan logo ke announce … pdhl tokenya punya logo" —
// `$DLYN` (DUALYNE, Pons v2, Robinhood) went out as an Xpress Listing to 12,436
// subscribers drawing the DEXVRA MARK, while ponsfamily.com rendered the
// project's own `>_` artwork in the same minute.
//
// The url was known MINUTES before the post: the review card shows it. Nothing
// asked for the bytes until after payment, on a fresh IPFS CID no public
// gateway had cached yet — so whether a cold DHT walk finished inside the
// proxy's budget decided the artwork of a paid post. `warmLogo` fetches while
// the buyer reads the review card; the post reads the bytes back.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-logowarm-"));

const test = require("node:test");
const assert = require("node:assert");
const fulfil = require("../src/fulfillment");

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const LOGO = "https://ipfs.io/ipfs/bafkreidualynelogoexample";

function stubFetch(answer) {
  const orig = global.fetch;
  const asked = [];
  global.fetch = async (url) => {
    asked.push(String(url));
    return answer(String(url), asked.length);
  };
  return { asked, restore: () => (global.fetch = orig) };
}
const img = () => ({ ok: true, status: 200, headers: { get: () => null }, arrayBuffer: async () => PNG.buffer.slice(PNG.byteOffset, PNG.byteOffset + PNG.length) });
const miss = () => ({ ok: false, status: 404, headers: { get: (k) => (k === "x-logo-why" ? "ipfs.io: no answer after 12000ms" : null) }, arrayBuffer: async () => new ArrayBuffer(0) });
const tick = () => new Promise((r) => setImmediate(r));

test("⚠️ THE POSITIVE TEST: bytes warmed at the review card are what the post draws — even if the gateway is cold again at post time", async () => {
  fulfil._resetWarm();
  const { asked, restore } = stubFetch((u, n) => (n === 1 ? img() : miss()));
  try {
    assert.strictEqual(fulfil.warmLogo(LOGO), true);
    for (let i = 0; i < 5; i++) await tick();
    const r = await fulfil._fetchLogoUrlWarm(LOGO);
    assert.ok(r.bytes && r.bytes.length, "the post must get the bytes the review card already fetched");
    assert.strictEqual(asked.length, 1, `the post asked the gateway again: ${asked.join(", ")}`);
    assert.ok(asked[0].includes("/api/logo?u="), "the warm goes through the site's proxy like every other logo fetch");
  } finally {
    restore();
  }
});

test("a post that arrives while the warm is still in flight JOINS it — one request, not two against a cold gateway", async () => {
  fulfil._resetWarm();
  let release;
  const gate = new Promise((r) => (release = r));
  const { asked, restore } = stubFetch(async () => {
    await gate;
    return img();
  });
  try {
    fulfil.warmLogo(LOGO);
    const p = fulfil._fetchLogoUrlWarm(LOGO);
    release();
    const r = await p;
    assert.ok(r.bytes && r.bytes.length);
    assert.strictEqual(asked.length, 1);
  } finally {
    restore();
  }
});

test("a warm that FAILED is not a verdict — the post fetches fresh, and gets the artwork if it is there now", async () => {
  fulfil._resetWarm();
  const { asked, restore } = stubFetch((u, n) => (n === 1 ? miss() : img()));
  try {
    fulfil.warmLogo(LOGO);
    for (let i = 0; i < 5; i++) await tick();
    const r = await fulfil._fetchLogoUrlWarm(LOGO);
    assert.ok(r.bytes && r.bytes.length, "a cold first try must not be cached as 'no artwork'");
    assert.strictEqual(asked.length, 2);
    // …and the failed entry is FORGOTTEN, or it reads as "in flight" for ever
    // and no later review render can warm this logo again.
    fulfil._resetWarm();
    const again = stubFetch((u, n) => (n === 1 ? miss() : img()));
    try {
      fulfil.warmLogo(LOGO);
      for (let i = 0; i < 5; i++) await tick();
      assert.strictEqual(fulfil.warmLogo(LOGO), true, "a failed warm blocked the next one");
    } finally {
      again.restore();
    }
  } finally {
    restore();
  }
});

test("warming is idempotent while in flight or warm, and skips our own uploads", async () => {
  fulfil._resetWarm();
  const { asked, restore } = stubFetch(() => img());
  try {
    assert.strictEqual(fulfil.warmLogo(LOGO), true);
    assert.strictEqual(fulfil.warmLogo(LOGO), false, "a second review render must not refetch");
    for (let i = 0; i < 5; i++) await tick();
    assert.strictEqual(fulfil.warmLogo(LOGO), false, "…nor once it is warm");
    assert.strictEqual(fulfil.warmLogo("/api/media/0123456789abcdef01234567.png"), false, "an upload is already on this disk");
    assert.strictEqual(fulfil.warmLogo(""), false);
    assert.strictEqual(fulfil.warmLogo(null), false);
    assert.strictEqual(asked.length, 1);
  } finally {
    restore();
  }
});

test("the warm cache is BOUNDED — a paste nobody pays for cannot grow it without end", async () => {
  fulfil._resetWarm();
  const { asked, restore } = stubFetch(() => img());
  try {
    for (let i = 0; i < 40; i++) fulfil.warmLogo(`https://ipfs.io/ipfs/bafkreiexample${i}`);
    for (let i = 0; i < 5; i++) await tick();
    // The oldest were evicted: asking for one of them fetches again.
    const before = asked.length;
    await fulfil._fetchLogoUrlWarm("https://ipfs.io/ipfs/bafkreiexample0");
    assert.strictEqual(asked.length, before + 1, "the oldest entry must have been evicted");
    await fulfil._fetchLogoUrlWarm("https://ipfs.io/ipfs/bafkreiexample39");
    assert.strictEqual(asked.length, before + 1, "the newest is still warm");
  } finally {
    restore();
  }
});

// ── the wiring — both ends, comment-stripped ────────────────────────────────
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const read = (p) => strip(fss.readFileSync(path.join(__dirname, "..", p), "utf8"));

test("⚠️ the review card WARMS the artwork, and both paid posts READ the warm copy", () => {
  const listing = read("src/handlers/listing.js");
  const review = listing.slice(listing.indexOf("async function showReview"), listing.indexOf("async function editField"));
  assert.match(review, /require\("\.\.\/fulfillment"\)\.warmLogo\(f\.logoUrl\)/, "the review card must start the fetch");
  assert.match(review, /if \(!f\.logoFileId && f\.logoUrl\)/, "…only for an external url — an upload needs no warming");
  const ful = read("src/fulfillment.js");
  const listingPost = ful.slice(ful.indexOf("async function fulfillListing"), ful.indexOf("async function fulfillTrending"));
  // Through readArtwork now (a second pass, a second url — logoRepair.test.js),
  // and readArtwork's FIRST pass is the warm read. Both halves are pinned.
  assert.match(listingPost, /logoFetch = await readArtwork\(\[input\.logoUrl/, "the listing post must read the warm copy");
  const ra = ful.slice(ful.indexOf("async function readArtwork("), ful.indexOf("async function pinLogo("));
  assert.match(ra, /pass === 0 \? fetchLogoUrlWarm\(url\)/, "readArtwork's first pass is the warm read");
  assert.doesNotMatch(listingPost, /await fetchLogoUrlX\(/, "…and not go around it");
  const trending = ful.slice(ful.indexOf("async function fulfillTrending"), ful.indexOf("async function fulfillBanner"));
  assert.match(trending, /await readArtwork\(\[logoUrl/, "the trending sibling too — a fix on one of two siblings is half a fix");
});
