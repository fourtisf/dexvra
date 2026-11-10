#!/usr/bin/env node
/*
 * npm run listing:delete — delete ONE listing from the site, from the server.
 *
 * "bisakah delete from server? … kalo token sudah dihapus berarti token
 * bener2 dihapus" (2026-11-05). The same act as the admin console's 🗑, taken
 * from a shell: the operator names the token by its chain and its address
 * (`identity:check` prints a complete line for every listing it finds under
 * the wrong name). Without --apply it is a dry run that shows the row and
 * changes nothing.
 *
 * What a delete means, and the run says each of these after it:
 *   · the row is gone from the store, so dexvra.io drops it on the next page
 *     load (the cached board is filtered against the store at serve time);
 *   · no pump or rank-up alert goes out for it — every alert re-reads the site
 *     right before posting (helpers/stillListed.js);
 *   · the auto-lister will not list that contract again for free: it is put
 *     on the never-relist ledger here, if a scan had not put it there already;
 *   · channel posts already published stay in Telegram — those are deleted by
 *     hand.
 *
 * ⚠️ This is the ONE caller of api.removeListingByHand, the route that may
 * delete a paid row. test/listingDelete.test.js counts the callers: a bulk
 * script using it would be the purchase-taking cleanup the bulk DELETE exists
 * to refuse.
 *
 * Exit: 0 when it deleted (or, as a dry run, found) the listing; 1 otherwise.
 */
require("../src/config/loadEnv").loadEnv();

const path = require("node:path");
const api = require("../src/api/dexvra");
const build = require("../src/helpers/build");
const { chainOf } = require("../src/config/chains");
const { ticker } = require("../src/helpers/format");
const { autoTiers, provenance } = require("../src/helpers/tierProvenance");

const tty = process.stdout.isTTY;
const G = tty ? "\x1b[32m" : "", R = tty ? "\x1b[31m" : "", Y = tty ? "\x1b[33m" : "", D = tty ? "\x1b[2m" : "", X = tty ? "\x1b[0m" : "";
const ok = (s) => console.log(`${G}✓${X} ${s}`);
const bad = (s) => console.log(`${R}✗${X} ${s}`);
const warn = (s) => console.log(`${Y}⚠${X} ${s}`);
const note = (s) => console.log(`  ${D}${s}${X}`);

const BOT_DIR = path.resolve(__dirname, "..");

/** How long ago, in words, for the row summary. */
function ago(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const m = Math.round((Date.now() - ms) / 60000);
  if (m < 60) return `${Math.max(m, 0)}m ago`;
  if (m < 48 * 60) return `${Math.round(m / 60)}h ago`;
  return `${Math.round(m / 1440)}d ago`;
}

/** The lines that describe the row about to go — what the operator checks before --apply. */
function describe(row, granted) {
  const out = [];
  out.push(`${provenance(row, granted)} · status ${row.status || "approved"}${row.source ? ` · source ${row.source}` : ""}`);
  const when = ago(Number(row.listedAt));
  if (when) out.push(`listed ${when}`);
  if (row.trendingRank != null || row.trendExp) {
    const left = Number(row.trendExp) - Date.now();
    out.push(left > 0 ? `⚠️ holds a trending slot for another ${Math.ceil(left / 3600000)}h — deleting ends it` : "had a trending slot (ended)");
  }
  return out;
}

/**
 * Delete one listing. Returns { ok, deleted, row, why }.
 * `deps` is the test seam: the API calls and the ledger read.
 */
async function run(chain, address, apply, deps = {}) {
  const findListing = deps.findListing || api.findListing;
  const remove = deps.remove || api.removeListingByHand;
  const wasEverListed = deps.wasEverListed || ((c, a) => require("../src/services/autoLister").wasEverListed(c, a));
  const remember = deps.remember || ((rows) => require("../src/services/autoLister").rememberListed(rows));
  const granted = deps.granted || autoTiers();

  let row;
  try {
    row = await findListing(chain, address);
  } catch (e) {
    bad(`could not read the listings API: ${e.message}`);
    note("That is the same credential fulfilment uses — check INTERNAL_API_TOKEN in bot/.env on the box.");
    return { ok: false, deleted: false, why: "read failed" };
  }
  if (!row) {
    // A token that is not listed has nothing to delete — and that is already
    // the state this command exists to reach, so say so plainly.
    warn(`no listing for ${chain}/${address} on the site — nothing to delete.`);
    note("If it was deleted already, no pump alert can go out for it: every alert re-reads the site first.");
    return { ok: false, deleted: false, why: "not listed" };
  }

  const head = `${ticker(row.sym || row.symbol || "?")}${row.name ? ` — ${row.name}` : ""}  ${D}${row.chain}/${row.address}${X}`;
  console.log(head);
  for (const l of describe(row, granted)) note(l);
  console.log("");

  if (!apply) {
    warn("dry run — nothing was deleted. To delete it:");
    console.log(`  cd ${BOT_DIR} && npm run listing:delete -- ${row.chain} ${row.address} --apply`);
    return { ok: true, deleted: false, row };
  }

  let res;
  try {
    res = await remove(row.id, row.address);
  } catch (e) {
    bad(`the site refused the delete: ${e.message}`);
    note("Nothing was deleted. The admin console's 🗑 (Listings → search the address → Manage → Delete) does the same thing.");
    return { ok: false, deleted: false, row, why: e.message };
  }
  if (!res || !res.deleted) {
    bad("the site did not confirm the delete — nothing is known to have changed.");
    return { ok: false, deleted: false, row, why: "unconfirmed" };
  }

  ok(`deleted ${ticker(row.sym || row.symbol || "?")} (${row.chain}/${row.address})`);
  note("dexvra.io: gone from the board on the next page load.");
  note("pump and rank-up alerts: none for it — every alert re-reads the site right before posting.");
  // ⚠️ DELETED MEANS IT DOES NOT COME BACK. Every scan folds the live roster
  // into the never-relist ledger, so a row listed for a while is on it already
  // — but one deleted before the next scan was not, and the auto-lister could
  // hand it straight back free. It is recorded here (rememberListed skips a
  // contract already on the ledger, and refuses to write over an unreadable
  // state file). A purchase is unaffected: only free auto-listing reads it.
  let ledger = null;
  try {
    await remember([row]);
    ledger = wasEverListed(row.chain, row.address);
  } catch {
    ledger = null;
  }
  if (ledger === true) note("the auto-lister will not list this contract again for free (it is on the never-relist ledger).");
  else note("⚠️ could not record it on the never-relist ledger — the auto-lister could list it again if it qualifies.");
  note("its channel posts are still in Telegram — delete those by hand.");
  return { ok: true, deleted: true, row };
}

async function main() {
  console.log(`\nDelete one listing from the site   ${D}build ${build.stamp()}${X}\n`);
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const named = args.filter((a) => !a.startsWith("-"));
  if (named.length !== 2) {
    // DESCRIBED, never a usage line with a bracketed blank in it: only the
    // operator knows which token they mean (this repo's first rule).
    bad("name the listing by its chain and its address, in that order, after `--`.");
    note("They are the pair the admin console shows. `npm run identity:check -- --all` prints a complete");
    note("line for every listing published under the wrong name.");
    process.exit(1);
  }
  const [chain, address] = named;
  if (!chainOf(chain)) {
    bad(`"${chain}" is not a chain this bot knows — the chain comes first, then the address.`);
    process.exit(1);
  }
  const r = await run(chain, address, apply);
  process.exit(r.ok ? 0 : 1);
}

if (require.main === module) {
  main().catch((e) => {
    bad(`listing:delete crashed: ${e.message}`);
    process.exit(1);
  });
}

module.exports = { run, describe };
