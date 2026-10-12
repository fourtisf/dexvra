// The artwork a free listing is born with — services/listingLogo.
//
// "mengapa bot free listing without logo pdahl tokenya ada logonya … cari di
// sumber2 lain". $W (Wormhole Token, Solana) was listed with
// `https://wormhole.com/token.png`, a url /api/logo refuses by its allowlist,
// and went out drawing the Dexvra mark. Every guarantee below is DRIVEN through
// the module's seams (fetchArt / ladder / upload) — no network.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-llogo-"));

const test = require("node:test");
const assert = require("node:assert");

const ll = require("../src/services/listingLogo");

// ⚠️ Read BEFORE any test stubs it: a stub ADDS a missing export, so a test
// that only ever replaces it passes over a module that never exported it —
// which is exactly how the first cut of this shipped `undefined(...)`.
const REAL_FETCH_ART = require("../src/fulfillment").fetchLogoUrlX;

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 1)]);

/** Run with FREE_LISTING_LOGO set to `v` (the suite turns it off). */
async function withLogo(v, fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, "FREE_LISTING_LOGO");
  const prev = process.env.FREE_LISTING_LOGO;
  if (v === undefined) delete process.env.FREE_LISTING_LOGO;
  else process.env.FREE_LISTING_LOGO = v;
  try {
    return await fn();
  } finally {
    if (had) process.env.FREE_LISTING_LOGO = prev;
    else delete process.env.FREE_LISTING_LOGO;
  }
}

/**
 * Seams. `art[url]` is what fetchLogoUrlX answers for that url (default: the
 * proxy reached it and every gateway 404'd). `ladder` is the tokenLogo answer
 * as {cands:[[source,url]], ok}; the stub runs OUR verifier over the candidates
 * exactly as resolveLogo does.
 */
function seams({ art = {}, ladder = { cands: [], ok: true }, upload } = {}) {
  const calls = { fetched: [], uploaded: [], ladder: 0 };
  const deps = {
    fetchArt: async (url) => {
      calls.fetched.push(url);
      return art[url] || { bytes: null, reached: true, status: 404, why: "cdn: HTTP 404 after 40ms" };
    },
    ladder: async (chain, address, verify) => {
      calls.ladder++;
      for (const [source, url] of ladder.cands) if (await verify(url)) return { ok: true, url, source };
      return { ok: ladder.ok, url: null, blocking: ladder.ok ? [] : ["coingecko: HTTP 429"] };
    },
    upload:
      upload ||
      (async (bytes, name, mime) => {
        calls.uploaded.push({ name, mime, n: bytes.length });
        return `/api/media/${"a".repeat(24)}.png`;
      }),
  };
  return { deps, calls };
}

const proxied = { bytes: PNG, reached: true, status: 200, source: "proxy" };
const guarded = { bytes: PNG, reached: true, status: 200, source: "guarded", ext: "png" };

test("$W: the project's own url, refused by the proxy and read through the guard, is KEPT on our disk", () =>
  withLogo("1", async () => {
    const { deps, calls } = seams({ art: { "https://wormhole.com/token.png": guarded } });
    const r = await ll.resolveX("solana", "85VBFQZC9TZkfaptBWjvUw7YbZjy52A6mjtPGjstQAmQ", { logoUrl: "https://wormhole.com/token.png" }, { deps });
    assert.strictEqual(r.ok, true);
    assert.match(r.url, /^\/api\/media\/[0-9a-f]{24}\.png$/, "the listing must be born pointing at OUR copy");
    assert.strictEqual(r.pinned, true);
    assert.strictEqual(r.from, "https://wormhole.com/token.png");
    assert.strictEqual(calls.uploaded.length, 1);
    assert.strictEqual(calls.ladder, 0, "a url that loads ends the lookup — the other sources are not asked");
  }));

test("a url the proxy serves is kept too — a third party's url is a promise about today only ($GG)", () =>
  withLogo("1", async () => {
    const { deps, calls } = seams({ art: { "https://dd.dexscreener.com/x.png": proxied } });
    const r = await ll.resolveX("solana", "Mint1", { logoUrl: "https://dd.dexscreener.com/x.png" }, { deps });
    assert.strictEqual(r.pinned, true);
    assert.strictEqual(calls.uploaded.length, 1);
  }));

test("⚠️ the discovery url fails → every other source is asked, and the first that RENDERS wins", () =>
  withLogo("1", async () => {
    const { deps, calls } = seams({
      art: { "https://dd.dexscreener.com/w.png": proxied },
      ladder: { cands: [["trustwallet", "https://raw.githubusercontent.com/none.png"], ["dexscreener", "https://dd.dexscreener.com/w.png"]], ok: true },
    });
    const r = await ll.resolveX("solana", "Mint2", { logoUrl: "https://dead.example.com/x.png" }, { deps });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.source, "dexscreener", "the source that answered is named, not 'ladder'");
    assert.strictEqual(r.from, "https://dd.dexscreener.com/w.png");
    assert.ok(r.url.startsWith("/api/media/"));
    assert.deepStrictEqual(calls.fetched, ["https://dead.example.com/x.png", "https://raw.githubusercontent.com/none.png", "https://dd.dexscreener.com/w.png"]);
  }));

test("⚠️ a record with NO logo url is not refused before the others are asked", () =>
  withLogo("1", async () => {
    const { deps } = seams({ art: { "https://assets.coingecko.com/w.png": proxied }, ladder: { cands: [["coingecko", "https://assets.coingecko.com/w.png"]], ok: true } });
    const r = await ll.resolveX("solana", "Mint3", { logoUrl: null }, { deps });
    assert.strictEqual(r.ok, true);
    assert.ok(r.url);
    assert.strictEqual(r.source, "coingecko");
  }));

test("every source ANSWERED and none has artwork → ok:true, url:null — the 'no logo' verdict", () =>
  withLogo("1", async () => {
    const { deps, calls } = seams({ ladder: { cands: [["dexscreener-cdn", "https://dd.dexscreener.com/guess.png"]], ok: true } });
    const r = await ll.resolveX("solana", "Mint4", { logoUrl: "https://x.example.com/404.png" }, { deps });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.url, null);
    assert.match(r.why, /none of 2 candidate/);
    assert.strictEqual(calls.uploaded.length, 0);
  }));

test("⚠️ a source we could not ask is NOT 'no logo' — ok:false, never a verdict", () =>
  withLogo("1", async () => {
    const { deps } = seams({ ladder: { cands: [], ok: false } });
    const r = await ll.resolveX("solana", "Mint5", {}, { deps });
    assert.strictEqual(r.ok, false);
    assert.match(r.why, /coingecko: HTTP 429/);
  }));

test("⚠️ a candidate that failed FLAKILY (proxy down, a 429, no answer) makes the verdict undecided", () =>
  withLogo("1", async () => {
    for (const art of [
      { bytes: null, reached: false, status: 0 }, // /api/logo did not answer
      { bytes: null, reached: true, status: 404, why: "ipfs.io: no answer after 8000ms" },
      { bytes: null, reached: true, status: 404, why: "cdn.example.com: HTTP 429 after 20ms" },
      { bytes: null, reached: true, status: 400, guardedWhy: "x.example.com: no answer after 10000ms", guardedFlaky: true },
    ]) {
      const { deps } = seams({ art: { "https://x.example.com/l.png": art } });
      const r = await ll.resolveX("solana", "Mint6", { logoUrl: "https://x.example.com/l.png" }, { deps });
      assert.strictEqual(r.ok, false, JSON.stringify(art));
    }
  }));

test("🔎 Test scan: pin:false verifies and keeps NOTHING", () =>
  withLogo("1", async () => {
    const { deps, calls } = seams({ art: { "https://wormhole.com/token.png": guarded } });
    const r = await ll.resolveX("solana", "Mint7", { logoUrl: "https://wormhole.com/token.png" }, { pin: false, deps });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.url, "https://wormhole.com/token.png");
    assert.strictEqual(calls.uploaded.length, 0, "a test scan must never write");
  }));

test("a copy we could not keep: a proxy-served url still renders; a guard-only url is no candidate at all", () =>
  withLogo("1", async () => {
    const fail = async () => {
      throw new Error("upload → 415: Only PNG, JPG, WEBP, or GIF images");
    };
    const viaProxy = seams({ art: { "https://dd.dexscreener.com/x.png": proxied }, upload: fail });
    const a = await ll.resolveX("solana", "Mint8", { logoUrl: "https://dd.dexscreener.com/x.png" }, { deps: viaProxy.deps });
    assert.strictEqual(a.url, "https://dd.dexscreener.com/x.png", "it renders through the proxy exactly as before this existed");
    assert.strictEqual(a.pinned, false);

    const onlyUs = seams({
      art: { "https://wormhole.com/token.png": guarded, "https://dd.dexscreener.com/w.png": proxied },
      ladder: { cands: [["dexscreener", "https://dd.dexscreener.com/w.png"]], ok: true },
      upload: fail,
    });
    const b = await ll.resolveX("solana", "Mint9", { logoUrl: "https://wormhole.com/token.png" }, { deps: onlyUs.deps });
    assert.strictEqual(b.url, "https://dd.dexscreener.com/w.png", "the site cannot draw wormhole.com without our copy, so it is not used");
  }));

test("FREE_LISTING_LOGO=0 is the old behaviour exactly — discovery's url, unchecked, no source asked", () =>
  withLogo("0", async () => {
    const { deps, calls } = seams();
    const r = await ll.resolveX("solana", "Mint10", { logoUrl: "https://wormhole.com/token.png" }, { deps });
    assert.deepStrictEqual([r.ok, r.url, r.pinned], [true, "https://wormhole.com/token.png", false]);
    assert.strictEqual(calls.fetched.length + calls.ladder + calls.uploaded.length, 0);
    const none = await ll.resolveX("solana", "Mint10", {}, { deps });
    assert.deepStrictEqual([none.ok, none.url], [true, null]);
  }));

test("the production default — unset or blank — is ON", () =>
  Promise.all([withLogo(undefined, async () => assert.strictEqual(ll.enabled(), true)), withLogo("  ", async () => assert.strictEqual(ll.enabled(), true))]));

// ── healRow — a listing already live with a logo the site cannot draw ──────

test("heal: $W's live row is moved onto our copy through the CAS", () =>
  withLogo("1", async () => {
    const { deps } = seams({ art: { "https://wormhole.com/token.png": guarded } });
    const cas = [];
    const h = await ll.healRow(
      { chain: "solana", address: "85VB", logoUrl: "https://wormhole.com/token.png" },
      { deps, pinLogo: async (a) => (cas.push(a), true) },
    );
    assert.strictEqual(h.state, "healed");
    assert.deepStrictEqual(cas, [{ chain: "solana", address: "85VB", fromUrl: "https://wormhole.com/token.png", toUrl: h.url }]);
  }));

test("heal: a stored url that already renders is left alone — nothing uploaded, nothing written", () =>
  withLogo("1", async () => {
    const { deps, calls } = seams({ art: { "https://dd.dexscreener.com/x.png": proxied } });
    let wrote = false;
    const h = await ll.healRow({ chain: "solana", address: "A", logoUrl: "https://dd.dexscreener.com/x.png" }, { deps, pinLogo: async () => (wrote = true) });
    assert.strictEqual(h.state, "renders");
    assert.strictEqual(calls.uploaded.length, 0);
    assert.strictEqual(wrote, false);
  }));

test("heal: an admin who changed the logo meanwhile wins (the CAS answers false)", () =>
  withLogo("1", async () => {
    const { deps } = seams({ art: { "https://wormhole.com/token.png": guarded } });
    const h = await ll.healRow({ chain: "solana", address: "B", logoUrl: "https://wormhole.com/token.png" }, { deps, pinLogo: async () => false });
    assert.strictEqual(h.state, "kept");
  }));

test("heal: our own upload, a blank and an unreadable source are not touched", () =>
  withLogo("1", async () => {
    const { deps, calls } = seams({ ladder: { cands: [], ok: false } });
    assert.strictEqual((await ll.healRow({ logoUrl: "/api/media/aaaaaaaaaaaaaaaaaaaaaaaa.png" }, { deps })).state, "ours");
    assert.strictEqual((await ll.healRow({ logoUrl: "" }, { deps })).state, "blank");
    assert.strictEqual((await ll.healRow({ chain: "solana", address: "C", logoUrl: "https://dead.example.com/x.png" }, { deps })).state, "undecided");
    assert.strictEqual(calls.uploaded.length, 0);
  }));

test("the default ladder IS tokenLogo.resolveLogo, handed OUR verifier — so 'found a logo' means 'found one we can draw'", async () => {
  const tl = require("../src/services/tokenLogo");
  const orig = tl.resolveLogo;
  let handed = null;
  tl.resolveLogo = async (chain, address, opts) => {
    handed = opts && opts.deps && opts.deps.isImage;
    return { ok: true, url: null };
  };
  try {
    await withLogo("1", () => ll.resolveX("solana", "Mint11", {}, { deps: { fetchArt: async () => ({ bytes: null, reached: true, status: 404 }) } }));
    assert.strictEqual(typeof handed, "function", "resolveLogo must verify with OUR check, not its own raw fetch");
  } finally {
    tl.resolveLogo = orig;
  }
});

test("⚠️ the production collaborator EXISTS — fulfillment exports fetchLogoUrlX, and the default lookup calls it quietly", () =>
  withLogo("1", async () => {
    assert.strictEqual(typeof REAL_FETCH_ART, "function", "listingLogo's default fetchArt reads fulfillment.fetchLogoUrlX");
    const f = require("../src/fulfillment");
    const tl = require("../src/services/tokenLogo");
    const orig = { x: f.fetchLogoUrlX, r: tl.resolveLogo };
    const calls = [];
    f.fetchLogoUrlX = async (url, opts) => (calls.push({ url, opts }), { bytes: null, reached: true, status: 404 });
    tl.resolveLogo = async () => ({ ok: true, url: null });
    try {
      await ll.resolveX("solana", "Mint12", { logoUrl: "https://wormhole.com/token.png" });
      assert.deepStrictEqual(calls, [{ url: "https://wormhole.com/token.png", opts: { quiet: true } }]);
    } finally {
      f.fetchLogoUrlX = orig.x;
      tl.resolveLogo = orig.r;
    }
  }));
