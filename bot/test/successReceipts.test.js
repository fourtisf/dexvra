// Xpress and Listing & Trending are different products, so their receipts are
// separate templates. One shared "Success: listing" meant the tiered buyer was
// never told what the extra money bought — no tier named, no trending hours.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-succ-"));

const test = require("node:test");
const assert = require("node:assert");
const tpl = require("../src/templates");

test("both receipts exist in the editor, under Bot Messages", () => {
  for (const key of ["success_listing", "success_listing_tiered"]) {
    assert.ok(tpl.keys().includes(key), `${key} missing`);
    assert.strictEqual(tpl.meta(key).group, "Bot Messages");
  }
  assert.match(tpl.meta("success_listing").label, /xpress/i, "labelled for the product it belongs to");
  assert.match(tpl.meta("success_listing_tiered").label, /listing & trending/i);
  // The key was kept so an operator's existing override survives the split.
  assert.ok(tpl.meta("success_listing").ph.includes("symbol"));
});

test("the tiered receipt accounts for what the extra money bought", () => {
  const ph = tpl.meta("success_listing_tiered").ph;
  for (const v of ["tier", "tierEmoji", "hours"]) {
    assert.ok(ph.includes(v), `{${v}} must be offered to the editor`);
  }
  const text = tpl.render("success_listing_tiered", {
    symbol: "$CUPSEY", name: "Cupsey", tier: "Diamond", tierEmoji: "💎", hours: 48,
    siteUrl: "https://dexvra.io/t", postLinks: "", announceX: "",
    site: "https://dexvra.io", listing: "https://t.me/l", trending: "https://t.me/t", announce: "https://t.me/a",
  }).text;
  assert.ok(text.includes("Diamond"), text);
  assert.ok(/48\s*hours/.test(text), `the trending run is stated: ${text}`);
  assert.ok(!/\{|\}/.test(text), "no unfilled placeholders");
});

test("the Xpress receipt promises nothing it doesn't deliver", () => {
  const text = tpl.render("success_listing", {
    symbol: "$X", name: "X", siteUrl: "u", postLinks: "", announceX: "",
    site: "s", listing: "l", trending: "t", announce: "a",
  }).text;
  // Xpress has no tier and no trending slot (TIER_TREND_HOURS.XPRESS = 0).
  assert.ok(!/tier badge on every post|hours/i.test(text.split("Want a tier")[0]), text);
  assert.match(text, /Want a tier badge and a Trending run/i, "…and points at the upgrade instead");
});

test("fulfilment picks the receipt from the tier, not from the flow", () => {
  // A tiered order that somehow arrives with tier XPRESS must still get the
  // Xpress receipt — the tier is what the buyer actually received.
  const src = fss.readFileSync(require.resolve("../src/fulfillment.js"), "utf8");
  assert.match(src, /String\(coin\.tier\)\.toUpperCase\(\) !== "XPRESS"/, "the choice is made on the tier");
  assert.match(src, /success_listing_tiered/, "…and both keys are reachable");
  assert.match(src, /successListing\(coin, links, \{ hours \}\)/, "the trending hours reach the receipt");
});
