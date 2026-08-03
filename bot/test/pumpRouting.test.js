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
  // post burned the token's alert forever, and the bug is invisible in normal
  // operation — it only shows up as an alert that never came. Now that alerts
  // are a ladder the latch is per STEP, but the ordering rule is unchanged.
  const src = fss.readFileSync(require.resolve("../src/services/pumpChecker.js"), "utf8");
  const iPost = src.indexOf("post.sendMedia");
  const iFailGuard = src.indexOf("if (!posted)");
  assert.ok(iPost > -1 && iFailGuard > iPost, "a failed post must skip the latch");

  // There are exactly TWO places a step may be consumed, and they are different
  // in kind, so the test pins each one rather than just counting them:
  //   1. the MIGRATION off the old once-per-token latch, which deliberately
  //      consumes WITHOUT posting (and so sits before the post);
  //   2. the SUCCESS path, which must come after the post AND after the
  //      !posted bail-out — spending it any earlier is the original bug.
  const consumes = [...src.matchAll(/await latch\.addAll\(stepKeys\(key, milestone/g)].map((m) => m.index);
  assert.equal(consumes.length, 2, `expected exactly two consume sites, found ${consumes.length}`);
  const [iMigration, iSuccess] = consumes;
  assert.ok(iMigration < iPost, "the migration consume belongs before the post");
  const iGuard = src.lastIndexOf("if (latch.has(key))", iMigration);
  assert.ok(iGuard > -1 && iGuard < iMigration, "the early consume must be guarded by the legacy-latch check");
  assert.match(
    src.slice(Math.max(0, iGuard - 700), iMigration),
    /MIGRATION|pre-ladder|absorb/i,
    "the early consume must be the documented migration, not a stray latch",
  );
  assert.ok(iSuccess > iFailGuard, "the latch must be spent AFTER the post, not before it");
});

test("an announce-only token latches after posting — it must not re-fire forever", () => {
  // `posted` used to be assigned ONLY for CHANNELS.listing. A token with an
  // @dexvraio announcement but no listing-channel post (its listing post failed,
  // or an admin force-posted just the announcement) therefore posted to
  // @dexvraio successfully, left `posted` null, skipped the latch, and alerted
  // again on EVERY poll — and once the tweet moved ahead of the post, it tweeted
  // again every poll too. The fix is that ANY target counts as posted.
  const src = fss.readFileSync(require.resolve("../src/services/pumpChecker.js"), "utf8");
  const loop = src.slice(src.indexOf("for (const t of targets)"), src.indexOf("if (!posted)"));
  assert.ok(
    !/t\.channel === CHANNELS\.listing/.test(loop),
    `"did it post?" must not be scoped to one channel:\n${loop}`,
  );
  assert.match(loop, /if \(msg\) posted = posted \|\| msg/, "any successful target must count as posted");
});

test("the pump tweet is fired BEFORE the card is built, so the card can link it", () => {
  // post_pump carries an "Announce On X" line that reads coin.xUrl. A tweet
  // fired after fmt.pumpPost() can never reach it — the line silently strips
  // itself and the alert loses its X link, with nothing in the logs.
  const src = fss.readFileSync(require.resolve("../src/services/pumpChecker.js"), "utf8");
  const iTweet = src.indexOf("x.postPump");
  const iXUrl = src.indexOf("coin.xUrl =");
  const iCard = src.indexOf("fmt.pumpPost");
  assert.ok(iTweet > -1 && iXUrl > -1 && iCard > -1, "all three steps present");
  assert.ok(iTweet < iXUrl && iXUrl < iCard, "order must be: tweet → set xUrl → build card");
});
