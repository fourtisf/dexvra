// Every listing banner wears its package's pill — a FREE auto listing as
// "Xpress Listing" (how the site shows it), a paid tier as "<Label> Tier" —
// through ONE owner (packages.js `listingBadge`), so the paid path, the
// auto-lister and an admin force-post cannot word it three ways.
// "free listing juga harus ada badge nya … intinya harus ada".
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = process.env.BOT_DATA_DIR || fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-badge-"));

const test = require("node:test");
const assert = require("node:assert");

const { listingBadge, publicTier, LISTING_TIERS } = require("../src/config/packages");

// forcePost destructures postMedia at require time, so the spy goes in first
const fulfillment = require("../src/fulfillment");
const badges = [];
fulfillment.postMedia = async (kind, coin, buf, fileId, url, badge) => {
  badges.push({ kind, badge });
  return { type: "photo", source: Buffer.from("x") };
};
fulfillment.readPostMarket = async () => ({ live: null });
const api = require("../src/api/dexvra");
const post = require("../src/channels/post");
post.sendMedia = async () => ({ message_id: 1 });
const forcePost = require("../src/admin/forcePost");

test("every tier has a pill, and FREE reads as Xpress", () => {
  for (const t of [undefined, null, "", "FREE", "free", "XPRESS"]) {
    assert.strictEqual(listingBadge(t), "Xpress Listing", `tier ${JSON.stringify(t)} drew no Xpress pill`);
    assert.strictEqual(publicTier(t), "XPRESS");
  }
  for (const t of LISTING_TIERS.filter((x) => x.key !== "XPRESS")) {
    assert.strictEqual(listingBadge(t.key), `${t.label} Tier`);
    assert.strictEqual(publicTier(t.key), t.key);
  }
});

test("the paid path and the auto-lister read the one owner, never a copy of it", () => {
  const strip = (f) => fss.readFileSync(path.join(__dirname, "..", f), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
  for (const f of ["src/fulfillment.js", "src/services/autoLister.js", "src/admin/forcePost.js"]) {
    const src = strip(f);
    assert.match(src, /listingBadge\(/, `${f} does not read listingBadge`);
    assert.doesNotMatch(src, /"Xpress Listing"\s*:/, `${f} spells the badge itself again`);
  }
});

test("an admin force-post of a listing wears the same pill a real one does", async () => {
  const realList = api.getListings;
  api.getListings = async () => [{ status: "approved", name: "Gold Coin", sym: "GLD", chain: "solana", address: "So1BadgeGold111111111111111111111111111111", tier: "GOLD" }];
  try {
    badges.length = 0;
    await forcePost.forcePost("listing");
    assert.deepStrictEqual(badges.filter((b) => b.kind === "listing").map((b) => b.badge), ["Xpress Listing"]);
    badges.length = 0;
    await forcePost.forcePost("listing_trending");
    assert.deepStrictEqual(badges.filter((b) => b.kind === "listing").map((b) => b.badge), ["Gold Tier"]);
    // a trending banner carries its own pill, never a listing's
    assert.ok(badges.filter((b) => b.kind === "trending").every((b) => b.badge === null));
  } finally {
    api.getListings = realList;
  }
});
