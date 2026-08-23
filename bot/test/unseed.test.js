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

test("there is NO --all — the blast radius of a typo is the whole site", () => {
  // seed:chain has --all because over-listing is recoverable by removing rows.
  // The inverse is not: a removed listing does not come back through the
  // seeder at all, because `everListed` is written at creation and never
  // cleared. So a chain has to be typed.
  assert.ok(!/--all/.test(code()), "unseed must never grow an --all");
  assert.match(src(), /if \(!chains\.length/, "naming a chain is required");
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
