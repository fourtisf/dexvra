// listingWatch.diagnose — the sentence the quiet-feed page and ⚡ Run now
// print. "bagaimana agar masalah ini tidak terjadi lgi": a token that cleared
// every gate and was held back because its ARTWORK could not be checked is a
// fault of ours, not the market — and "lower 🎯" is the wrong advice for it.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-lwatch-"));

const test = require("node:test");
const assert = require("node:assert");
const watch = require("../src/services/listingWatch");


test("art_unread: tokens that QUALIFIED and were held back by their artwork are named — never 'lower 🎯'", () => {
  const scan = { candidates: 20, priced: 15, listed: 0, reasons: { "low 24h volume": 6 }, artUnread: 1, artUnreadWhy: { "geckoterminal: rate limited": 1 } };
  const d = watch.diagnose(scan);
  assert.strictEqual(d.code, "art_unread");
  assert.strictEqual(d.fault, true);
  assert.match(d.text, /held back because their artwork could not be checked/);
  assert.match(d.text, /GECKOTERMINAL_API_KEY/);
  assert.doesNotMatch(d.text, /lower 🎯/);
});

test("…and a scan that LISTED something is not held back, whatever else it says", () => {
  const d = watch.diagnose({ candidates: 5, priced: 5, listed: 1, reasons: { "low 24h volume": 2 }, artUnread: 1, artUnreadWhy: { "geckoterminal: rate limited": 1 } });
  assert.notStrictEqual(d.code, "art_unread");
});

test("a source other than GeckoTerminal sends the reader to the check, not to a key", () => {
  const d = watch.diagnose({ candidates: 5, priced: 5, listed: 0, reasons: {}, artUnread: 2, artUnreadWhy: { "coingecko: HTTP 429": 2 } });
  assert.strictEqual(d.code, "art_unread");
  assert.match(d.text, /listing:check/);
  assert.doesNotMatch(d.text, /GECKOTERMINAL_API_KEY/);
});
