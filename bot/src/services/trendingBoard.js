// Admin-editable look of the pinned "Dexvra Trending" board: the per-chain logo
// emoji and the rank badges 1–8. Persisted so the operator tunes them from
// @dexvraadminbot with no redeploy; trendingPoster reads get() fresh each cycle.
const { loadJSONSync, saveJSON } = require("../helpers/persist");
const { CHAIN_ORDER, chainOf } = require("../config/chains");

const FILE = "trendingBoard.json";

// Rank badges 1..8 (index 0 = rank 1). Ranks 9–10 fall back to "9." / "10.".
const DEFAULT_RANK_EMOJIS = ["🥇", "🥈", "🥉", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣"];
const RANK_SLOTS = DEFAULT_RANK_EMOJIS.length; // 8 editable slots

// Per-chain logo emoji — sensible defaults (brand-ish colours / mascots), all
// admin-overridable. Any chain not listed falls back to 🔹.
const DEFAULT_CHAIN_LOGOS = {
  solana: "🟣",
  bsc: "🟡",
  ethereum: "🔷",
  base: "🔵",
  robinhood: "🟢",
  tron: "🔻",
  ton: "💎",
  sui: "🌊",
  plasma: "⚡",
  polygon: "🟪",
  arbitrum: "🔵",
  optimism: "🔴",
  avalanche: "🔺",
  berachain: "🐻",
  sonic: "💨",
  hyperevm: "🟩",
  abstract: "🟢",
  apechain: "🐵",
  blast: "🟡",
  sei: "🔴",
  aptos: "⚪",
  unichain: "🦄",
};
const FALLBACK_LOGO = "🔹";

function load() {
  const c = loadJSONSync(FILE, {}) || {};
  return {
    chainLogos: c.chainLogos && typeof c.chainLogos === "object" ? c.chainLogos : {},
    rankEmojis: Array.isArray(c.rankEmojis) ? c.rankEmojis : [],
  };
}

/** The rank badge for a 1-based position (1..). 1–8 are configurable; 9+ are "N.". */
function rankBadge(pos) {
  if (pos > RANK_SLOTS) return `${pos}.`;
  const saved = load().rankEmojis;
  const i = pos - 1;
  return (saved[i] && String(saved[i])) || DEFAULT_RANK_EMOJIS[i];
}

/** The full 1..8 rank-badge array (saved overrides on top of defaults). */
function rankEmojis() {
  const saved = load().rankEmojis;
  return DEFAULT_RANK_EMOJIS.map((d, i) => (saved[i] && String(saved[i])) || d);
}

/** The logo emoji for a chain id (saved override → default → fallback). */
function chainLogo(chain) {
  const saved = load().chainLogos;
  return (saved[chain] && String(saved[chain])) || DEFAULT_CHAIN_LOGOS[chain] || FALLBACK_LOGO;
}

/** Chains in board order, each with its current logo + label (for the editor). */
function chainList() {
  return CHAIN_ORDER.filter((id) => chainOf(id)).map((id) => ({
    id,
    label: chainOf(id).label,
    logo: chainLogo(id),
  }));
}

async function setRankEmoji(pos, emoji) {
  if (pos < 1 || pos > RANK_SLOTS) throw new Error(`rank must be 1–${RANK_SLOTS}`);
  const c = load();
  const arr = rankEmojis(); // start from the fully-resolved current set
  arr[pos - 1] = String(emoji).trim();
  c.rankEmojis = arr;
  await saveJSON(FILE, c);
  return c.rankEmojis;
}

async function setChainLogo(chain, emoji) {
  const c = load();
  c.chainLogos = { ...c.chainLogos, [chain]: String(emoji).trim() };
  await saveJSON(FILE, c);
  return c.chainLogos;
}

async function reset() {
  await saveJSON(FILE, { chainLogos: {}, rankEmojis: [] });
}

module.exports = {
  RANK_SLOTS,
  rankBadge,
  rankEmojis,
  chainLogo,
  chainList,
  setRankEmoji,
  setChainLogo,
  reset,
  DEFAULT_RANK_EMOJIS,
};
