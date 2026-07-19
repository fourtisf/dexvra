// Paid Mass DM job store — DELIBERATELY ISOLATED from the admin broadcast store
// (src/broadcast/store.js → data/broadcasts/). Public users pay a flat price to
// DM the whole /start audience once, but nothing sends until an admin approves
// (anti-spam / anti-ban). Keeping the dir separate means the admin broadcast
// sender/watchdog can NEVER see a paid public job and start a second sender
// against it, and vice-versa (fourtis incident 2026-07-16).
//
// Status: pending_review → in_progress → completed | rejected.
const fss = require("node:fs");
const { promises: fs } = require("node:fs");
const path = require("node:path");
const { DATA_DIR, loadJSONSync } = require("../helpers/persist");

const MD_DIR = path.join(DATA_DIR, "mass_dm");

/** All /start user ids (strings) — same audience as the admin broadcast. */
function audience() {
  return (loadJSONSync("users.json", []) || []).map(String).filter(Boolean);
}

function ensureDir() {
  try {
    fss.mkdirSync(MD_DIR, { recursive: true });
  } catch {
    /* ignore */
  }
}

function newId() {
  return `md_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

async function saveJob(job) {
  ensureDir();
  const file = path.join(MD_DIR, `${job.id}.json`);
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(job, null, 2), "utf8");
  await fs.rename(tmp, file);
}

/**
 * Create a Mass DM job. `test` jobs (free admin verification) skip review and go
 * straight to in_progress; paid jobs land in pending_review.
 */
async function createJob({ text, entities, mediaPath, createdBy, createdByUsername, targets, test, reportChatId, ref }) {
  const job = {
    id: newId(),
    kind: "mass_dm",
    status: test ? "in_progress" : "pending_review",
    text: text || "",
    entities: entities || [],
    mediaPath: mediaPath || null,
    mediaFileId: null,
    createdBy,
    createdByUsername: createdByUsername || null,
    test: !!test,
    ref: ref || null, // short human ref shown to the buyer / in the receipt
    reportChatId: reportChatId || null, // where the delivery report goes
    targets,
    total: targets.length,
    sent: 0,
    failed: 0,
    cursor: 0,
    createdAt: Date.now(),
  };
  await saveJob(job);
  return job;
}

function loadJob(id) {
  try {
    return JSON.parse(fss.readFileSync(path.join(MD_DIR, `${id}.json`), "utf8"));
  } catch {
    return null;
  }
}

function jobsByStatus(status) {
  try {
    return fss
      .readdirSync(MD_DIR)
      .filter((f) => f.endsWith(".json"))
      .map((f) => loadJob(f.replace(/\.json$/, "")))
      .filter((j) => j && j.status === status)
      .sort((a, b) => a.createdAt - b.createdAt);
  } catch {
    return [];
  }
}

module.exports = { audience, createJob, saveJob, loadJob, jobsByStatus, MD_DIR };
