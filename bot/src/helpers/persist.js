// Tiny JSON-file persistence under DATA_DIR (gitignored). Used for restart-safe
// dedup sets (pump latch, trending post locks), the /start audience, paid-order
// recovery records, templates, group + banner config, etc.
//
// DURABILITY: when MONGO_URI is set (see db/mongo.js) every saveJSON ALSO mirrors
// the store into MongoDB's `kv` collection, and hydrate() at boot restores any
// store whose local file is missing (fresh container / VPS replace). Reads stay
// on the local file — the two bot processes share one DATA_DIR, so the file is
// already the live cross-process medium; Mongo is the durable backup. Everything
// is fail-open: no MONGO_URI or an unreachable server → exactly the old
// local-file-only behaviour.
const fss = require("node:fs");
const { promises: fs } = require("node:fs");
const path = require("node:path");
const { DATA_DIR } = require("../config/constants");
const mongo = require("../db/mongo");
const log = require("./logger");

function ensureDir() {
  try {
    fss.mkdirSync(DATA_DIR, { recursive: true });
  } catch {
    /* ignore */
  }
}

function loadJSONSync(name, def) {
  try {
    return JSON.parse(fss.readFileSync(path.join(DATA_DIR, name), "utf8"));
  } catch {
    return def;
  }
}

let seq = 0;
async function writeFileAtomic(file, data) {
  ensureDir();
  const tmp = `${file}.${process.pid}.${seq++}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  await fs.rename(tmp, file);
}

async function saveJSON(name, data) {
  const file = path.join(DATA_DIR, name);
  await writeFileAtomic(file, data); // local file stays the primary (sync source of truth)
  // Durable mirror — best-effort, never blocks or fails the local write. A slow
  // or down Mongo must never delay a payment/broadcast; boot-time seeding will
  // catch anything a fire-and-forget write missed.
  if (mongo.enabled()) {
    mongo.kvSet(name, data).catch((e) => log.warn(`[persist] mongo mirror failed for ${name}: ${e && e.message}`));
  }
}

// Only top-level *.json files are KV stores (job dirs like broadcasts/ manage
// their own files). Skip tmp files and subdirectories.
function localKvFiles() {
  try {
    return fss
      .readdirSync(DATA_DIR, { withFileTypes: true })
      .filter((d) => d.isFile() && d.name.endsWith(".json"))
      .map((d) => d.name);
  } catch {
    return [];
  }
}

// Boot-time convergence between local disk and the Mongo mirror. Called ONCE by
// each bot process before it reads any state. Restores stores missing on disk
// (fresh container) from Mongo, and seeds Mongo from any local store not yet
// mirrored (first run against an existing VPS). Never clobbers a present local
// file (single-VPS deploy → disk is authoritative for live edits).
async function hydrate() {
  if (!mongo.configured()) return { mode: "file" };
  const db = await mongo.connect();
  if (!db || !mongo.enabled()) return { mode: "file" };
  ensureDir();
  let restored = 0;
  let seeded = 0;
  try {
    const docs = await mongo.kvAll();
    const inMongo = new Set();
    for (const d of docs) {
      inMongo.add(d._id);
      const file = path.join(DATA_DIR, d._id);
      if (!fss.existsSync(file) && d.data !== undefined) {
        try {
          await writeFileAtomic(file, d.data);
          restored++;
        } catch (e) {
          log.warn(`[persist] restore of ${d._id} failed: ${e && e.message}`);
        }
      }
    }
    for (const name of localKvFiles()) {
      if (!inMongo.has(name)) {
        try {
          await mongo.kvSet(name, loadJSONSync(name, null));
          seeded++;
        } catch (e) {
          log.warn(`[persist] seed of ${name} failed: ${e && e.message}`);
        }
      }
    }
    log.info(`[persist] mongo hydrate: ${docs.length} store(s) in db, restored ${restored}, seeded ${seeded}`);
    return { mode: "mongo", docs: docs.length, restored, seeded };
  } catch (e) {
    log.warn(`[persist] hydrate error — continuing on local files: ${e && e.message}`);
    return { mode: "file", error: e && e.message };
  }
}

/** A persisted string Set — for once-only dedup (pump latch, trend post locks). */
class DedupSet {
  constructor(name) {
    this.name = name;
    this.set = new Set(loadJSONSync(name, []));
  }
  has(k) {
    return this.set.has(k);
  }
  async add(k) {
    if (this.set.has(k)) return false;
    this.set.add(k);
    await saveJSON(this.name, [...this.set]).catch(() => {});
    return true;
  }
  async delete(k) {
    if (!this.set.delete(k)) return;
    await saveJSON(this.name, [...this.set]).catch(() => {});
  }
}

module.exports = { loadJSONSync, saveJSON, ensureDir, hydrate, DedupSet, DATA_DIR };
