// What each group's buy bot is ACTUALLY pointed at, and how to clear one.
//
// WHY THIS EXISTS
// An operator opened a group they had never configured and found a token set
// in it, and there was no way to check the claim from outside Telegram: the
// admin bot never reads group config, and `data/groups.json` is a wall of
// chat ids. So "the bot invented a CA" and "somebody pasted one months ago"
// looked identical, and neither could be proved.
//
// They are not identical. Every row carries `createdAt`, and this prints it —
// so a configuration is either older than the group's memory of setting it, or
// it is not.
//
//   node scripts/group-ca.js                 # list every configured group
//   node scripts/group-ca.js -1001234567890  # one group, in full
//   node scripts/group-ca.js -1001234567890 --clear
//
// --clear removes the TOKEN and leaves the group's tuning (floor, whale bar,
// pin) alone — the same thing 🗑 Remove CA does in the group, for the same
// reason: swapping a contract is the ordinary use, and silently resetting
// numbers an admin chose would only surface as a wrong-looking alert later.
require("dotenv").config({ override: true });

const path = require("node:path");
const fss = require("node:fs");

const DATA_DIR = process.env.BOT_DATA_DIR || path.join(__dirname, "..", "..", "data");
const FILE = path.join(DATA_DIR, "groups.json");

const args = process.argv.slice(2);
const clear = args.includes("--clear");
const target = args.find((a) => !a.startsWith("--"));

let groups;
try {
  groups = JSON.parse(fss.readFileSync(FILE, "utf8"));
} catch (e) {
  console.error(`❌ Could not read ${FILE}: ${e.message}`);
  console.error("   (Nothing has been configured yet, or BOT_DATA_DIR points elsewhere.)");
  process.exit(1);
}

const when = (ts) => (ts ? new Date(Number(ts)).toISOString().replace("T", " ").replace(/\..+/, "") : "unknown");
const rows = Object.values(groups);

if (!target) {
  const set = rows.filter((g) => g.address);
  console.log(`${rows.length} group row(s) in ${FILE}; ${set.length} with a token set.\n`);
  for (const g of rows) {
    console.log(
      `${g.chatId}  ${g.address ? `${g.chain}/${g.address}` : "— no token —"}` +
        `${g.sym ? `  ${g.sym}` : ""}  on=${g.on ? "yes" : "no"}  created ${when(g.createdAt)}`,
    );
  }
  if (set.length) {
    console.log(`\nTo clear one:  node scripts/group-ca.js <chatId> --clear`);
  }
  process.exit(0);
}

const g = groups[String(target)];
if (!g) {
  console.error(`❌ No row for ${target}. Run without arguments to list them.`);
  process.exit(1);
}

if (!clear) {
  console.log(JSON.stringify(g, null, 2));
  console.log(`\ncreatedAt: ${when(g.createdAt)}`);
  if (g.address) console.log(`\nTo clear the token:  node scripts/group-ca.js ${target} --clear`);
  process.exit(0);
}

if (!g.address) {
  console.log(`${target} already has no token set. Nothing to do.`);
  process.exit(0);
}
const was = `${g.chain}/${g.address}${g.sym ? ` (${g.sym})` : ""}`;
// null, not delete: the group row keeps its tuning, and cfg.active() already
// requires an address, so a row without one is never polled.
g.address = null;
g.pairAddress = null;
g.sym = null;
g.name = null;
fss.writeFileSync(FILE, JSON.stringify(groups, null, 2));
console.log(`✅ ${target}: cleared ${was}. Floor, whale bar and pin are untouched.`);
console.log(`\nRestart so the running process re-reads it:`);
console.log(`   cd ${path.join(__dirname, "..")} && pm2 restart ecosystem.config.js --update-env`);
if (process.env.MONGO_URI) {
  console.log(`\nMONGO_URI is set, so the mirror re-syncs on the next sweep — the change is local first, by design.`);
}
