const test = require("node:test");
const assert = require("node:assert");
const br = require("../src/bannerRender");

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // \x89PNG

// The renderer is best-effort: if @napi-rs/canvas isn't installed on the host,
// every function must return null (caller falls back) rather than throw.
const has = br.available();

test("banner renderer exposes the expected API", () => {
  for (const fn of [
    "renderListingBanner",
    "renderTrendingBanner",
    "renderMainBanner",
    "renderStaticListing",
    "renderStaticTrending",
    "available",
  ]) {
    assert.strictEqual(typeof br[fn], "function", `missing ${fn}`);
  }
});

test("dynamic listing/trending banners are PNG buffers (or null without canvas)", async () => {
  const coin = {
    symbol: "JIM",
    name: "Jimothy Protocol",
    chain: "ETHEREUM",
    price: "$0.0421",
    mcap: "$4.2M",
    links: { website: "https://x", twitter: "https://x", telegram: "https://x" },
  };
  for (const buf of [
    await br.renderListingBanner(coin, null),
    await br.renderTrendingBanner(coin, null),
  ]) {
    if (!has) {
      assert.strictEqual(buf, null);
    } else {
      assert.ok(Buffer.isBuffer(buf) && buf.length > 1000);
      assert.ok(buf.subarray(0, 4).equals(PNG_MAGIC), "not a PNG");
    }
  }
});

test("renderer never throws on missing/garbage fields", async () => {
  await assert.doesNotReject(async () => {
    await br.renderListingBanner({}, null); // no symbol/name/links/price
    await br.renderTrendingBanner({ symbol: null, links: null }, Buffer.from([1, 2, 3])); // bad logo buffer
    await br.renderMainBanner();
  });
});
