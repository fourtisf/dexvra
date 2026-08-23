// Removing the auto-listings a seeding run created. "ton ganti tron aja" —
// `seed:chain --all` filled sixteen chains the trending board is not allowed
// to use, and TON took the site's chain-row slot Tron was wanted in.
//
// This DELETES PUBLIC ROWS, so what is pinned here is the blast radius: a
// chain must be named, --apply is the only thing that removes anything, and
// the filter can never reach something a customer paid for.
const test = require("node:test");
const assert = require("node:assert");
const fss = require("node:fs");
const path = require("node:path");

const SCRIPT = path.join(__dirname, "..", "scripts", "unseed-chain.js");
const src = () => fss.readFileSync(SCRIPT, "utf8");
/** The script's CODE, comments stripped — a scan over the raw file matches the
 *  header explaining the rule, so a correct script fails its own guard. Third
 *  time in this repo; it is always the comment. */
const code = () =>
  src()
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

test("it is DRY RUN by default, and --apply is the only thing that removes", () => {
  const s = src();
  assert.match(s, /const apply = flags\.includes\('--apply'\)/);
  assert.match(s, /if \(!apply\) continue/, "a dry run must not reach deleteListing");
  assert.match(s, /DRY RUN/);
});

test("there is NO --all, and the one chainless mode is scoped by WHAT, not WHERE", () => {
  // seed:chain has --all because over-listing is recoverable — by removing
  // rows. The inverse is not: `everListed` is written at creation and never
  // cleared, so a removed token does not come back through the seeder at all.
  // A bare "remove everything" therefore must not exist.
  assert.ok(!/--all/.test(code()), "unseed must never grow an --all");

  // `--stablecoins` runs without a chain, and that is a different thing: it is
  // bounded by what a row IS (`notAProject`) rather than by a flag meaning
  // "everything". The leak it cleans up landed on every chain at once, so
  // naming them one by one would be the same typo risk twenty-two times over.
  assert.match(code(), /flags\.includes\('--stablecoins'\)/);
  assert.match(code(), /!chains\.length && !money/, "every other mode still requires a named chain");
  assert.match(code(), /removable\(r\) && \(!money \|\| isMoney\(r\)\)/, "the stablecoin sweep NARROWS, never widens");
});

test("the stablecoin sweep judges the row the way a reader sees it", () => {
  // The site stores the SANITISED ticker — `$USDT`, ₮ already gone — which is
  // the wrong string to have judged at the source and the right one for a
  // cleanup: it is what a human reads on the board.
  const { notAProject } = require("../src/services/bigCoins");
  assert.ok(notAProject("USDT", "Tether"), "the row as stored");
  assert.ok(notAProject("USD₮0", "Tether"), "and the row as the source spelled it");
  assert.ok(!notAProject("PEPE", "Pepe"));
  assert.match(src(), /const isMoney = \(r\) => notAProject\(r\.sym, r\.name\)/);
});

test("the removable filter refuses anything somebody paid for", () => {
  // Mirrored from the script so the RULE is executable rather than read.
  const removable = (r) =>
    r.source === "bot" &&
    String(r.tier || "").toUpperCase() === "FREE" &&
    r.trendingRank == null &&
    !r.trendExp;

  assert.strictEqual(removable({ source: "bot", tier: "FREE" }), true);
  assert.strictEqual(removable({ source: "bot", tier: "DIAMOND" }), false, "a real tier is a purchase");
  assert.strictEqual(removable({ source: "admin", tier: "FREE" }), false, "an admin listed that by hand");
  assert.strictEqual(removable({ source: "submission", tier: "FREE" }), false, "a project submitted that");
  assert.strictEqual(removable({ source: "seed", tier: "FREE" }), false);
  assert.strictEqual(removable({ source: "bot", tier: "FREE", trendingRank: 1 }), false, "it is on the board");
  assert.strictEqual(removable({ source: "bot", tier: "FREE", trendExp: Date.now() + 1e6 }), false, "it holds a slot");

  const s = src();
  for (const rule of ["source !== 'bot'", "!== 'FREE'", "trendingRank != null", "trendExp"]) {
    assert.ok(s.includes(rule), `the script lost the ${rule} guard`);
  }
});

test("⚠️ the SITE is the one that enforces it, not this script", () => {
  // A caller can be wrong about what it is holding; the store cannot. The
  // route re-checks every rule and answers 409 naming which one stopped it —
  // a bulk run that had to be TRUSTED is the thing being avoided.
  const route = fss.readFileSync(
    path.join(__dirname, "..", "..", "src", "app", "api", "internal", "listings", "[id]", "route.ts"),
    "utf8",
  );
  assert.match(route, /export async function DELETE/);
  assert.match(route, /internalAuthorized/, "an unauthenticated delete route would be a way to erase the site");
  assert.match(route, /source !== "bot"/);
  assert.match(route, /!== "FREE"/);
  assert.match(route, /trendingRank != null \|\| row\.trendExp/);
  // The refusal must say WHICH rule — "409" over a bulk run tells the operator
  // nothing about whether their data is safe.
  assert.match(route, /somebody paid for that/);
  assert.match(route, /it holds a trending slot/);
});

test("a refusal fails the run, and the reason is printed rather than counted", () => {
  const s = src();
  assert.match(s, /refused\+\+/);
  assert.match(s, /e\.message/, "a 409 names a rule this script could not see");
  assert.match(s, /process\.exit\(refused \? 1 : 0\)/);
});

test("the bot's client has the delete call, and it is the only one", () => {
  const apiSrc = fss.readFileSync(path.join(__dirname, "..", "src", "api", "dexvra.js"), "utf8");
  assert.match(apiSrc, /async function deleteListing/);
  assert.match(apiSrc, /call\("DELETE", `\/api\/internal\/listings/);
  // Nothing in the running bot may delete a listing on its own — this exists
  // for an operator running a script, and a service loop that could remove
  // rows is a very different feature from one that adds them.
  const files = fss
    .readdirSync(path.join(__dirname, "..", "src", "services"))
    .filter((f) => f.endsWith(".js"));
  for (const f of files) {
    const body = fss.readFileSync(path.join(__dirname, "..", "src", "services", f), "utf8");
    assert.ok(!/deleteListing/.test(body), `${f} must not be able to delete listings`);
  }
});

// ── Double rows on the board ────────────────────────────────────────────────
//
// `$FLOKI` appeared twice, rows 8 and 9, same name, both drawing the monogram.
// One seeding run found the same token through two addresses.

const fix = require("node:path").join(__dirname, "..", "scripts", "fix-listings.js");
const fixSrc = () => fss.readFileSync(fix, "utf8");

test("of a duplicate set, the one with a LOGO is kept", () => {
  // Then the bigger cap, then the older row — the last only so the answer is
  // stable across runs rather than depending on the order the API returned.
  const rows = [
    { id: "a", chain: "bsc", sym: "FLOKI", mcap: 9_000_000, createdAt: 5 },
    { id: "b", chain: "bsc", sym: "FLOKI", mcap: 1_000_000, createdAt: 9, logoUrl: "https://i/b.png" },
  ];
  assert.match(fixSrc(), /if \(hasLogo\(a\) !== hasLogo\(b\)\) return hasLogo\(a\) \? -1 : 1/);
  // …and the ordering is stated before the cap, so a logo outranks nine times
  // the market cap. A row that renders is worth more than a row that is bigger.
  const src = fixSrc();
  assert.ok(src.indexOf("hasLogo(a) !== hasLogo(b)") < src.indexOf("Number(b.mcap)"));
  assert.strictEqual(rows.length, 2);
});

test("⚠️ dedupe is scoped to ONE CHAIN and to rows the bot listed free", () => {
  // Two different real tokens CAN share a ticker — that is ordinary in crypto,
  // and on a paid board removing either would be wrong. It is safe here only
  // because the set is narrowed to auto-listed FREE rows on the SAME chain:
  // that is not two projects, it is one run finding one token twice.
  const src = fixSrc();
  assert.match(src, /rows\.filter\(removable\)/, "paid rows are never in a duplicate set");
  assert.match(src, /`\$\{r\.chain\}:\$\{String\(r\.sym \|\| ''\)\.trim\(\)\.toUpperCase\(\)\}`/, "the key carries the chain");
  assert.match(src, /Two different real tokens CAN share a ticker/, "the trade must stay stated");
});

test("a row with no logo from ANY source is removed, not left blank", () => {
  const src = fixSrc();
  assert.match(src, /resolveLogo\(r\.chain, r\.address\)/);
  assert.match(src, /no logo anywhere/);
  assert.match(src, /api\.updateListing\(r\.id, \{ logoUrl: hit\.url \}\)/, "a logo that IS found is stored");
  // A stablecoin that slipped in earlier should go, not be given artwork.
  assert.match(src, /notAProject\(r\.sym, r\.name\)/);
});

test("dedupe runs BEFORE the logo pass", () => {
  // Otherwise the logo pass spends four network reads per row on rows that are
  // about to be removed anyway.
  const src = fixSrc();
  assert.ok(src.indexOf("1. duplicates") < src.indexOf("2. logos"));
  assert.match(src, /dropped\.has\(r\.id\)/, "and a dropped row is not then given a logo");
});

test("it inherits every guard unseed has", () => {
  const src = fixSrc();
  assert.match(src, /const apply = flags\.includes\('--apply'\)/);
  assert.match(src, /DRY RUN/);
  assert.match(src, /r\.source === 'bot'/);
  assert.match(src, /=== 'FREE'/);
  assert.match(src, /r\.trendingRank == null/);
  assert.match(src, /!r\.trendExp/);
});
