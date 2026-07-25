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

// A banner sold while the row is full is SCHEDULED, not rejected (see
// src/lib/bannerSchedule.ts on the site). The buyer paid, so the one thing that
// must never regress is that their receipt says plainly that the banner is not
// on screen yet and when it will be — the announcement post goes out
// immediately, which on its own reads as "you're live".
test("a queued banner receipt tells the buyer it is not live yet, and when it starts", () => {
  const fulfil = require("../src/fulfillment");
  const startsAt = Date.UTC(2026, 6, 30, 12, 0, 0);
  const run = { slot: "Wide Banner", startsAt, endsAt: startsAt + 86_400_000 };
  const queued = fulfil._successBanner(run, [], "", true).text;
  assert.ok(/not live yet/i.test(queued), queued);
  // UTC, never GMT and never server-local — the buyer is in another timezone.
  assert.ok(/30 Jul 2026, 12:00 UTC/.test(queued), `start time stated in the note itself: ${queued}`);
  assert.ok(!/GMT/.test(queued), "GMT is not the label Dexvra uses");
  assert.ok(/announcement post/i.test(queued), "explains the post going out now");
  // An immediate booking gets none of that — no phantom "starts later" note.
  const live = fulfil._successBanner(run, [], "", false).text;
  assert.ok(!/not live yet/i.test(live), live);
  assert.ok(live.includes("Wide Banner"), live);
});
