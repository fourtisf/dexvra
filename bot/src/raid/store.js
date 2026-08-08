// Per-group raid state (data/raids.json), keyed by Telegram chat id.
//
// One record per group holds BOTH the panel's settings and the live raid.
// Two fields in here are not bookkeeping — they are the only things standing
// between a customer and a permanently silenced chat:
//
//   raid.expiresAt        the DURABLE deadline. A raid whose process is killed
//                         mid-run leaves a locked group behind, and the
//                         in-memory poll timer dies with it. The boot sweep
//                         reads this, not the timer.
//   raid.prevPermissions  the chat's permissions EXACTLY as they were before
//                         we locked it, stored verbatim — including keys this
//                         codebase has never heard of. Telegram keeps adding
//                         them, and handing back a hand-written "unlocked"
//                         default would silently rewrite a customer's group
//                         rules (re-enabling media in a text-only chat, say).
//
// Both live on disk rather than in memory so ANY process after ANY restart can
// finish the unlock.
const { loadJSONSync, saveJSON } = require("../helpers/persist");

const FILE = "raids.json";
const groups = loadJSONSync(FILE, {});

const key = (chatId) => String(chatId);

// Panel defaults. These are DELTAS ("+15 likes"), never absolute counts, and
// they are COPIED into the raid at launch — so editing the panel mid-raid
// cannot move a running raid's goalposts. 0 means "not tracked", and an
// untracked metric never appears on the card at all.
const DEFAULT_SETTINGS = {
  likes: 15,
  replies: 5,
  reposts: 0,
  crew: 10,
  lockChat: false,
  postUrl: "",
};

const blankRaid = () => ({ status: "idle" });

function get(chatId) {
  return groups[key(chatId)] || null;
}

/** The record, created on first touch. Always has `settings` and `raid`. */
function getOrCreate(chatId, title = "") {
  const k = key(chatId);
  if (!groups[k]) {
    groups[k] = {
      chatId: k,
      title,
      settings: { ...DEFAULT_SETTINGS },
      raid: blankRaid(),
      stats: { started: 0, completed: 0, expired: 0 },
      createdAt: Date.now(),
    };
  }
  const g = groups[k];
  g.settings = { ...DEFAULT_SETTINGS, ...(g.settings || {}) };
  if (!g.raid) g.raid = blankRaid();
  if (!g.stats) g.stats = { started: 0, completed: 0, expired: 0 };
  if (title && g.title !== title) g.title = title;
  return g;
}

const all = () => Object.values(groups);

/** Every group with a live raid — the runner's per-tick query. */
const running = () => all().filter((g) => g && g.raid && g.raid.status === "running");

/** Persist. Never throws: a failed write must not take down the poll loop. */
async function save() {
  await saveJSON(FILE, groups).catch(() => {});
}

async function setSettings(chatId, patch) {
  const g = getOrCreate(chatId);
  g.settings = { ...g.settings, ...patch };
  await save();
  return g;
}

async function setRaid(chatId, raid) {
  const g = getOrCreate(chatId);
  g.raid = raid;
  await save();
  return g;
}

async function patchRaid(chatId, patch) {
  const g = getOrCreate(chatId);
  g.raid = { ...(g.raid || blankRaid()), ...patch };
  await save();
  return g;
}

/**
 * Add someone to the crew, exactly once.
 *
 * The check and the push are SYNCHRONOUS, before any await. A raid card is
 * precisely the moment twenty people tap in the same second, and a
 * read-await-write would drop most of them. Returns true when this call is the
 * one that added them.
 */
function joinCrew(chatId, userId, name) {
  const g = get(chatId);
  if (!g || !g.raid || g.raid.status !== "running") return false;
  const uid = String(userId);
  if (!Array.isArray(g.raid.crew)) g.raid.crew = [];
  if (g.raid.crew.some((p) => p.userId === uid)) return false;
  g.raid.crew.push({ userId: uid, name: String(name || ""), at: Date.now() });
  save();
  return true;
}

async function remove(chatId) {
  delete groups[key(chatId)];
  await save();
}

/** Test seam — drop everything without touching the operator's file. */
function _reset() {
  for (const k of Object.keys(groups)) delete groups[k];
}

module.exports = {
  get,
  getOrCreate,
  all,
  running,
  save,
  setSettings,
  setRaid,
  patchRaid,
  joinCrew,
  remove,
  _reset,
  DEFAULT_SETTINGS,
  FILE,
};
