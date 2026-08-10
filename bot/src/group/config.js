// Per-group buy-bot config (data/groups.json), keyed by Telegram chat id. A
// project adds @dexvrabot to their group, runs /settoken <CA> (+ /setchain if
// the auto-guess is wrong), and every on-chain buy of their token posts an
// alert in the group. One config per group chat.
const { loadJSONSync, saveJSON } = require("../helpers/persist");

const FILE = "groups.json";
const groups = loadJSONSync(FILE, {});

/**
 * Re-read the file into the live object. MUST be called after
 * persist.hydrate() — see the identical note in src/raid/store.js. This module
 * is loaded through handlers/registry.js at require("./src/bot") time, which is
 * before startBot() awaits hydrate(), so on a fresh container this store comes
 * up empty and every configured group's buy bot silently monitors nothing until
 * the next restart.
 */
function reload() {
  const fresh = loadJSONSync(FILE, {});
  for (const k of Object.keys(groups)) delete groups[k];
  Object.assign(groups, fresh);
  return Object.keys(groups).length;
}

const key = (chatId) => String(chatId);

function get(chatId) {
  return groups[key(chatId)] || null;
}

function all() {
  return Object.values(groups);
}

/** Active groups: buy-bot on AND a token+pair resolved. */
function active() {
  return all().filter((g) => g.on && g.chain && g.address);
}

async function upsert(chatId, patch) {
  const k = key(chatId);
  groups[k] = { ...(groups[k] || { chatId: k, on: false, minBuyUsd: 0, createdAt: Date.now() }), ...patch, chatId: k };
  await saveJSON(FILE, groups).catch(() => {});
  return groups[k];
}

async function remove(chatId) {
  delete groups[key(chatId)];
  await saveJSON(FILE, groups).catch(() => {});
}

module.exports = { get, all, active, upsert, remove, reload };
