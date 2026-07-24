// Auto-Trending — keeps the Trending board alive between PAID slots. When the
// operator enables it, it periodically tops the featured set up to a target by
// promoting RANDOM eligible listings for a RANDOM duration (hard-capped at 18h,
// never 24/48), at RANDOM intervals — so trending never looks empty and slots
// that expire get auto-refilled. Auto slots carry no tier, so paid tiers always
// sort ABOVE them on the board. Everything is tunable from @dexvraadminbot; the
// loop re-reads config each cycle, so changes apply without a restart.
const { loadJSONSync, saveJSON } = require("../helpers/persist");
const api = require("../api/dexvra");
const log = require("../helpers/logger");

const FILE = "autoTrend.json";
const DEFAULTS = {
  enabled: false,
  minHours: 3,
  maxHours: 18, // HARD CAP — deliberately never 24 or 48
  minGapMin: 20, // random wait between top-ups
  maxGapMin: 120,
  target: 8, // keep at least this many tokens featured (across all chains)
};
// Sanity rails so a fat-finger can't set a 48h run or a runaway target.
const HARD = { hoursMin: 1, hoursMax: 18, gapMin: 5, gapMax: 1440, targetMin: 1, targetMax: 50 };

function clampInt(v, lo, hi, fb) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : fb;
}

/** Current config, defaults applied and every value forced within its rails. */
function get() {
  const c = loadJSONSync(FILE, {}) || {};
  const g = { ...DEFAULTS };
  if (typeof c.enabled === "boolean") g.enabled = c.enabled;
  g.minHours = clampInt(c.minHours, HARD.hoursMin, HARD.hoursMax, DEFAULTS.minHours);
  g.maxHours = clampInt(c.maxHours, HARD.hoursMin, HARD.hoursMax, DEFAULTS.maxHours);
  if (g.maxHours < g.minHours) g.maxHours = g.minHours; // keep the range valid
  g.minGapMin = clampInt(c.minGapMin, HARD.gapMin, HARD.gapMax, DEFAULTS.minGapMin);
  g.maxGapMin = clampInt(c.maxGapMin, HARD.gapMin, HARD.gapMax, DEFAULTS.maxGapMin);
  if (g.maxGapMin < g.minGapMin) g.maxGapMin = g.minGapMin;
  g.target = clampInt(c.target, HARD.targetMin, HARD.targetMax, DEFAULTS.target);
  return g;
}

/** Patch any subset of the config; persists and returns the clamped result. */
async function set(patch = {}) {
  const next = { ...get() };
  if (typeof patch.enabled === "boolean") next.enabled = patch.enabled;
  for (const k of ["minHours", "maxHours", "minGapMin", "maxGapMin", "target"]) {
    if (patch[k] != null) next[k] = patch[k];
  }
  await saveJSON(FILE, next);
  return get();
}

async function reset() {
  await saveJSON(FILE, { ...DEFAULTS });
  return get();
}

/** One top-up pass: promote random eligible listings until `target` are featured.
 *  `rng` is injectable so tests are deterministic. Returns how many were promoted.
 *  Never throws — a hiccup must not take down the service loop. */
async function runOnce({ rng = Math.random } = {}) {
  const cfg = get();
  if (!cfg.enabled) return 0;
  let listings;
  try {
    listings = await api.getListings();
  } catch (e) {
    log.debug(`[autotrend] listings: ${e.message}`);
    return 0;
  }
  const now = Date.now();
  const isFeatured = (r) => r.status === "approved" && r.trendingRank != null && (!r.trendExp || r.trendExp > now);
  const featured = listings.filter(isFeatured);
  const need = cfg.target - featured.length;
  if (need <= 0) return 0;

  // Eligible = approved but not currently featured. Shuffle for variety.
  const eligible = listings.filter((r) => r.status === "approved" && !isFeatured(r));
  for (let i = eligible.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [eligible[i], eligible[j]] = [eligible[j], eligible[i]];
  }
  let promoted = 0;
  for (const r of eligible.slice(0, need)) {
    // Random duration in [minHours, maxHours] — different per token, so the
    // slots expire at staggered (random) times and refill naturally.
    const hours = cfg.minHours + Math.floor(rng() * (cfg.maxHours - cfg.minHours + 1));
    try {
      await api.bookTrending(r.chain, r.address, hours);
      promoted++;
      log.info(`[autotrend] promoted ${r.chain}/${String(r.address).slice(0, 8)}… (${r.sym || "?"}) for ${hours}h`);
    } catch (e) {
      log.debug(`[autotrend] bookTrending ${r.sym}: ${e.message}`);
    }
  }
  return promoted;
}

const randInt = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo + 1));

/** Self-rescheduling loop with a RANDOM gap each cycle. Config is re-read every
 *  cycle, so enabling/tuning it from the admin bot applies without a restart.
 *  While disabled it still ticks (every 10 min) so an enable is picked up. */
function start() {
  let timer = null;
  let stopped = false;
  const schedule = () => {
    if (stopped) return;
    const cfg = get();
    const gapMin = cfg.enabled ? randInt(cfg.minGapMin, cfg.maxGapMin) : 10;
    timer = setTimeout(tick, gapMin * 60 * 1000);
  };
  const tick = async () => {
    try {
      await runOnce();
    } catch (e) {
      log.debug(`[autotrend] ${e.message}`);
    }
    schedule();
  };
  timer = setTimeout(tick, 60 * 1000); // first pass ~1 min after boot
  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}

module.exports = { get, set, reset, runOnce, start, DEFAULTS, HARD };
