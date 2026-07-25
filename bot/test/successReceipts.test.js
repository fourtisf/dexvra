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
  assert.ok(/48h/.test(text), `the trending run is stated: ${text}`);
  assert.ok(!/\{|\}/.test(text), "no unfilled placeholders");
});

test("the receipt lists every post that went out, as raw labelled links", () => {
  // The reference shape the operator asked for: congrats line, the token page as
  // a BARE url, then one labelled raw link per destination. A markdown link
  // hides the url, and a buyer forwards these as proof of delivery.
  const links = [
    "🔔 Dexvra Listing: https://t.me/dexvralisting/8733",
    "🔔 Dexvra Listing (X): https://x.com/dexvralisting/status/207487",
    "🔔 Dexvra Announcement: https://t.me/dexvraio/11993",
    "🔔 Dexvra Trending: https://t.me/dexvratrending/9106",
  ].join("\n");
  const text = tpl.render("success_listing_tiered", {
    symbol: "$CASHCAT", name: "Cash Cat", tier: "Diamond", tierEmoji: "💎", hours: 48,
    siteUrl: "https://dexvra.io/token/robinhood/0x020b", postLinks: links, announceX: "",
    site: "s", listing: "l", trending: "t", announce: "a",
  }).text;
  for (const l of links.split("\n")) assert.ok(text.includes(l), `missing: ${l}`);
  assert.ok(text.includes("https://dexvra.io/token/robinhood/0x020b"), "the token page is a bare url");
  assert.ok(!/\]\(/.test(text), "no markdown links — the urls are visible");
  assert.ok(!/dexvra\.io\s*\|/.test(text), "no footer row: the links above already reach every channel");
  assert.ok(!/\n\s*$/.test(text), "no trailing blank line when there is no extra X line");
});

test("the tweet sits under its own channel post, and only once", () => {
  const src = fss.readFileSync(require.resolve("../src/fulfillment.js"), "utf8");
  const iListing = src.indexOf('label: "🔔 Dexvra Listing"');
  const iX = src.indexOf('label: "🔔 Dexvra Listing (X)"');
  const iAnn = src.indexOf('label: "🔔 Dexvra Announcement"');
  assert.ok(iListing > -1 && iX > iListing && iAnn > iX, "order: listing → X → announcement");
  assert.match(src, /announceX: "", \/\/ already inside postLinks/, "…so {announceX} must not repeat it");
});

test("the Xpress receipt promises nothing it doesn't deliver", () => {
  const text = tpl.render("success_listing", {
    symbol: "$X", name: "X", siteUrl: "u", postLinks: "", announceX: "",
    site: "s", listing: "l", trending: "t", announce: "a",
  }).text;
  // Xpress has no tier and no trending slot (TIER_TREND_HOURS.XPRESS = 0), so
  // the receipt must not mention either.
  assert.ok(!/tier/i.test(text), text);
  assert.ok(!/trending for/i.test(text), text);
  assert.match(text, /officially listed/i);
});

test("fulfilment picks the receipt from the tier, not from the flow", () => {
  // A tiered order that somehow arrives with tier XPRESS must still get the
  // Xpress receipt — the tier is what the buyer actually received.
  const src = fss.readFileSync(require.resolve("../src/fulfillment.js"), "utf8");
  assert.match(src, /String\(coin\.tier\)\.toUpperCase\(\) !== "XPRESS"/, "the choice is made on the tier");
  assert.match(src, /success_listing_tiered/, "…and both keys are reachable");
  assert.match(src, /successListing\(coin, links, \{ hours \}\)/, "the trending hours reach the receipt");
});
