// Admin-editable look of the pinned "Dexvra Trending" board: the per-chain logo
// emoji and the rank badges 1–10. Persisted so the operator tunes them from
// @dexvraadminbot with no redeploy; trendingPoster reads get() fresh each cycle.
const { loadJSONSync, saveJSON } = require("../helpers/persist");
const { CHAIN_ORDER, chainOf } = require("../config/chains");

const FILE = "trendingBoard.json";

// Rank badges 1..10 (index 0 = rank 1) — the board shows up to 10 tokens per
// chain, so every slot has an editable badge. Ranks 11+ fall back to "11." etc.
const DEFAULT_RANK_EMOJIS = ["🥇", "🥈", "🥉", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"];
const RANK_SLOTS = DEFAULT_RANK_EMOJIS.length; // 10 editable slots

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
  const raw = Array.isArray(c.rankEmojis) ? c.rankEmojis : [];
  // Keep ONLY slots that differ from the built-in default as real overrides
  // (empty otherwise). This is what drives the ✅/▫️ marker — and it migrates
  // older saves that stored the whole RESOLVED set (defaults baked in), which
  // would otherwise light up every slot as "custom".
  const rankEmojis = raw.map((v, i) => {
    const s = v == null ? "" : String(v).trim();
    return s && s !== DEFAULT_RANK_EMOJIS[i] ? s : null;
  });
  return {
    chainLogos: c.chainLogos && typeof c.chainLogos === "object" ? c.chainLogos : {},
    rankEmojis,
  };
}

// A badge/logo may be stored as PLAIN emoji ("🥇") or as premium-emoji MARKUP
// ("[🥇](emoji/5440539497383087970)") — the latter renders as a real premium
// emoji on the board (via GramJS). rankBadge()/chainLogo() return the stored
// fragment as-is (fed straight into the board's markup); displayEmoji() strips
// it back to the plain fallback char for the admin editor's buttons/preview.
function displayEmoji(frag) {
  return String(frag == null ? "" : frag).replace(/\[([^\]]+)\]\(emoji\/\d+\)/g, "$1");
}

/** The rank badge for a 1-based position (1..). 1–10 are configurable; 11+ are "N.". */
function rankBadge(pos) {
  if (pos > RANK_SLOTS) return `${pos}.`;
  const saved = load().rankEmojis;
  const i = pos - 1;
  return (saved[i] && String(saved[i])) || DEFAULT_RANK_EMOJIS[i];
}

/** The full 1..10 rank-badge array (saved overrides on top of defaults). */
function rankEmojis() {
  const saved = load().rankEmojis;
  return DEFAULT_RANK_EMOJIS.map((d, i) => (saved[i] && String(saved[i])) || d);
}

/** The logo emoji for a chain id (saved override → default → fallback). */
function chainLogo(chain) {
  const saved = load().chainLogos;
  return (saved[chain] && String(saved[chain])) || DEFAULT_CHAIN_LOGOS[chain] || FALLBACK_LOGO;
}

/** Has the admin set a custom badge for this rank (vs the built-in default)?
 *  Drives the ✅/▫️ marker in the editor so the operator sees what's done. */
function isRankCustom(pos) {
  const v = load().rankEmojis[pos - 1];
  return !!(v && String(v).trim());
}
/** Has the admin set a custom logo for this chain (vs the built-in default)? */
function isChainCustom(chain) {
  const v = load().chainLogos[chain];
  return !!(v && String(v).trim());
}

/** Chains in board order, each with its current logo + label + whether the
 *  operator has customised it (for the editor's ✅/▫️ marker). */
function chainList() {
  return CHAIN_ORDER.filter((id) => chainOf(id)).map((id) => ({
    id,
    label: chainOf(id).label,
    logo: chainLogo(id),
    custom: isChainCustom(id),
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
  displayEmoji,
  isRankCustom,
  isChainCustom,
  setRankEmoji,
  setChainLogo,
  reset,
  DEFAULT_RANK_EMOJIS,
};
