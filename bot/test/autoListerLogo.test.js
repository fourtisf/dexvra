// "mengapa bot free listing without logo pdahl tokenya ada logonya … saya ingin
// bot setiap free listing harus ada logonya cari di sumber2 lain".
//
// $W (Wormhole Token, Solana) was free-listed with `wormhole.com/token.png` —
// a url our own image proxy refuses — and went out drawing the Dexvra mark.
// These drive the REAL scan, test scan, listing door and announcement with the
// artwork lookup (services/listingLogo) injected, and assert what reaches the
// site and the channel. A wiring that does nothing refuses beautifully (the
// curveBuyPath scar), so every guarantee is a POSITIVE one where it can be.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-allogo-"));
process.env.ADMIN_BOT_TOKEN = process.env.ADMIN_BOT_TOKEN || "123456:TEST_ADMIN_ALLOGO";

const test = require("node:test");
const assert = require("node:assert");

const al = require("../src/services/autoLister");
const api = require("../src/api/dexvra");
const listingLogo = require("../src/services/listingLogo");

// Read BEFORE the announcement tests stub it — a stub would ADD a missing export.
const REAL_FETCH_X = require("../src/fulfillment").fetchLogoUrlX;
test("the announcement's collaborator exists: fulfillment exports fetchLogoUrlX", () => {
  assert.strictEqual(typeof REAL_FETCH_X, "function");
});

const M = 1_000_000;
const HOUR = 3_600_000;
const now = 1_800_000_000_000;
const OURS = `/api/media/${"b".repeat(24)}.png`;
const WORMHOLE = "https://wormhole.com/token.png";

const healthy = (over = {}) => ({
  name: "Wormhole Token",
  symbol: "W",
  mcap: 1.5 * M,
  liq: 164_000,
  vol24: 1_020_000,
  priceUsd: 0.0237,
  logoUrl: WORMHOLE,
  pairCreatedAt: now - 948 * 24 * HOUR,
  ...over,
});

async function withLogo(v, fn) {
  const prev = process.env.FREE_LISTING_LOGO;
  process.env.FREE_LISTING_LOGO = v;
  try {
    return await fn();
  } finally {
    if (prev == null) delete process.env.FREE_LISTING_LOGO;
    else process.env.FREE_LISTING_LOGO = prev;
  }
}

function harness({ info = healthy, logo } = {}) {
  const created = [];
  const asked = [];
  const real = { c: api.createListing, g: api.getListings, k: api.canCreate };
  api.canCreate = async () => ({ ok: true, status: 400, why: null });
  api.createListing = async (input) => {
    created.push(input);
    return { id: `id${created.length}`, ...input };
  };
  api.getListings = async () => [];
  const deps = {
    fetchDiscovery: async () => [{ chain: "solana", address: "85VBFQZC9TZkfaptBWjvUw7YbZjy52A6mjtPGjstQAmQ" }],
    fetchTokenInfo: async () => info(),
    logoX: async (chain, address, i, opts) => {
      asked.push({ chain, address, logoUrl: i && i.logoUrl, opts: opts || {} });
      return logo;
    },
  };
  return {
    deps,
    created,
    asked,
    restore: () => {
      api.createListing = real.c;
      api.getListings = real.g;
      api.canCreate = real.k;
    },
  };
}

async function fresh() {
  await al.reset();
  await al.resetState();
  return al.set({ enabled: true, minMcap: 1 * M, maxMcap: 1.5 * M, postChannel: false, paceListings: false, maxPerRun: 1 });
}

test("$W: the listing is BORN pointing at our own copy of its artwork, not at the url the proxy refuses", async () => {
  const h = harness({ logo: { ok: true, url: OURS, from: WORMHOLE, source: "discovery", pinned: true } });
  try {
    await fresh();
    await al.runOnce({ deps: h.deps, now, rng: () => 0.5 });
    assert.strictEqual(h.created.length, 1, "the token qualified — it must be listed");
    assert.strictEqual(h.created[0].logoUrl, OURS);
    assert.strictEqual(h.asked.length, 1, "the artwork is asked once, by the scan, and handed to the door");
    assert.notStrictEqual(h.asked[0].opts.pin, false, "the real scan keeps a copy");
  } finally {
    h.restore();
  }
});

test("⚠️ an artwork lookup that could not ASK is not 'no logo' — counted on its own and never cooled", async () => {
  const h = harness({ logo: { ok: false, url: null, why: "geckoterminal: rate limited" } });
  try {
    await fresh();
    await al.runOnce({ deps: h.deps, now, rng: () => 0.5 });
    assert.strictEqual(h.created.length, 0);
    const scan = al.lastScan();
    assert.strictEqual(scan.artUnread, 1);
    assert.ok(Object.keys(scan.artUnreadWhy).some((k) => /geckoterminal/.test(k)));
    assert.ok(!Object.keys(scan.reasons).some((r) => /^no logo/.test(r)), "a source we could not ask must never read as a token with no logo");
    const st = JSON.parse(fss.readFileSync(path.join(process.env.BOT_DATA_DIR, "autoListerState.json"), "utf8"));
    assert.deepStrictEqual(Object.keys(st.cool || {}), [], "no cool-off — the next scan asks again");
    assert.match(al.scanLine(scan), /artwork could not be checked \(geckoterminal: rate limited\)/, "said on the scan line");
  } finally {
    h.restore();
  }
});

test("⚠️ ONE token waiting on GeckoTerminal is NOT a blocked scan — the reported false alarm", async () => {
  // listing:check printed "Free listings cannot go out" over exactly this,
  // directly above section 7 proving /api/logo answers. A 429 from a metered
  // source is this box's ordinary state; the token is asked again next scan.
  const h = harness({ logo: { ok: false, url: null, why: "geckoterminal: rate limited" } });
  try {
    await fresh();
    await al.runOnce({ deps: h.deps, now, rng: () => 0.5 });
    assert.strictEqual(al.lastScan().blocker, null);
  } finally {
    h.restore();
  }
});

test("…but our IMAGE PROXY not answering IS a blocker — then every new listing fails the same way", async () => {
  const h = harness({ logo: { ok: false, url: null, why: "discovery cdn.dexscreener.com: /api/logo did not answer — is the web app up?" } });
  try {
    await fresh();
    await al.runOnce({ deps: h.deps, now, rng: () => 0.5 });
    assert.match(al.lastScan().blocker || "", /could not have their artwork checked/);
  } finally {
    h.restore();
  }
});

test("every source answered and none has artwork → refused as 'no logo' and cooled", async () => {
  const h = harness({ logo: { ok: true, url: null, why: "none of 6 candidate(s) served an image" } });
  try {
    await fresh();
    await al.runOnce({ deps: h.deps, now, rng: () => 0.5 });
    assert.strictEqual(h.created.length, 0);
    const scan = al.lastScan();
    assert.ok(Object.keys(scan.reasons).some((r) => /^no logo/.test(r)), JSON.stringify(scan.reasons));
    assert.strictEqual(scan.blocker, null, "a token with no artwork is the market, not a fault");
    const st = JSON.parse(fss.readFileSync(path.join(process.env.BOT_DATA_DIR, "autoListerState.json"), "utf8"));
    assert.ok(Object.keys(st.cool || {}).length === 1, "a token with no artwork anywhere does not grow one in 25 minutes");
  } finally {
    h.restore();
  }
});

test("⚠️ 'cari di sumber lain': a discovery record with NO logo url reaches the other sources instead of being refused", () =>
  withLogo("1", async () => {
    const h = harness({ info: () => healthy({ logoUrl: null }), logo: { ok: true, url: OURS, source: "coingecko", pinned: true } });
    try {
      await fresh();
      await al.runOnce({ deps: h.deps, now, rng: () => 0.5 });
      assert.strictEqual(h.asked.length, 1, "the lookup must be asked — refusing on the discovery record alone is the old defect");
      assert.strictEqual(h.created.length, 1);
      assert.strictEqual(h.created[0].logoUrl, OURS);
    } finally {
      h.restore();
    }
  }));

test("…and with the lookup switched OFF, the old string gate still refuses a record with no url", () =>
  withLogo("0", async () => {
    const h = harness({ info: () => healthy({ logoUrl: null }), logo: { ok: true, url: OURS, pinned: true } });
    try {
      await fresh();
      await al.runOnce({ deps: h.deps, now, rng: () => 0.5 });
      assert.strictEqual(h.created.length, 0);
      assert.ok(Object.keys(al.lastScan().reasons).some((r) => /^no logo/.test(r)));
    } finally {
      h.restore();
    }
  }));

test("🔎 Test scan asks the same question but keeps NOTHING (pin:false), and reports the verdict", async () => {
  const h = harness({ logo: { ok: true, url: null, why: "none of 3 candidate(s) served an image" } });
  try {
    await fresh();
    const r = await al.dryRun({ now, deps: h.deps });
    assert.strictEqual(h.asked.length, 1);
    assert.strictEqual(h.asked[0].opts.pin, false, "a test scan must never upload");
    assert.strictEqual(r.listed, 0, "a token the real scan would refuse must not be promised");
    assert.ok(Object.keys(r.reasons).some((k) => /^no logo/.test(k)));
    assert.strictEqual(h.created.length, 0);
  } finally {
    h.restore();
  }
});

test("the scan line names an artwork lookup that could not answer", () => {
  const line = al.scanLine({ candidates: 3, priced: 3, listed: 0, reasons: {}, artUnread: 2, artUnreadWhy: { "coingecko: HTTP 429": 2 } });
  assert.match(line, /2 — artwork could not be checked \(coingecko: HTTP 429\)/);
});

test("the listing door asks for artwork ITSELF when no verdict is handed in — the board filler and the seeder carry it too", () =>
  withLogo("1", async () => {
    const real = { c: api.createListing, r: listingLogo.resolveX };
    const created = [];
    api.createListing = async (input) => (created.push(input), { id: "x", ...input });
    listingLogo.resolveX = async () => ({ ok: true, url: OURS, from: WORMHOLE, source: "discovery", pinned: true });
    try {
      await fresh();
      const made = await al.createFromInfo("solana", "So1Door1", healthy(), { now, safetyChecked: { ok: true, refusal: null } });
      assert.ok(made);
      assert.strictEqual(created[0].logoUrl, OURS);

      listingLogo.resolveX = async () => ({ ok: true, url: null, why: "no source has artwork" });
      const none = await al.createFromInfo("solana", "So1Door2", healthy(), { now, safetyChecked: { ok: true, refusal: null } });
      assert.strictEqual(none, null, "no artwork anywhere — not listed through ANY door");
      assert.strictEqual(created.length, 1);
    } finally {
      api.createListing = real.c;
      listingLogo.resolveX = real.r;
    }
  }));

// ── The announcement ─────────────────────────────────────────────────────────

const post = require("../src/channels/post");
const postids = require("../src/channels/postids");
const tokenEmoji = require("../src/tokenEmoji");
const twitter = require("../src/twitter");
const fulfillment = require("../src/fulfillment");
const logoRepair = require("../src/services/logoRepair");

function stubPost(t, { bytes }) {
  const orig = {
    sendMedia: post.sendMedia, mirror: post.mirrorToGroup, ensure: tokenEmoji.ensureTokenEmoji, fromUrl: tokenEmoji.ensureFromUrl,
    enabled: twitter.enabled, postMedia: fulfillment.postMedia, fetchX: fulfillment.fetchLogoUrlX, enqueue: logoRepair.enqueue, set: postids.set,
  };
  const seen = { buffers: [], emoji: 0, fetched: [], repairs: [] };
  let id = 900;
  post.sendMedia = async () => ({ message_id: ++id });
  post.mirrorToGroup = async () => null;
  tokenEmoji.ensureTokenEmoji = async () => (seen.emoji++, null);
  tokenEmoji.ensureFromUrl = async () => null;
  twitter.enabled = () => false;
  fulfillment.fetchLogoUrlX = async (url) => (seen.fetched.push(url), { bytes });
  fulfillment.postMedia = async (kind, coin, buf) => (seen.buffers.push(buf), { type: "photo", source: Buffer.from("x") });
  logoRepair.enqueue = async (job) => (seen.repairs.push(job), true);
  t.after(() => {
    post.sendMedia = orig.sendMedia;
    post.mirrorToGroup = orig.mirror;
    tokenEmoji.ensureTokenEmoji = orig.ensure;
    tokenEmoji.ensureFromUrl = orig.fromUrl;
    twitter.enabled = orig.enabled;
    fulfillment.postMedia = orig.postMedia;
    fulfillment.fetchLogoUrlX = orig.fetchX;
    logoRepair.enqueue = orig.enqueue;
  });
  return seen;
}

test("the announcement reads our copy ONCE and hands the same bytes to the banner and the token emoji", async (t) => {
  const png = Buffer.from("PNGBYTES");
  const seen = stubPost(t, { bytes: png });
  await al.set({ pkg: "trending", trendHours: 12, postChannel: true, announceChannel: true });
  const c = { chain: "solana", address: "So1Ann1" };
  const input = { ...al.listingInput(c.chain, c.address, healthy(), al.get(), now), logoUrl: OURS };
  await al.announce({}, c, healthy(), input, al.get());
  assert.deepStrictEqual(seen.fetched, [OURS], "one read of the file on our disk");
  assert.ok(seen.buffers.length >= 2, "listing card and trending card both rendered");
  assert.ok(seen.buffers.every((b) => b === png), "every banner draws the bytes we read — none fetches its own");
  assert.strictEqual(seen.emoji, 1, "the token emoji is built from those bytes (a relative url cannot be fetched)");
  assert.strictEqual(seen.repairs.length, 0, "a banner that carries its logo needs no repair");
});

test("⚠️ a listing whose logo did not load at post time is QUEUED FOR REPAIR with its posts — never left with the Dexvra mark", async (t) => {
  const seen = stubPost(t, { bytes: null });
  await al.set({ pkg: "trending", trendHours: 12, postChannel: true, announceChannel: true });
  const c = { chain: "solana", address: "So1Ann2" };
  const input = { ...al.listingInput(c.chain, c.address, healthy(), al.get(), now), logoUrl: OURS };
  await al.announce({}, c, healthy(), input, al.get());
  assert.strictEqual(seen.repairs.length, 1);
  const job = seen.repairs[0];
  assert.strictEqual(job.chain, "solana");
  assert.ok(job.urls.includes(OURS));
  assert.ok(job.posts.length >= 2, "the listing card AND the announcement are edited in place");
  for (const p of job.posts) assert.ok(p.caption && p.message_id, "the caption travels — an edit without it wipes the card");
});

test("the visitor-channel report says WHICH logo the listing went out with — and says it loudly when there is none", () => {
  assert.match(al.logoLine({ ok: true, url: OURS, from: WORMHOLE, source: "discovery", pinned: true }), /our own copy — from discovery \(wormhole\.com\)/);
  assert.match(al.logoLine({ ok: true, url: WORMHOLE, off: true }), /unchecked \(FREE_LISTING_LOGO=0\)/);
  assert.match(al.logoLine(null), /^⚠️ Logo: NONE/);
  assert.match(al.logoLine({ ok: true, url: null }), /^⚠️ Logo: NONE/);
});

test("…and the scan hands the artwork verdict to that report", () => {
  const src = fss.readFileSync(path.join(__dirname, "..", "src", "services", "autoLister.js"), "utf8");
  assert.match(src, /reportFreeListing\(c, info, input, pkgKey, \{ today, cap: cfg\.maxPerDay, art \}\)/);
  const fn = src.slice(src.indexOf("function reportFreeListing("), src.indexOf("async function announce("));
  assert.match(fn, /logoLine\(art\)/, "the report must print the line, not merely receive the verdict");
});
