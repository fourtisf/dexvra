// Admin-editable look of the pinned "Dexvra Trending" board: the per-chain logo
// emoji and the rank badges 1–10. Persisted so the operator tunes them from
// @dexvraadminbot with no redeploy; trendingPoster reads get() fresh each cycle.
//
// PREMIUM EMOJI: the built-in defaults are premium-emoji MARKUP
// ("[1️⃣](emoji/<id>)", see config/premiumEmoji.js) wherever a verified id
// exists, so the board looks premium out of the box — no per-slot admin setup,
// the same way fourtis' board does it. Slots with no verified id (rank 10, most
// L2s) stay plain unicode and remain fully settable from the admin bot.
const { loadJSONSync, saveJSON } = require("../helpers/persist");
const { CHAIN_ORDER, chainOf } = require("../config/chains");
const pe = require("../config/premiumEmoji");

const FILE = "trendingBoard.json";

// Rank badges 1..10 (index 0 = rank 1) — the board shows up to 10 tokens per
// chain, so every slot has an editable badge. Ranks 11+ fall back to "11." etc.
const DEFAULT_RANK_EMOJIS = pe.RANK_CHARS.map((_, i) => pe.rankDefault(i + 1));
const RANK_SLOTS = DEFAULT_RANK_EMOJIS.length; // 10 editable slots

// Per-chain logo emoji. A chain with a verified premium id (premiumEmoji.js)
// defaults to that; the rest keep a sensible brand-ish unicode default. Any
// chain not listed at all falls back to 🔹.
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

/** The built-in badge for a rank: premium markup when we have an id for it. */
function defaultRank(pos) {
  return DEFAULT_RANK_EMOJIS[pos - 1] || "";
}
/** The built-in logo for a chain: premium markup → unicode default → 🔹. */
function defaultChainLogo(chain) {
  return pe.chainDefault(chain) || DEFAULT_CHAIN_LOGOS[chain] || FALLBACK_LOGO;
}

// Values that are NOT operator intent — they're a built-in default this code
// once shipped, so they must not shadow a newer (premium) default. Covers the
// resolved-array save shape of setRankEmoji(): setting rank 1 also writes the
// then-current defaults into ranks 2–10, and those plain chars would otherwise
// look like 10 deliberate overrides forever.
const LEGACY_RANK_DEFAULTS = ["🥇", "🥈", "🥉", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"];
function isBuiltinRank(pos, value) {
  const v = String(value || "").trim();
  if (!v) return true;
  const d = defaultRank(pos);
  return v === d || v === pe.charOf(d) || v === LEGACY_RANK_DEFAULTS[pos - 1];
}
function isBuiltinChainLogo(chain, value) {
  const v = String(value || "").trim();
  if (!v) return true;
  const d = defaultChainLogo(chain);
  return v === d || v === pe.charOf(d) || v === DEFAULT_CHAIN_LOGOS[chain];
}

function load() {
  const c = loadJSONSync(FILE, {}) || {};
  const raw = Array.isArray(c.rankEmojis) ? c.rankEmojis : [];
  // Keep ONLY slots that differ from a built-in default as real overrides (empty
  // otherwise). This is what drives the ✅/▫️ marker — and it migrates older
  // saves that stored the whole RESOLVED set (defaults baked in), which would
  // otherwise light up every slot as "custom" AND block the premium defaults.
  const rankEmojis = raw.map((v, i) => {
    const s = v == null ? "" : String(v).trim();
    return s && !isBuiltinRank(i + 1, s) ? s : null;
  });
  const savedLogos = c.chainLogos && typeof c.chainLogos === "object" ? c.chainLogos : {};
  const chainLogos = {};
  for (const [chain, v] of Object.entries(savedLogos)) {
    const s = v == null ? "" : String(v).trim();
    if (s && !isBuiltinChainLogo(chain, s)) chainLogos[chain] = s;
  }
  return { chainLogos, rankEmojis };
}

// A badge/logo may be stored as PLAIN emoji ("🥇") or as premium-emoji MARKUP
// ("[🥇](emoji/5440539497383087970)") — the latter renders as a real premium
// emoji on the board (via GramJS). rankBadge()/chainLogo() return the stored
// fragment (fed straight into the board's markup); displayEmoji() strips it back
// to the plain fallback char for the admin editor's buttons/preview.
function displayEmoji(frag) {
  return String(frag == null ? "" : frag).replace(/\[([^\]]+)\]\(emoji\/\d+\)/g, "$1");
}

// These values are spliced VERBATIM into the board's markup, so anything that
// isn't a premium-emoji fragment gets its markup characters stripped — otherwise
// a stored "[tap](https://…)" would render as a link where a rank badge belongs.
// Enforced on write AND on read (a legacy or hand-edited data file must not be
// able to inject markup into a public channel post).
const PREMIUM_FRAG_RE = /^\[[^\]\n]+\]\(emoji\/\d+\)$/;
function sanitizeFragment(v) {
  const s = String(v == null ? "" : v).trim();
  if (!s || PREMIUM_FRAG_RE.test(s)) return s;
  return s.replace(/[[\]()`*]/g, "").trim();
}

// Resolution against an ALREADY-loaded config, so a caller that needs many
// slots (the editor keyboards, premiumCoverage) reads the store once instead of
// once per slot. A saved PLAIN emoji is promoted to its premium twin when one is
// known, so an operator who typed 1️⃣ before premium defaults existed still gets
// the animated badge without re-setting anything.
function resolveRank(cfg, pos) {
  const v = sanitizeFragment(cfg.rankEmojis[pos - 1]);
  return v ? pe.promote(v) : defaultRank(pos);
}
function resolveChainLogo(cfg, chain) {
  const v = sanitizeFragment(cfg.chainLogos[chain]);
  return v ? pe.promoteChain(chain, v) : defaultChainLogo(chain);
}

/** The rank badge for a 1-based position (1..). 1–10 are configurable; 11+ are "N.". */
function rankBadge(pos) {
  if (pos > RANK_SLOTS) return `${pos}.`;
  return resolveRank(load(), pos);
}

/** The full 1..10 rank-badge array (saved overrides on top of defaults). */
function rankEmojis() {
  const cfg = load();
  return DEFAULT_RANK_EMOJIS.map((_, i) => resolveRank(cfg, i + 1));
}

/** The logo emoji for a chain id (saved override → default → fallback). */
function chainLogo(chain) {
  return resolveChainLogo(load(), chain);
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
/** Will this rank badge render as a real (animated) premium emoji? */
function isRankPremium(pos) {
  return pe.isPremium(rankBadge(pos));
}
/** Will this chain logo render as a real (animated) premium emoji? */
function isChainPremium(chain) {
  return pe.isPremium(chainLogo(chain));
}

/** How many board slots currently carry a premium emoji (for the editor's
 *  readiness line): { premium, total } across ranks 1–10 + every chain. */
function premiumCoverage() {
  const cfg = load();
  const chains = CHAIN_ORDER.filter((id) => chainOf(id));
  const ranks = DEFAULT_RANK_EMOJIS.map((_, i) => pe.isPremium(resolveRank(cfg, i + 1)));
  const logos = chains.map((id) => pe.isPremium(resolveChainLogo(cfg, id)));
  return {
    premium: [...ranks, ...logos].filter(Boolean).length,
    total: ranks.length + logos.length,
    ranksPremium: ranks.filter(Boolean).length,
    ranksTotal: ranks.length,
    chainsPremium: logos.filter(Boolean).length,
    chainsTotal: logos.length,
  };
}

/** Chains in board order, each with its current logo + label + whether the
 *  operator has customised it (for the editor's ✅/▫️ marker) and whether it
 *  renders premium (💎). */
function chainList() {
  const cfg = load();
  return CHAIN_ORDER.filter((id) => chainOf(id)).map((id) => {
    const logo = resolveChainLogo(cfg, id);
    return {
      id,
      label: chainOf(id).label,
      logo,
      custom: Boolean(cfg.chainLogos[id]),
      premium: pe.isPremium(logo),
    };
  });
}

async function setRankEmoji(pos, emoji) {
  if (pos < 1 || pos > RANK_SLOTS) throw new Error(`rank must be 1–${RANK_SLOTS}`);
  const c = load();
  // Store ONLY real overrides (a slot left on its default stays null) so a
  // future premium default reaches every untouched slot. The old shape wrote the
  // whole resolved array and froze the defaults of the day into the file.
  const arr = Array.from({ length: RANK_SLOTS }, (_, i) => c.rankEmojis[i] || null);
  const v = sanitizeFragment(emoji);
  arr[pos - 1] = !v || isBuiltinRank(pos, v) ? null : v;
  c.rankEmojis = arr;
  await saveJSON(FILE, c);
  return c.rankEmojis;
}

async function setChainLogo(chain, emoji) {
  const c = load();
  const v = sanitizeFragment(emoji);
  const next = { ...c.chainLogos };
  if (!v || isBuiltinChainLogo(chain, v)) delete next[chain];
  else next[chain] = v;
  c.chainLogos = next;
  await saveJSON(FILE, c);
  return c.chainLogos;
}

/** Clear every override — the board falls back to the built-in (premium) look. */
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
  isRankPremium,
  isChainPremium,
  premiumCoverage,
  setRankEmoji,
  setChainLogo,
  reset,
  DEFAULT_RANK_EMOJIS,
};
