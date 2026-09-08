// "mengapa mc dan price tba" — and the only detector was a person opening the
// channel.
//
// Everything in `postMarket.test.js` beside this pins the CAUSE that was found
// (a GT-first read queued behind every timer job). This pins the DETECTOR, on
// the reasoning that finally settled the trending board after six rounds: the
// causes keep changing and the symptom does not, so what is watched is the
// promise — a paid announcement publishes its real market figures.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-figures-"));

const test = require("node:test");
const assert = require("node:assert");
const pf = require("../src/postFigures");

const FULL = { priceUsd: 0.001004, mcap: 950200, liq: 131200 };
const args = (over = {}) => ({
  kind: "listing", chain: "bsc", address: "0xabc", sym: "HACHIKO",
  name: "Hachiko Inu", tier: "XPRESS", live: FULL, why: null, ...over,
});

test("missing is measured with the RENDERER's predicate, not a second idea of it", () => {
  // channels/format.js prints TBA for `!(p > 0)` — so 0 and null are holes, and
  // that is what the reader sees whatever we think of the number.
  assert.deepEqual(pf.missingFigures(FULL), []);
  assert.deepEqual(pf.missingFigures({ ...FULL, priceUsd: 0 }), ["price"]);
  assert.deepEqual(pf.missingFigures({ ...FULL, mcap: null }), ["market cap"]);
  assert.deepEqual(pf.missingFigures(null), ["price", "market cap", "liquidity"]);
});

test("a post that published every figure pages NOBODY", () => {
  // A line per healthy order buries the ones that matter — the rule the
  // trending watch and the upstream sweep both had to arrive at.
  assert.equal(pf.figureAlert(args()), null);
});

test("a missing LIQUIDITY alone is not an alert — a curve has no pool depth", () => {
  // launchpads.js returns `liquidityUsd: null` on purpose (a 0 there reads as a
  // rug), so paging on it would be permanently red on every pre-migration
  // listing — the state chart:preview sat in for weeks.
  assert.equal(pf.figureAlert(args({ live: { ...FULL, liq: null } })), null);
});

test("a missing price or market cap IS an alert, and it names every hole", () => {
  const html = pf.figureAlert(args({ live: { ...FULL, priceUsd: null, mcap: null, liq: null } }));
  assert.ok(html, "price + market cap missing must page");
  assert.match(html, /price/);
  assert.match(html, /market cap/);
  // Three holes and one hole are different pictures, so the liquidity is named
  // even though it could never have fired on its own.
  assert.match(html, /liquidity/);
  assert.match(html, /\$HACHIKO/);
  assert.match(html, /0xabc/);
});

test("the three silences get three different sentences", () => {
  // ⚠️ "We could not ask" and "nothing is there" are different facts and only
  // the first is ours — and `fetchMarket` collapses BOTH into one null, which
  // is why the reason has to be captured at the read rather than inferred here.
  const timedOut = pf.figureAlert(args({ live: null, why: "the market read passed 8000ms — the shared GeckoTerminal queue" }));
  const nothing = pf.figureAlert(args({ live: null, why: null }));
  const answered = pf.figureAlert(args({ live: { ...FULL, priceUsd: null, mcap: null }, why: null }));

  assert.match(timedOut, /passed 8000ms/);
  assert.match(nothing, /neither DexScreener nor GeckoTerminal/);
  assert.match(answered, /an indexer answered/);
  // They must not read the same, or the operator is sent to the same place for
  // three different problems.
  assert.notEqual(timedOut, nothing);
  assert.notEqual(nothing, answered);
  assert.notEqual(timedOut, answered);
});

test("the alert names the script that separates the causes ON THE BOX", () => {
  // A diagnosis with no hands attached is a bug report the code files against
  // its owner. Whether an indexer answers this server is a property of its
  // egress today.
  const html = pf.figureAlert(args({ live: null }));
  assert.match(html, /market:check -- bsc/);
});

test("a trending slot is a purchase too", () => {
  const html = pf.figureAlert(args({ kind: "trending", live: null }));
  assert.match(html, /Trending slot/);
});

test("the post is already out, so the watch can never throw", () => {
  // A throw here would turn a degraded announcement into a FAILED ORDER.
  assert.doesNotThrow(() => pf.reportFigures(undefined));
  // The catch is proved by a value that throws while it is being MEASURED —
  // `doesNotThrow` over a healthy argument would pass on a version with no
  // try/catch at all, which is the vacuous half of this assertion.
  assert.equal(pf.reportFigures({ live: { get priceUsd() { throw new Error("boom"); } } }), null);
});

test("markup in a token's own name cannot break the alert", () => {
  // The name and the ticker are whatever the buyer typed, and this is sent with
  // parse_mode HTML — where one stray < makes Telegram reject the WHOLE
  // message with a 400, which is not retried. An alert that vanishes is the
  // silence being fixed.
  const html = pf.figureAlert(args({ live: null, sym: "<b>X", name: "a & <i>b" }));
  assert.ok(!/<b>X/.test(html), "the ticker's own markup must be escaped");
  assert.match(html, /&lt;b&gt;X/);
  assert.match(html, /a &amp; &lt;i&gt;b/);
});

test("BOTH fulfilment paths read through readPostMarket AND report", () => {
  // ⚠️ A rule applied to one of two siblings is a rule half-made — this file's
  // own scar, and the reason the listing and the trending read were merged into
  // one helper in the first place. Comments are stripped: the header above the
  // helper quotes the very call it replaced.
  const src = fss
    .readFileSync(path.join(__dirname, "..", "src", "fulfillment.js"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
  assert.equal((src.match(/readPostMarket\(/g) || []).length, 3, "one definition, two callers");
  assert.equal((src.match(/postFigures\.reportFigures\(/g) || []).length, 2, "listing AND trending");
  // The bounded read is the one owner now; a second inline copy is how the two
  // paths drift apart again.
  assert.equal((src.match(/market\.fetchMarket\(/g) || []).length, 1, "one market read for both posts");
  assert.ok(/POST_MARKET/.test(src), "and it is still the DexScreener-first order");
});
