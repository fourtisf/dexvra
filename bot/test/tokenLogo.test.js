// A logo for every listing — "cari sumber logo entah dri dexscrener pumpfun
// atau apalah cri dri banyak sumber dan jika tidak ada logo hapus aja tokenya".
//
// The board was drawing `FL` initials for $FLOKI: the site's monogram
// fallback, which is the right thing to draw and the wrong thing to have to
// draw on a row nobody will ever come and fix.
const test = require("node:test");
const assert = require("node:assert");
const { resolveLogo, cdnGuess, isImage } = require("../src/services/tokenLogo");

const deps = (over = {}) => ({
  dsInfo: async () => null,
  gtInfo: async () => null,
  padInfo: async () => null,
  isImage: async () => true,
  ...over,
});

test("it asks FOUR sources, in order of how much each knows about the token", async () => {
  const order = [];
  const d = deps({
    dsInfo: async () => (order.push("ds"), null),
    gtInfo: async () => (order.push("gt"), null),
    padInfo: async () => (order.push("pad"), null),
  });
  const hit = await resolveLogo("bsc", "0xabc", { deps: d });
  assert.deepStrictEqual(order.sort(), ["ds", "gt", "pad"], "all three indexes are asked");
  // The CDN path is a CONVENTION we construct, so it is the last resort.
  assert.strictEqual(hit.source, "dexscreener-cdn");
  assert.strictEqual(hit.url, cdnGuess("bsc", "0xabc"));
});

test("the project's own upload wins, and a later source is not even fetched", async () => {
  const fetched = [];
  const d = deps({
    dsInfo: async () => ({ logoUrl: "https://ds/a.png" }),
    gtInfo: async () => ({ logoUrl: "https://gt/b.png" }),
    isImage: async (u) => (fetched.push(u), true),
  });
  const hit = await resolveLogo("bsc", "0xabc", { deps: d });
  assert.strictEqual(hit.source, "dexscreener");
  assert.deepStrictEqual(fetched, ["https://ds/a.png"], "a verified hit ends the search");
});

test("the LAUNCHPAD carries artwork before either index does", async () => {
  // pump.fun and friends have a logo from the first minute; DexScreener and
  // GeckoTerminal only have one once somebody submits it.
  const d = deps({ padInfo: async () => ({ logoUrl: "https://pump/c.png" }) });
  const hit = await resolveLogo("solana", "mint", { deps: d });
  assert.strictEqual(hit.source, "launchpad");
});

test("⚠️ every candidate is FETCHED before it is believed", async () => {
  // The CDN path can always be CONSTRUCTED and is very often a 404. Storing one
  // unverified turns "no logo" into "broken image", which is worse — the
  // monogram at least looks deliberate.
  const d = deps({
    dsInfo: async () => ({ logoUrl: "https://ds/dead.png" }),
    isImage: async (u) => u !== "https://ds/dead.png",
  });
  const hit = await resolveLogo("bsc", "0xabc", { deps: d });
  assert.strictEqual(hit.source, "dexscreener-cdn", "a dead url falls through to the next source");
});

test("no source has one → null, never a guess", async () => {
  const d = deps({ isImage: async () => false });
  assert.strictEqual(await resolveLogo("bsc", "0xabc", { deps: d }), null);
});

test("an http url is refused — the site serves https", async () => {
  const d = deps({ dsInfo: async () => ({ logoUrl: "http://insecure/a.png" }), isImage: async () => false });
  assert.strictEqual(await resolveLogo("bsc", "0xabc", { deps: d }), null);
});

test("a source that THROWS costs that source, never the search", async () => {
  const d = deps({
    dsInfo: async () => {
      throw new Error("ENOTFOUND");
    },
    gtInfo: async () => ({ logoUrl: "https://gt/ok.png" }),
  });
  const hit = await resolveLogo("bsc", "0xabc", { deps: d });
  assert.strictEqual(hit.source, "geckoterminal");
});

test("a chain DexScreener does not index still gets the three real sources", async () => {
  assert.strictEqual(cdnGuess("notachain", "0xabc"), null);
  const d = deps({ gtInfo: async () => ({ logoUrl: "https://gt/x.png" }) });
  assert.strictEqual((await resolveLogo("notachain", "0xabc", { deps: d })).source, "geckoterminal");
  const none = deps({ isImage: async () => true });
  assert.strictEqual(await resolveLogo("notachain", "0xabc", { deps: none }), null, "and no CDN guess to fall back on");
});

test("isImage rejects an HTML error page served with a 200", async () => {
  const real = global.fetch;
  try {
    global.fetch = async () => ({ ok: true, status: 200, headers: { get: () => "text/html; charset=utf-8" } });
    assert.strictEqual(await isImage("https://cdn/x.png"), false, "a CDN's miss page is not a logo");
    global.fetch = async () => ({ ok: true, status: 200, headers: { get: () => "image/png" } });
    assert.strictEqual(await isImage("https://cdn/x.png"), true);
    // Some CDNs refuse HEAD while serving the file — treating that as a miss
    // would discard a good logo.
    let n = 0;
    global.fetch = async (u, o) => {
      n++;
      return o.method === "HEAD"
        ? { ok: false, status: 405, headers: { get: () => "" } }
        : { ok: true, status: 200, headers: { get: () => "image/webp" } };
    };
    assert.strictEqual(await isImage("https://cdn/x.png"), true);
    assert.strictEqual(n, 2, "HEAD then GET");
  } finally {
    global.fetch = real;
  }
});

test("a network failure is a miss, never a throw", async () => {
  const real = global.fetch;
  try {
    global.fetch = async () => {
      throw new Error("socket hang up");
    };
    assert.strictEqual(await isImage("https://cdn/x.png"), false);
  } finally {
    global.fetch = real;
  }
});
