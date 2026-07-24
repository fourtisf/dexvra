#!/usr/bin/env node
// One-shot: force-push EVERY local store to MongoDB right now — the JSON stores
// (→ `kv` collection) AND the binary media (banner clips + artwork → GridFS
// `blobs`). Normally these mirror themselves as they change; this is the
// "back everything up NOW" button (e.g. before a migration).
//
//   cd /opt/dexvra/bot && node scripts/backup-to-mongo.js
//
// Requires MONGO_URI in .env. Fail-loud: exits non-zero if Mongo is unreachable.
// NOTE: session.txt (the premium login) is intentionally NOT backed up — it is
// auth material, not data. Re-create it with scripts/gramjs-login.js if lost.
require("dotenv").config({ path: require("node:path").join(__dirname, "..", ".env") });
const path = require("node:path");
const fss = require("node:fs");
const { DATA_DIR } = require("../src/config/constants");
const mongo = require("../src/db/mongo");
const mediaMirror = require("../src/db/mediaMirror");

(async () => {
  if (!mongo.configured()) {
    console.error("✗ MONGO_URI not set (or the 'mongodb' package isn't installed). Nothing to back up to.");
    process.exit(1);
  }
  const db = await mongo.connect();
  if (!db || !mongo.enabled()) {
    console.error("✗ Could not connect to MongoDB — check MONGO_URI / network.");
    process.exit(1);
  }
  console.log(`→ Backing up ${DATA_DIR} to MongoDB (db=${db.databaseName})…\n`);

  let json = 0;
  let blob = 0;
  let skipped = 0;
  const files = fss.existsSync(DATA_DIR) ? fss.readdirSync(DATA_DIR) : [];
  for (const name of files) {
    if (name.endsWith(".tmp")) continue;
    const p = path.join(DATA_DIR, name);
    let st;
    try {
      st = fss.statSync(p);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;

    if (name.endsWith(".json")) {
      try {
        const data = JSON.parse(fss.readFileSync(p, "utf8"));
        await mongo.kvSet(name, data);
        json++;
        console.log(`  kv   ✓ ${name}`);
      } catch (e) {
        skipped++;
        console.warn(`  kv   ✗ ${name}: ${e.message}`);
      }
    } else if (mediaMirror.isBlob(name)) {
      try {
        await mediaMirror.mirrorFile(name);
        blob++;
        console.log(`  blob ✓ ${name} (${(st.size / 1048576).toFixed(2)} MB)`);
      } catch (e) {
        skipped++;
        console.warn(`  blob ✗ ${name}: ${e.message}`);
      }
    } else {
      skipped++; // e.g. session.txt (auth), stray files
    }
  }

  console.log(
    `\n✓ Backup complete → MongoDB: ${json} JSON store(s), ${blob} media file(s), ${skipped} skipped.\n` +
      `  Restore is automatic on the next boot (persist.hydrate + mediaMirror.hydrate).`,
  );
  await mongo.close();
  process.exit(0);
})().catch((e) => {
  console.error("✗ backup failed:", e && e.message);
  process.exit(1);
});
