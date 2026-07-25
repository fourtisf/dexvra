// Where a pump alert may appear, and when the once-per-token latch is spent.
//
// The rule is a BUSINESS rule: a token only gets a pump alert in a channel where
// it has a listing post to reply to. An Xpress buyer gets no @dexvraio
// announcement, so an Xpress token must never produce a pump alert there —
// posting one stand-alone would advertise a token that channel never listed.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-pump-"));

const test = require("node:test");
const assert = require("node:assert");
const { pumpTargets } = require("../src/services/pumpChecker");
const { CHANNELS } = require("../src/config/constants");

test("Xpress listing: the listing channel only", () => {
  const t = pumpTargets({ listingMsgId: 42 });
  assert.deepStrictEqual(t, [{ channel: CHANNELS.listing, replyTo: 42 }]);
});

test("Listing & Trending: both channels, each replying to ITS OWN post", () => {
  const t = pumpTargets({ listingMsgId: 42, annMsgId: 7 });
  assert.deepStrictEqual(t, [
    { channel: CHANNELS.listing, replyTo: 42 },
    { channel: CHANNELS.announce, replyTo: 7 },
  ]);
  assert.notStrictEqual(t[0].replyTo, t[1].replyTo, "a message id is per-channel — never reused across them");
});

test("no listing post anywhere → no alert at all (never stand-alone)", () => {
  assert.deepStrictEqual(pumpTargets({}), []);
  assert.deepStrictEqual(pumpTargets(), []);
  assert.deepStrictEqual(pumpTargets({ listingTweetId: "123" }), [], "a tweet id is not a reply target");
});

test("an announcement post without a listing post still can't post stand-alone", () => {
  // Shouldn't happen, but if it does the announcement reply is legitimate and
  // the listing channel gets nothing — rather than a loose post in both.
  assert.deepStrictEqual(pumpTargets({ annMsgId: 9 }), [{ channel: CHANNELS.announce, replyTo: 9 }]);
});

test("the latch is spent only after the alert posts", () => {
  // Guarding this at the source level: latching at DETECTION time meant a failed
  // post burned the token's one alert forever, and the bug is invisible in
  // normal operation — it only shows up as an alert that never came.
  const src = fss.readFileSync(require.resolve("../src/services/pumpChecker.js"), "utf8");
  const iPost = src.indexOf("post.sendMedia");
  const iLatch = src.indexOf("await latch.add(key)");
  assert.ok(iPost > -1 && iLatch > -1, "both steps present");
  assert.ok(iPost < iLatch, "latch.add must come AFTER the post, not before it");
  assert.match(src, /if \(!posted\)/, "a failed post must skip the latch");
});
