// Broadcast job store (data/broadcasts/). The admin bot writes a job; the MAIN
// bot's sender picks it up and delivers (only the main bot can DM users who
// /start-ed it). Audience = data/users.json (the /start set).
const fss = require("node:fs");
const { promises: fs } = require("node:fs");
const path = require("node:path");
const { DATA_DIR, loadJSONSync } = require("../helpers/persist");
const jobMirror = require("../db/jobMirror");

const BC_DIR = path.join(DATA_DIR, "broadcasts");

/** All /start user ids (strings). */
function audience() {
  return (loadJSONSync("users.json", []) || []).map(String).filter(Boolean);
}

function ensureDir() {
  try {
    fss.mkdirSync(BC_DIR, { recursive: true });
  } catch {
    /* ignore */
  }
}

function newId() {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

async function saveJob(job) {
  ensureDir();
  const file = path.join(BC_DIR, `${job.id}.json`);
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(job, null, 2), "utf8");
  await fs.rename(tmp, file);
  jobMirror.mirrorJob("broadcasts", job); // durable mirror (best-effort, off Mongo → no-op)
}

async function createJob({ text, entities, mediaPath, createdBy, createdByUsername, targets, test }) {
  const job = {
    id: newId(),
    status: "pending",
    text: text || "",
    entities: entities || [], // premium-emoji/format entities from the admin's compose message
    mediaPath: mediaPath || null,
    mediaFileId: null, // filled after the first upload (reused thereafter)
    createdBy,
    createdByUsername: createdByUsername || null,
    test: !!test,
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
    return JSON.parse(fss.readFileSync(path.join(BC_DIR, `${id}.json`), "utf8"));
  } catch {
    return null;
  }
}

function jobsByStatus(status) {
  try {
    return fss
      .readdirSync(BC_DIR)
      .filter((f) => f.endsWith(".json"))
      .map((f) => loadJob(f.replace(/\.json$/, "")))
      .filter((j) => j && j.status === status)
      .sort((a, b) => a.createdAt - b.createdAt);
  } catch {
    return [];
  }
}

module.exports = { audience, createJob, saveJob, loadJob, jobsByStatus, BC_DIR };
