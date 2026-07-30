// Auto-Listing — free, automatic listings for projects that climb past the
// operator's market-cap threshold (~$1M), discovered on DexScreener across every
// supported chain. Off by default; everything is tunable from @dexvraadminbot
// and the loop re-reads config each cycle, so changes apply without a restart.
//
// WHY THE TRIGGER IS PER-TOKEN AND RANDOM
// Listing everything the instant it prints $1,000,000 makes the feed read as
// machine-generated: every entry shows the same round number. So each token gets
// its OWN trigger somewhere in [minMcap, maxMcap] — one lists at $1.08M, the
// next at $1.42M — and because a scan lands minutes after the crossing, the
// recorded cap is a little past that. That is the whole point of the band.
//
// The trigger is DERIVED FROM THE ADDRESS, not rolled fresh each scan. A fresh
// roll would re-draw until one landed under the token's current cap, which
// converges on listing everything at the floor — exactly the behaviour we are
// trying to avoid. Hashing the address means a token has to genuinely climb to
// ITS number, and the number never moves.
//
// WHAT AN AUTO-LISTED TOKEN GETS is the operator's choice — see PACKAGES below:
// a plain free listing (default), an Xpress Listing, or Listing & Trending with
// a time-boxed slot on the board. Only the Xpress option hands out a real tier;
// the others use "FREE", which is not a package anyone can buy, so an auto
// listing can never be mistaken for (or dilute) a paid placement.
const crypto = require("node:crypto");
const { loadJSONSync, saveJSON } = require("../helpers/persist");
const ds = require("../dexscreener");
const api = require("../api/dexvra");
const post = require("../channels/post");
const fmt = require("../channels/format");
const { CHANNELS } = require("../config/constants");
const { sanitizeTicker } = require("../helpers/ticker");
const { chainOf } = require("../config/chains");
const log = require("../helpers/logger");

const FILE = "autoLister.json";
const STATE_FILE = "autoListerState.json";
const DAY_MS = 86_400_000;

const DEFAULTS = {
  enabled: false, // OFF until the operator turns it on — it publishes in public
  minMcap: 1_000_000, // the floor the operator asked for
  maxMcap: 1_500_000, // top of the random band → 1.1M / 1.4M listings
  maxMcapHard: 50_000_000, // past this it is an established token, not a find
  minLiq: 25_000, // a $1M cap on $300 of liquidity is not a $1M project
  minVol24: 50_000,
  minAgeHours: 6, // skip the first hours, where most rugs live
  maxPerDay: 12, // the channel/site must not read as a firehose
  maxPerRun: 3,
  maxLookupsPerRun: 40, // politeness toward the DexScreener API
  minGapMin: 25, // random wait between scans (never a fixed heartbeat)
  maxGapMin: 90,
  pkg: "free", // which package an auto listing gets — see PACKAGES
  trendHours: 12, // only used by the "trending" package
  postChannel: false, // list on the site only, until the operator says otherwise
};

// What an auto-listed token receives. The operator picks one; "free" is the
// default because it is the only option that cannot be confused with something
// somebody paid for.
//
//   free     — listed on the site with a "Free" badge. No tier, no trending.
//   xpress   — treated as an Xpress Listing: tier XPRESS, the Xpress post card.
//   trending — listed AND featured on the Trending board for `trendHours`,
//              with the Trending card as well. Tier stays FREE, so every paid
//              tier still sorts above it on the board.
const PACKAGES = {
  free: { label: "Free listing", tier: "FREE", trending: false },
  xpress: { label: "Xpress Listing", tier: "XPRESS", trending: false },
  trending: { label: "Listing & Trending", tier: "FREE", trending: true },
};
const pkgOf = (key) => PACKAGES[key] || PACKAGES.free;

// Rails: a fat-finger in the admin editor must not be able to list the whole
// market or spam the channel.
const HARD = {
  mcap: [10_000, 1_000_000_000],
  liq: [0, 100_000_000],
  vol: [0, 1_000_000_000],
  ageHours: [0, 720],
  perDay: [1, 100],
  perRun: [1, 25],
  lookups: [5, 200],
  gapMin: [5, 1440],
  trendHours: [1, 48],
};

function clampInt(v, [lo, hi], fb) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : fb;
}

/** Current config, defaults applied and every value forced within its rails. */
function get() {
  const c = loadJSONSync(FILE, {}) || {};
  const g = { ...DEFAULTS };
  for (const k of ["enabled", "postChannel"]) if (typeof c[k] === "boolean") g[k] = c[k];
  g.minMcap = clampInt(c.minMcap, HARD.mcap, DEFAULTS.minMcap);
  g.maxMcap = clampInt(c.maxMcap, HARD.mcap, DEFAULTS.maxMcap);
  if (g.maxMcap < g.minMcap) g.maxMcap = g.minMcap; // keep the band valid
  g.maxMcapHard = clampInt(c.maxMcapHard, HARD.mcap, DEFAULTS.maxMcapHard);
  if (g.maxMcapHard < g.maxMcap) g.maxMcapHard = g.maxMcap;
  g.minLiq = clampInt(c.minLiq, HARD.liq, DEFAULTS.minLiq);
  g.minVol24 = clampInt(c.minVol24, HARD.vol, DEFAULTS.minVol24);
  g.minAgeHours = clampInt(c.minAgeHours, HARD.ageHours, DEFAULTS.minAgeHours);
  g.maxPerDay = clampInt(c.maxPerDay, HARD.perDay, DEFAULTS.maxPerDay);
  g.maxPerRun = clampInt(c.maxPerRun, HARD.perRun, DEFAULTS.maxPerRun);
  g.maxLookupsPerRun = clampInt(c.maxLookupsPerRun, HARD.lookups, DEFAULTS.maxLookupsPerRun);
  g.minGapMin = clampInt(c.minGapMin, HARD.gapMin, DEFAULTS.minGapMin);
  g.maxGapMin = clampInt(c.maxGapMin, HARD.gapMin, DEFAULTS.maxGapMin);
  if (g.maxGapMin < g.minGapMin) g.maxGapMin = g.minGapMin;
  g.pkg = PACKAGES[c.pkg] ? c.pkg : DEFAULTS.pkg;
  g.trendHours = clampInt(c.trendHours, HARD.trendHours, DEFAULTS.trendHours);
  return g;
}

/** Patch any subset of the config; persists and returns the clamped result. */
async function set(patch = {}) {
  const next = { ...get() };
  for (const [k, v] of Object.entries(patch)) if (k in DEFAULTS && v != null) next[k] = v;
  await saveJSON(FILE, next);
  return get();
}

async function reset() {
  await saveJSON(FILE, { ...DEFAULTS });
  return get();
}

/** Forget EVERYTHING this service knows — what it auto-listed, today's count,
 *  and the ever-listed ledger below. The deliberate operator escape hatch
 *  ("🧹 Clear history"), used after wiping the site's listings so it can
 *  repopulate. Nothing else may clear the ledger. */
async function resetState() {
  await saveJSON(STATE_FILE, { listed: {}, day: null, everListed: {} });
}

// ── State: what we already listed, and today's count ────────────────────────
//
// `everListed` is a PERMANENT ledger of every contract that has ever appeared
// on the site, whatever put it there. It exists because the other two guards
// both have holes: `state.listed` only knows this service's own picks, and the
// live `getListings()` set disappears the moment a row is deleted. Delete a
// listing on the site — including one somebody PAID for — and without this the
// auto-lister happily hands the same token back out for free on the next scan.
// Once a contract is in here it is never free-listed again.
const loadState = () => {
  const s = loadJSONSync(STATE_FILE, {}) || {};
  const obj = (v) => (v && typeof v === "object" ? v : {});
  return { listed: obj(s.listed), day: s.day || null, everListed: obj(s.everListed) };
};

/** Remember contracts as listed, forever. Called with everything currently on
 *  the site at the top of each scan, and by the paid-listing path the moment a
 *  purchase goes live — a token bought and then deleted before the next scan
 *  would otherwise never make it into the ledger at all. */
async function rememberListed(rows, now = Date.now()) {
  const list = (Array.isArray(rows) ? rows : [rows]).filter(Boolean);
  if (!list.length) return 0;
  const state = loadState();
  let added = 0;
  for (const r of list) {
    if (!r || !r.chain || !r.address) continue;
    const k = keyOf(r.chain, r.address);
    if (state.everListed[k]) continue;
    state.everListed[k] = now;
    added++;
  }
  if (added) await saveJSON(STATE_FILE, state).catch(() => {});
  return added;
}
const dayKey = (now) => new Date(now).toISOString().slice(0, 10);
const todayCount = (state, now) => (state.day && state.day.key === dayKey(now) ? state.day.n : 0);

/** Everything the service has auto-listed, newest first (for the admin panel). */
function history(limit = 10) {
  const { listed } = loadState();
  return Object.entries(listed)
    .map(([key, v]) => ({ key, ...(typeof v === "object" ? v : { at: v }) }))
    .sort((a, b) => (b.at || 0) - (a.at || 0))
    .slice(0, limit);
}

function stats(now = Date.now()) {
  const state = loadState();
  return {
    total: Object.keys(state.listed).length,
    today: todayCount(state, now),
    everListed: Object.keys(state.everListed).length,
  };
}

const keyOf = (chain, address) => `${chain}:${String(address).toLowerCase()}`;

/**
 * This token's own trigger market cap, stable for as long as the band is.
 * @see the header — derived from the address on purpose, never re-rolled.
 */
function triggerMcap(address, cfg = get()) {
  const span = Math.max(0, cfg.maxMcap - cfg.minMcap);
  if (!span) return cfg.minMcap;
  const h = crypto.createHash("sha1").update(String(address).toLowerCase()).digest();
  return cfg.minMcap + (h.readUInt32BE(0) % (span + 1));
}

/**
 * Why this token is NOT getting listed, or null when it qualifies. A single
 * function so every rejection is one readable reason in the log — "nothing was
 * listed today" is otherwise impossible to explain.
 */
function rejectReason(info, cfg, trigger, now = Date.now()) {
  if (!info) return "no market data";
  if (!sanitizeTicker(info.symbol)) return "no usable ticker";
  if (!info.name) return "no name";
  const mcap = Number(info.mcap) || 0;
  if (!mcap) return "no market cap";
  if (mcap < trigger) return `below its trigger ($${Math.round(mcap).toLocaleString("en-US")} < $${trigger.toLocaleString("en-US")})`;
  if (mcap > cfg.maxMcapHard) return `above the ceiling ($${Math.round(mcap).toLocaleString("en-US")})`;
  if ((Number(info.liq) || 0) < cfg.minLiq) return `thin liquidity ($${Math.round(info.liq || 0).toLocaleString("en-US")})`;
  if ((Number(info.vol24) || 0) < cfg.minVol24) return `low 24h volume ($${Math.round(info.vol24 || 0).toLocaleString("en-US")})`;
  if (info.pairCreatedAt && now - info.pairCreatedAt < cfg.minAgeHours * 3_600_000) {
    return `too new (${Math.round((now - info.pairCreatedAt) / 3_600_000)}h old)`;
  }
  return null;
}

/** The listing payload the site expects for an auto-listed token, shaped by the
 *  package the operator chose. */
function listingInput(chain, address, info, cfg = get(), now = Date.now()) {
  const p = pkgOf(cfg.pkg);
  const input = {
    chain,
    address,
    sym: sanitizeTicker(info.symbol),
    name: String(info.name).slice(0, 60),
    emoji: "🪙",
    // "FREE" is not a purchasable package (see lib/packages.ts) — only the
    // xpress package hands out a real tier, and only because the operator asked
    // for auto listings to BE Xpress listings.
    tier: p.tier,
    logoUrl: info.logoUrl && /^https:\/\//.test(info.logoUrl) ? info.logoUrl : undefined,
    website: info.website || undefined,
    twitter: info.twitter || undefined,
    telegram: info.telegram || undefined,
  };
  if (p.trending) {
    input.trendingRank = 1; // sub-order only; tier FREE keeps it under paid slots
    input.trendStart = now;
    input.trendExp = now + cfg.trendHours * 3_600_000;
  }
  return input;
}

/**
 * One scan. Returns how many tokens were listed. Never throws — a hiccup must
 * not take down the service loop. `deps` is injectable so tests don't touch the
 * network.
 */
async function runOnce({ tg, now = Date.now(), deps = {} } = {}) {
  const cfg = get();
  if (!cfg.enabled) return 0;
  const discover = deps.fetchDiscovery || ds.fetchDiscovery;
  const price = deps.fetchTokenInfo || ds.fetchTokenInfo;

  let state = loadState();
  let today = todayCount(state, now);
  if (today >= cfg.maxPerDay) {
    log.debug(`[autolist] daily cap reached (${today}/${cfg.maxPerDay})`);
    return 0;
  }

  let candidates;
  try {
    candidates = await discover();
  } catch (e) {
    log.debug(`[autolist] discovery: ${e.message}`);
    return 0;
  }
  if (!candidates.length) return 0;

  // Anything already on the site is off the table, however it got there.
  let known = new Set();
  try {
    const rows = await api.getListings();
    known = new Set(rows.map((r) => keyOf(r.chain, r.address)));
    // …and it stays off the table after it is gone. Fold today's listings into
    // the permanent ledger BEFORE picking anything, so a row deleted later can
    // never come back as a free auto-listing.
    const added = await rememberListed(rows, now);
    if (added) {
      state = loadState(); // rememberListed wrote through — re-read before use
      log.debug(`[autolist] ledger +${added} (${Object.keys(state.everListed).length} contracts remembered)`);
    }
  } catch (e) {
    // Without this list we could double-list a paying customer's token — that is
    // worse than skipping a cycle, so bail instead of guessing.
    log.debug(`[autolist] listings unavailable, skipping this scan: ${e.message}`);
    return 0;
  }

  let listedNow = 0;
  let lookups = 0;
  for (const c of candidates) {
    if (listedNow >= cfg.maxPerRun || today >= cfg.maxPerDay) break;
    if (lookups >= cfg.maxLookupsPerRun) break;
    const key = keyOf(c.chain, c.address);
    // Three separate reasons to leave it alone: this service already picked it,
    // it is on the site right now, or it EVER was. The third is the one that
    // stops a deleted (or previously paid-for) listing being handed back free.
    if (state.listed[key] || known.has(key) || state.everListed[key]) continue;
    if (!chainOf(c.chain)) continue;

    lookups++;
    const info = await price(c.chain, c.address).catch(() => null);
    const trigger = triggerMcap(c.address, cfg);
    const why = rejectReason(info, cfg, trigger, now);
    if (why) {
      log.debug(`[autolist] skip ${c.chain}/${c.address}: ${why}`);
      continue;
    }

    const input = listingInput(c.chain, c.address, info, cfg, now);
    let listing;
    try {
      listing = await api.createListing(input);
    } catch (e) {
      log.warn(`[autolist] createListing ${input.sym} (${c.chain}): ${e.message}`);
      continue;
    }
    if (!listing) continue;

    state.listed[key] = { at: now, sym: input.sym, mcap: Math.round(info.mcap), trigger };
    state.everListed[key] = state.everListed[key] || now;
    today += 1;
    listedNow += 1;
    state.day = { key: dayKey(now), n: today };
    await saveJSON(STATE_FILE, state).catch(() => {});
    log.info(
      `[autolist] listed ${input.sym} on ${c.chain} at $${Math.round(info.mcap).toLocaleString("en-US")} ` +
        `(its trigger was $${trigger.toLocaleString("en-US")}) as "${pkgOf(cfg.pkg).label}" — ` +
        `${today}/${cfg.maxPerDay} today`,
    );

    if (cfg.postChannel && tg) await announce(tg, c, info, input, cfg).catch(() => {});
  }
  return listedNow;
}

/** The banner/artwork for one of the two cards — same pipeline a paid listing
 *  uses, so an auto listing looks like every other post. */
function postMediaFor(kind, c, info, input) {
  const { postMedia } = require("../fulfillment");
  return postMedia(
    kind,
    {
      symbol: input.sym,
      name: input.name,
      chain: String(chainOf(c.chain) ? chainOf(c.chain).label : c.chain).toUpperCase(),
      price: info.priceUsd ? `$${Number(info.priceUsd).toPrecision(4)}` : "TBA",
      mcap: info.mcap ? `$${Math.round(info.mcap).toLocaleString("en-US")}` : null,
      links: { website: input.website, twitter: input.twitter, telegram: input.telegram },
    },
    null,
    null,
    input.logoUrl || "",
    null,
  );
}

/**
 * Channel post(s) for an auto listing, following the chosen package:
 *   free     → the listing card with NO tier badge (it wasn't bought, so it
 *              must not wear a package's colours)
 *   xpress   → the Xpress card, same as a paid Xpress listing
 *   trending → the listing card AND the Trending card in @dexvratrending
 */
async function announce(tg, c, info, input, cfg = get()) {
  const p = pkgOf(cfg.pkg);
  const coin = {
    name: input.name,
    symbol: input.sym,
    chain: c.chain,
    address: c.address,
    price: info.priceUsd,
    mcap: info.mcap,
    liq: info.liq,
    // Only the xpress package carries a tier into the post — that IS the
    // package. free/trending post without a badge.
    tier: p.tier === "XPRESS" ? "XPRESS" : undefined,
    links: { website: input.website, twitter: input.twitter, telegram: input.telegram },
  };
  try {
    // Same as a paid listing: create the token's animated custom emoji BEFORE
    // the card is rendered, or the post shows the plain fallback char where the
    // logo belongs (fmt.listingPost reads the pack id synchronously).
    await require("../tokenEmoji")
      .ensureFromUrl({ chain: c.chain, address: c.address, symbol: input.sym }, input.logoUrl)
      .catch(() => null);
    const media = await postMediaFor("listing", c, info, input).catch(() => null);
    // Same rule as a paid listing: it pins itself in the listing channel.
    const msg = await post.sendMedia(CHANNELS.listing, media, fmt.listingPost(coin), { pin: true });
    if (msg) log.info(`[autolist] posted ${input.sym} → ${CHANNELS.listing}/${msg.message_id}`);
    await post.mirrorToGroup(CHANNELS.listing, msg, { label: "auto-listing" });
    if (p.trending) {
      const tMedia = await postMediaFor("trending", c, info, input).catch(() => null);
      const tMsg = await post.sendMedia(CHANNELS.trending, tMedia, fmt.trendingPost(coin));
      if (tMsg) log.info(`[autolist] posted ${input.sym} → ${CHANNELS.trending}/${tMsg.message_id}`);
    }
  } catch (e) {
    log.warn(`[autolist] post ${input.sym}: ${e.message}`);
  }
}

/**
 * Start the loop. Self-reschedules with a RANDOM gap (never setInterval): a
 * fixed heartbeat puts every listing on the same minute of the hour, which is
 * the other half of looking machine-run.
 */
function start(tg, { rng = Math.random } = {}) {
  let timer = null;
  let stopped = false;
  const schedule = () => {
    if (stopped) return;
    const cfg = get();
    const mins = cfg.minGapMin + rng() * (cfg.maxGapMin - cfg.minGapMin);
    log.debug(`[autolist] next scan in ${mins.toFixed(1)}min`);
    timer = setTimeout(run, mins * 60_000);
    if (timer.unref) timer.unref();
  };
  const run = async () => {
    try {
      await runOnce({ tg });
    } catch (e) {
      log.debug(`[autolist] ${e.message}`);
    }
    schedule();
  };
  // Random boot delay for the same reason — a restart must not put every scan
  // back on the same clock.
  timer = setTimeout(run, (30 + rng() * 120) * 1000);
  if (timer.unref) timer.unref();
  return {
    stop: () => {
      stopped = true;
      clearTimeout(timer);
    },
  };
}

module.exports = {
  get,
  set,
  reset,
  resetState,
  rememberListed,
  start,
  runOnce,
  stats,
  history,
  triggerMcap,
  rejectReason,
  listingInput,
  PACKAGES,
  pkgOf,
  DEFAULTS,
};
