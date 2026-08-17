// How a token is IDENTIFIED on the gainers board: the size of its name, and the
// X handle it is credited with.
//
// Two things reported against a live Top 3, 2026-08-17, both by comparison with
// FourtisRaid's board:
//
//   1. "font projectnya nomor1 terlalu gede tidak sesuai dengan project lain"
//      — $巨兽BEHEMOTH was drawn at 44px against 31px for the two beside it.
//   2. "teks copy writing harusnya ada x nya … ketika d klik itu ke link x"
//      — the caption read "#巨兽BEHEMOTH +4336%" with nothing to click, on a
//      token whose socials the bot already had on file.
const test = require("node:test");
const assert = require("node:assert");
const fss = require("node:fs");
const path = require("node:path");
const os = require("node:os");

process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-gid-"));

const gainers = require("../src/gainers");
const { xHandle, enrichHandles } = gainers._internals;
const api = require("../src/api/dexvra");
const BANNER = fss.readFileSync(path.join(__dirname, "..", "src", "gainersBanner.js"), "utf8");
const GSRC = fss.readFileSync(path.join(__dirname, "..", "src", "gainers.js"), "utf8");

// ── the winner's name is not a ranking signal ───────────────────────────────

test("all three podium tickers are ONE size; only the figure scales", () => {
  // The comment defending the scale-up says "≥1.4× on the FIGURE", and the code
  // applied it to the ticker as well. All three columns are the same width —
  // colW is a single value — so a bigger name buys no legibility and costs the
  // card set its typographic consistency.
  assert.match(BANNER, /const tickSize = 31;/);
  assert.ok(!/const tickSize = winner \?/.test(BANNER), "the winner's name is scaled again");
  // The figure MUST still outrank the sides, or the podium is carried only by
  // elevation — that part of the original reasoning stands.
  assert.match(BANNER, /const pctSize = winner \? 68 : 44;/);
  assert.ok(68 / 44 >= 1.4, "the winner's figure no longer outranks the sides");
});

test("rank is still carried — six ways, none of them the name", () => {
  const fn = BANNER.slice(BANNER.indexOf("function layoutPodium("), BANNER.indexOf("podium: layoutPodium"));
  for (const [what, re] of [
    ["elevation", /const h = winner \? BAND_H \* S/],
    ["the top-gainer chip", /"#1 · Top gainer"/],
    ["the metal ring", /metalRing\(ctx, cx, lcy, d, rank, S\)/],
    ["the medal", /medal\(ctx, cx \+ d \* 0\.42/],
    ["a larger avatar", /const d = \(winner \? 108 : 96\) \* S;/],
    ["the figure", /pctSize = winner \?/],
  ]) {
    assert.match(fn, re, `${what} is gone — the podium now leans on fewer signals`);
  }
});

test("the podium still renders, and the long name still fits", async () => {
  const gb = require("../src/gainersBanner");
  if (!gb.available()) return;
  const coins = [
    { symbol: "巨兽BEHEMOTH", name: "巨兽 Behemoth", pct: 4336, pctLabel: "▲ 4336%", chain: "bsc", mcap: 1_930_000, address: "0x1" },
    { symbol: "牛来", name: "牛来", pct: 109, pctLabel: "▲ 109%", chain: "bsc", mcap: 39_100_000, address: "0x2" },
    { symbol: "WALL", name: "TheCardWall", pct: 26.2, pctLabel: "▲ 26.2%", chain: "robinhood", mcap: 3_190_000, address: "0x3" },
  ];
  const buf = await gb.render({ template: "podium", coins, dateText: "Monday · August 17 · 2026" });
  assert.ok(buf && buf.length > 10_000, "the podium stopped rendering");
  // fitText only shrinks for WIDTH, and the longest of these is the winner's —
  // so a uniform size must still leave it inside its column.
  assert.match(BANNER, /fitText\(ctx, `\$\$\{c\.symbol\}`, colW - 56 \* S/);
});

// ── the X handle ────────────────────────────────────────────────────────────

test("a BARE handle is a handle — the listing form takes free text", () => {
  // A project that typed "@velvet_capital" rather than the full URL had its X
  // dropped, and reached the leaderboard with no attribution at all.
  for (const [input, want] of [
    ["https://x.com/velvet_capital", "velvet_capital"],
    ["https://twitter.com/foo", "foo"],
    ["@velvet_capital", "velvet_capital"],
    ["velvet_capital", "velvet_capital"],
    ["@a_b_1", "a_b_1"],
  ]) {
    assert.strictEqual(xHandle(input), want, `${input} → ${xHandle(input)}`);
  }
});

test("and the words a form collects instead of a blank are not handles", () => {
  // Widening the parser must not turn "TBA" into an @mention on a public post.
  for (const bad of ["", "  ", "-", "none", "None", "n/a", "TBA", "soon", "null",
    "x.com/i/status/123", "https://x.com/home", "https://x.com/intent/tweet", "way too long a handle to be real 12345"]) {
    assert.strictEqual(xHandle(bad), null, `${JSON.stringify(bad)} → ${xHandle(bad)}`);
  }
});

test("the board's missing handle is filled from the listing store", async () => {
  // boardCoin reads t.links.twitter (the website's row); listingCoins reads
  // row.twitter (what the project typed). They are not equivalent, and the board
  // is preferred — so a token the site has no link for lost its credit.
  const real = api.getListings;
  api.getListings = async () => [
    { chain: "bsc", address: "0xAAA", twitter: "https://x.com/behemoth_bsc" },
    { chain: "bsc", address: "0xBBB", twitter: "@niulai" },
    { chain: "robinhood", address: "0xCCC", twitter: "none" },
  ];
  try {
    const coins = [
      { chain: "bsc", address: "0xaaa", x: null, links: {} },
      { chain: "bsc", address: "0xBBB", x: null, links: {} },
      { chain: "robinhood", address: "0xccc", x: null, links: {} },
      { chain: "solana", address: "So1", x: "pateonsol_", links: { twitter: "https://x.com/pateonsol_" } },
    ];
    await enrichHandles(coins);
    // Case-insensitive on the address, both directions.
    assert.strictEqual(coins[0].x, "behemoth_bsc");
    assert.strictEqual(coins[1].x, "niulai", "a bare handle in the store was not accepted");
    assert.strictEqual(coins[2].x, null, '"none" became an @mention');
    // NEVER overrides what the board asserted.
    assert.strictEqual(coins[3].x, "pateonsol_");
    // The link is carried too, so anything reading links.twitter agrees with it.
    assert.strictEqual(coins[0].links.twitter, "https://x.com/behemoth_bsc");
  } finally {
    api.getListings = real;
  }
});

test("it costs nothing when there is nothing to fill", async () => {
  let calls = 0;
  const real = api.getListings;
  api.getListings = async () => { calls++; return []; };
  try {
    await enrichHandles([{ chain: "bsc", address: "0x1", x: "already" }]);
    assert.strictEqual(calls, 0, "the listings API is called even when every coin has a handle");
  } finally {
    api.getListings = real;
  }
});

test("a failing lookup loses the handle, never the banner", async () => {
  const real = api.getListings;
  api.getListings = async () => { throw new Error("internal API down"); };
  try {
    const coins = [{ chain: "bsc", address: "0x1", x: null }];
    await assert.doesNotReject(enrichHandles(coins));
    assert.strictEqual(coins[0].x, null);
  } finally {
    api.getListings = real;
  }
});

test("it runs on the RANKED list, not the whole pool", () => {
  // Ten lookups at most, and only after the filters have cut the board down.
  const fn = GSRC.slice(GSRC.indexOf("async function topGainers("), GSRC.indexOf("// ── slot override"));
  const iEnrich = fn.indexOf("await enrichHandles(coins)");
  assert.ok(iEnrich > -1, "topGainers never enriches");
  assert.ok(iEnrich > fn.indexOf("coins = rank("), "the enrich runs before the ranking cuts the pool down");
  assert.ok(iEnrich < fn.indexOf("await loadLogos(coins)"), "logos load before the handles are known");
});

// ── the caption's link ──────────────────────────────────────────────────────

test("the handle is a LINK to x.com, not a bare @mention", () => {
  // A bare "@handle" in a Telegram message is a TELEGRAM username: tapping it
  // opens Telegram's user search, not X. It has to be an explicit link.
  assert.match(GSRC, /\[@\$\{premium\.sanitizeVar\(c\.x\)\}\]\(https:\/\/x\.com\/\$\{premium\.sanitizeVar\(c\.x\)\}\)/);
  // …and the sanitiser must not break the URL. Handles are [A-Za-z0-9_], and an
  // underscore is a markdown italic marker — "@pateonsol_" would 404 if it were
  // escaped into the href.
  const premium = require("../src/premium");
  assert.strictEqual(premium.sanitizeVar("pateonsol_"), "pateonsol_");
  assert.strictEqual(premium.sanitizeVar("a_b_1"), "a_b_1");
});

test("the tweet text uses a plain mention — X has no link labels", () => {
  // listText is what gets published to X, where "[@x](url)" would print its
  // brackets verbatim.
  const fn = GSRC.slice(GSRC.indexOf("function listText("), GSRC.indexOf("/** One-line summary"));
  assert.match(fn, /if \(c\.x\) line \+= ` @\$\{c\.x\}`;/);
  assert.ok(!/https:\/\/x\.com/.test(fn), "the tweet embeds a link label X cannot render");
});

// ── "masih sama aja" — the report that turns a shrug into an answer ──────────
//
// The caption came back with no @handles after the fallback shipped, and the only
// thing anyone could say was "it did not work". Three tokens with no X on file, a
// listing lookup that failed, and a chain key that did not match all look
// IDENTICAL from Telegram — and the first cut swallowed the difference in a
// log.debug nobody prints.

test("enrichHandles reports which of the three it was", async () => {
  const real = api.getListings;
  api.getListings = async () => [
    { chain: "bsc", address: "0xAAA", twitter: "https://x.com/filled_ok" },
    { chain: "bsc", address: "0xBBB", twitter: "" },            // listed, no X
  ];
  try {
    const coins = [
      { symbol: "FILLED", chain: "bsc", address: "0xaaa", x: null, links: {} },
      { symbol: "NOX", chain: "bsc", address: "0xbbb", x: null, links: {} },
      { symbol: "STRANGER", chain: "solana", address: "So1", x: null, links: {} },
      { symbol: "HAS", chain: "bsc", address: "0xDDD", x: "already", links: {} },
    ];
    const r = await enrichHandles(coins);
    assert.deepStrictEqual(r.filled, ["FILLED"]);
    assert.deepStrictEqual(r.noHandle, ["NOX"], "a listed token with a blank X is not distinguished");
    assert.deepStrictEqual(r.notListed, ["STRANGER"], "a board-only token is not distinguished");
    assert.strictEqual(r.failed, null);
    // A coin that already had one is not reported at all — it is not a gap.
    for (const k of ["filled", "noHandle", "notListed"]) assert.ok(!r[k].includes("HAS"));
  } finally { api.getListings = real; }
});

test("a failed lookup is named as a failure, not as an empty result", async () => {
  const real = api.getListings;
  api.getListings = async () => { throw new Error("internal API 502"); };
  try {
    const r = await enrichHandles([{ symbol: "A", chain: "bsc", address: "0x1", x: null }]);
    assert.match(r.failed, /502/);
    // …and NOT counted as "no X on file", which would blame the project for an
    // outage on our side.
    assert.deepStrictEqual(r.noHandle, []);
    assert.deepStrictEqual(r.notListed, []);
  } finally { api.getListings = real; }
});

test("the outcome is logged at INFO — a level nobody prints is no line at all", () => {
  assert.match(GSRC, /log\.info\(`\[gainers\] handles · \$\{bits\.join\(" · "\)\}`\)/);
  assert.ok(!/log\.debug\(`\[gainers\] handle enrich/.test(GSRC), "it is back to a level that never shows");
});

test("the preview card explains a missing handle, for the shown tokens only", () => {
  const MENU = fss.readFileSync(path.join(__dirname, "..", "src", "admin", "gainersMenu.js"), "utf8");
  assert.match(MENU, /No X on file:/);
  assert.match(MENU, /Not in the listing store:/);
  assert.match(MENU, /Listing lookup failed/);
  // The sample is wider than the layout, so naming a token that is not on this
  // card would send the admin looking for something that is not there.
  assert.match(MENU, /const shownSyms = new Set\(coins\.map\(\(c\) => c\.symbol\)\);/);
  assert.match(MENU, /hOn = \(list\) => \(list \|\| \[\]\)\.filter\(\(sym\) => shownSyms\.has\(sym\)\)/);
  // It survives a layout switch that does not re-sample.
  assert.match(MENU, /let handles = sess && sess\.handles;/);
});
