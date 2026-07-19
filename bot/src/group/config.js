// Per-group buy-bot config (data/groups.json), keyed by Telegram chat id. A
// project adds @dexvrabot to their group, runs /settoken <CA> (+ /setchain if
// the auto-guess is wrong), and every on-chain buy of their token posts an
// alert in the group. One config per group chat.
const { loadJSONSync, saveJSON } = require("../helpers/persist");

const FILE = "groups.json";
const groups = loadJSONSync(FILE, {});

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

module.exports = { get, all, active, upsert, remove };
