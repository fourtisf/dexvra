// Tiny JSON-file persistence under DATA_DIR (gitignored). Used for restart-safe
// dedup sets (pump latch, trending post locks) and paid-order recovery records.
// No Redis dependency — a single-process bot doesn't need one.
const fss = require("node:fs");
const { promises: fs } = require("node:fs");
const path = require("node:path");
const { DATA_DIR } = require("../config/constants");

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
async function saveJSON(name, data) {
  ensureDir();
  const file = path.join(DATA_DIR, name);
  const tmp = `${file}.${process.pid}.${seq++}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  await fs.rename(tmp, file);
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

module.exports = { loadJSONSync, saveJSON, ensureDir, DedupSet, DATA_DIR };
