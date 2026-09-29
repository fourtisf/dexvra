#!/usr/bin/env node
/*
 * REMOVE THE STABLECOINS AND WRAPPERS ALREADY ON THE SITE.
 *
 * "jangan pernah listing stable coin jika sudah terlanjur hapus smua stable
 * coin yang listing". The first half is `createFromInfo`, which now refuses
 * them at the one door every listing goes through. This is the second half:
 * the rows listed BEFORE that gate existed are still on the site, and no gate
 * can reach backwards.
 *
 * ⚠️ IT DELETES, SO IT SHOWS FIRST. Dry run is the default and `--apply` is the
 * only thing that removes anything — the `listings:fix` contract, and it
 * matters more here because a listing is gone for good and the site is public.
 *
 * ⚠️ AND IT PRINTS THE TIER. `FREE` is the tier the bot books itself and
 * nobody can buy; anything else was PAID FOR.
 *
 * ⚠️ A ROW THE SITE PROTECTS IS "KEPT", NEVER A FAILURE. The internal DELETE
 * route refuses a paid tier, a row that did not come from the bot (a public
 * submission) and a live trending slot — correctly: a bulk script must never be
 * able to take away something a customer bought. The first live run asked
 * anyway and printed three red ✗ lines for $PEPE rows (GOLD, XPRESS, a
 * submission) under "Removed 48 of 51", which reads as a cleanup that broke
 * rather than a guard that held. `keptBy` mirrors the route's own three rules,
 * so those rows are listed as KEPT with the reason, never attempted, and never
 * turn the exit code. A human removes one of those by hand in the admin panel,
 * which is a decision, not a bulk action.
 */
// ⚠️ ORDER, not presence: loadEnv() runs BEFORE any repo require, because
// config/constants.js freezes every value at require time — a script that
// reads an empty environment reports it as a fact about the server.
require("../src/config/loadEnv").loadEnv();
const api = require("../src/api/dexvra");
const { notAProject } = require("../src/services/bigCoins");
const { impersonates } = require("../src/services/listingQuality");
const { ticker } = require("../src/helpers/format");
// What the running bot's audit has flagged (listingAudit.js): honeypots, taxes
// and the rest, which only a contract check can see. Read, never re-derived —
// this script must not grow a second idea of "is it a scam".
const auditFlags = (() => {
  try {
    return require("../src/services/listingAudit").flagged();
  } catch {
    return {};
  }
})();
const keyOf = (chain, address) => `${chain}:${String(address).toLowerCase()}`;

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
// ⚠️ FREE rows only. A missing logo is a reason not to LIST a token for free,
// never a reason to delete one somebody paid for — the site's resolver fills
// artwork in the background, and a purchase is not ours to take down over it.
const NO_LOGO = args.includes("--no-logo");
const build = () => {
  try {
    return require("node:child_process").execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
};

// The site's own field names, and BOTH spellings: the bot writes `sym`, and a
// row that came in through the public form or an older shape may carry
// `symbol`. Reading one only is how half the roster reads as clean.
const symOf = (r) => String(r.sym ?? r.symbol ?? "");
const nameOf = (r) => String(r.name ?? "");

/**
 * Why the SITE would refuse to delete this row, or null. The same three rules,
 * in the same order, as `DELETE /api/internal/listings/:id` — a script that
 * guessed differently would either attempt what the site refuses (a red ✗ over
 * a guard working) or skip what it would allow.
 */
function keptBy(r) {
  if (r.source !== "bot") return `source "${r.source ?? "unknown"}", not the bot`;
  const tier = String(r.tier || "").toUpperCase();
  if (tier !== "FREE") return `paid tier ${tier || "?"}`;
  if (r.trendingRank != null || r.trendExp) return "holds a trending slot";
  return null;
}

async function main() {
  console.log(`\nListed stablecoins, wrappers & copies of major coins — build ${build()}\n`);
  let rows;
  try {
    rows = await api.getListings();
  } catch (err) {
    console.error(`✗ could not read the listings API: ${err?.message ?? err}`);
    console.error("  INTERNAL_API_TOKEN and SITE_URL are read from the repo's .env files;");
    console.error("  this must run on the box, where those exist.");
    process.exit(1);
  }
  if (!Array.isArray(rows)) {
    console.error("✗ the listings API did not answer with a list");
    process.exit(1);
  }

  // Why each row goes — printed beside it, because "stablecoin", "a copy of
  // Shiba Inu" and "no artwork" are three different reasons to delete a listing.
  const whyOf = (r) => {
    if (notAProject(symOf(r), nameOf(r))) return "stablecoin/wrapper";
    const fake = impersonates(r.chain, r.address, symOf(r), nameOf(r));
    if (fake) return `copy of ${fake.name}`;
    const flag = auditFlags[keyOf(r.chain, r.address)];
    if (flag) return `audit: ${String(flag.why).slice(0, 40)}`;
    if (NO_LOGO && String(r.tier || "").toUpperCase() === "FREE" && !/^https?:\/\/|^\//.test(String(r.logoUrl || "")))
      return "free, no logo";
    return null;
  };
  const hits = rows.filter((r) => whyOf(r));
  console.log(
    `${rows.length} listing(s) read · ${hits.length} match (stablecoins, wrappers, copies of major coins, audit flags` +
      `${NO_LOGO ? ", free rows with no logo" : ""})\n`,
  );
  if (hits.length === 0) {
    console.log("Nothing to remove.\n");
    return;
  }

  const kept = hits.filter((r) => keptBy(r));
  const doomed = hits.filter((r) => !keptBy(r));

  const row = (r, note) =>
    console.log(
      `  ${String(r.tier || "?").toUpperCase().padEnd(9)} ${String(r.chain || "?").padEnd(10)} ` +
        `${ticker(symOf(r)).padEnd(11)} ${nameOf(r).slice(0, 28).padEnd(28)} ${note.padEnd(44)} ${r.id || ""}`,
    );
  if (doomed.length) {
    console.log(`To remove (${doomed.length}):`);
    for (const r of doomed) row(r, whyOf(r));
    console.log("");
  }
  if (kept.length) {
    console.log(`Kept — the site protects these, and this script does not ask (${kept.length}):`);
    for (const r of kept) row(r, `${whyOf(r)} · KEPT: ${keptBy(r)}`);
    console.log("  A purchase or a public submission is never removed in bulk. If one of these");
    console.log("  really must go, an admin removes it by hand in the admin panel.\n");
  }
  if (!doomed.length) {
    console.log("Nothing this script may remove.\n");
    return;
  }

  if (!APPLY) {
    console.log("Dry run — nothing was deleted. Re-run with --apply to remove them:");
    console.log(`  npm run listings:nostables -- ${NO_LOGO ? "--no-logo " : ""}--apply\n`);
    return;
  }

  let gone = 0;
  const failed = [];
  for (const r of doomed) {
    try {
      const res = await api.deleteListing(r.id);
      // ⚠️ A CALL THAT RETURNED IS NOT A ROW THAT WENT. The route answers
      // `{deleted:false}` for an id it does not hold, and counting that as a
      // deletion is how a report says 7 removed over a board that still has 7.
      if (res && res.deleted === false) failed.push(`${ticker(symOf(r))} — the site does not hold that id`);
      else gone++;
    } catch (err) {
      failed.push(`${ticker(symOf(r))} — ${err?.message ?? err}`);
    }
  }
  console.log(`Removed ${gone} of ${doomed.length}${kept.length ? ` · ${kept.length} kept (protected)` : ""}.`);
  for (const f of failed) console.log(`  ✗ ${f}`);
  console.log(
    "\nThey will not come back: `createFromInfo` refuses them at the one door\n" +
      "every listing goes through (the scan, the board filler and the seeder).\n",
  );
  if (failed.length) process.exitCode = 1;
}

module.exports = { keptBy, main };

if (require.main === module)
  main().catch((err) => {
    console.error("✗ " + (err?.stack || err));
    process.exit(1);
  });
