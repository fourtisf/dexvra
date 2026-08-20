// Auto-Trending — keeps the Trending board alive between PAID slots. When the
// operator enables it, it periodically tops the featured set up to a target by
// promoting RANDOM eligible listings for a RANDOM duration (hard-capped at 18h,
// never 24/48), at RANDOM intervals — so trending never looks empty and slots
// that expire get auto-refilled. Auto slots carry no tier, so paid tiers always
// sort ABOVE them on the board. Everything is tunable from @dexvraadminbot; the
// loop re-reads config each cycle, so changes apply without a restart.
const { loadJSONSync, saveJSON } = require("../helpers/persist");
const api = require("../api/dexvra");
// Imported as a MODULE, not destructured: a captured binding cannot be swapped,
// and the price source has to be stubbable to test the ranking at all.
const market = require("../marketdata");
const { CHAINS } = require("../config/chains");
const ops = require("../helpers/opsThrottle");
const log = require("../helpers/logger");

const FILE = "autoTrend.json";
/**
 * How far down a token may be and still be promoted to reach the per-chain
 * MINIMUM (percent, 24h). Not a setting: it exists only to keep one incident
 * impossible — a board carrying $Z at −99.94% on a $1,648 cap — while letting
 * the ordinary case through, which is a chain whose spares are down a percent
 * or two on a flat day. Above the minimum, the operator's own `minGainPct` is
 * what decides, and this is not consulted.
 */
const FLOOR_FILL_MAX_DROP = 15;
const DEFAULTS = {
  enabled: false,
  minHours: 3,
  maxHours: 18, // HARD CAP — deliberately never 24 or 48
  minGapMin: 20, // random wait between top-ups
  maxGapMin: 120,
  // PER CHAIN, not board-wide. A single global target sounded equivalent and was
  // not: the eligible pool is dominated by whichever network has the most
  // listings, so one shuffle across all of them put 5 Solana tokens on the board
  // and left BSC, Ethereum and Base with one each — and Robinhood with none at
  // all. The board GROUPS by chain, so a chain with nothing featured renders as
  // nothing, and the operator sees a Solana board with three footnotes.
  // A RANGE, and the target is rolled per chain. One fixed number made every
  // chain publish exactly the same count, for ever — five rows, five rows, five
  // rows — which reads as a generated list rather than a board. The operator's
  // call: "min 5 max 8 harus random per chain".
  //
  // The FLOOR is what triggers a top-up; the target rolled for that top-up is
  // anywhere in [min, max]. Re-rolling on every cycle regardless would converge
  // on max and delete the randomness — nothing ever takes a slot away, only
  // expiry lowers a count, so a chain would ratchet up to the highest number it
  // ever rolled and stay there.
  perChainMin: 5,
  perChainMax: 8,
  // A "top gainers" board that carries a token down 99.94% at a $1,648 market
  // cap is not a top-gainers board. Ranking alone could not prevent that: with
  // five slots and five candidates, sorting still promotes the worst of them.
  // A candidate must be at least this far UP to be auto-promoted. Unpriced
  // tokens are exempt — Robinhood has no indexer, and judging them by a number
  // nobody can read would mean never filling that chain at all.
  minGainPct: 0,
  // ── When a chain has nothing left to promote ──
  // Auto-trend promotes what is LISTED, so a chain with three listings caps out
  // at three rows however often it runs. Ethereum published 3 and Base 2
  // against a target of 5, every cycle, and the only trace was a log line
  // telling the operator to "list more tokens on those chains" — which they
  // cannot do from Telegram. ON, because a board that stays short is the state
  // being fixed; the floors below are what keep it from listing noise.
  fillFromMarket: true,
  fillMinMcap: 5_000_000, // a "big coin" floor — below this it is a find, not a filler
  fillMinLiq: 100_000,
  fillMaxPerCycle: 3, // per CHAIN per cycle: a shortfall is filled over a few passes, not in one burst
  // The networks auto-trending keeps alive. Everything else is paid-only: a
  // chain nobody has listed on cannot be filled, and pretending otherwise just
  // logs a failure every cycle.
  chains: ["solana", "bsc", "ethereum", "base", "robinhood"],
  // ── Public announcement of an auto-promotion ──
  // A slot lasts 3–18h and the target is 8, so refills alone produce roughly
  // 8 ÷ 10.5h × 24 ≈ 18 promotions a day. Announcing every one would bury the
  // paid posts (and the deep link a buyer was just DM'd as proof of delivery),
  // so the caps below are the feature, not decoration.
  // The card is IDENTICAL to a paid trending post — same post_trending
  // template, same artwork, same badge (operator's explicit call, 2026-07-25:
  // "templatenya harus sama dengan trending yang sudah di set, nothing beda").
  // The rails below are what keeps that from drowning the paid posts.
  announce: false, // OFF until the operator turns it on — it publishes in public
  // A token on the board WITHOUT a post is a product nobody can see, so every
  // promotion is announced — the rails below space them out, they no longer
  // decide which ones happen. That distinction is the whole design: a
  // promotion that cannot post right now is QUEUED, not dropped.
  //
  // The arithmetic they have to survive: 5 chains × 5 slots = 25 live, each
  // lasting 3–18h (~10.5h average), so steady state is roughly 57 promotions a
  // day. A 60-minute gap could clear 24 of them — the queue would grow forever.
  announcePerDay: 100, // a safety valve, not a policy: 0 = announce nothing
  announceGapMin: 15, // spacing between two auto posts
  announceCooldownDays: 7, // per token: never announce the same one twice in a week
};

// NOTE: there is deliberately NO tier gate in this file. Operator's rule, in
// their words: every listed token can get trending, free or paid — Xpress
// included. An earlier version excluded Xpress from the free fill to protect an
// upsell, which left chains visibly stuck and was not what was wanted. The paid
// flow (handlers/trending.js → fulfillTrending) has never had a tier check
// either. Do not reintroduce one in either place.
// Sanity rails so a fat-finger can't set a 48h run or a runaway target.
const HARD = {
  hoursMin: 1,
  hoursMax: 18,
  gapMin: 5,
  gapMax: 1440,
  // Bounds on the SETTING (not the setting itself, which is perChainMin/Max).
  perChainFloor: 0, // 0 = leave this chain to paid slots only
  perChainCeil: 20,
  fillMinMcapMin: 100_000,
  fillMinMcapMax: 5_000_000_000,
  fillMinLiqMin: 0,
  fillMinLiqMax: 50_000_000,
  fillMaxPerCycleMin: 0,   // 0 = never fill from the market
  fillMaxPerCycleMax: 10,
  minGainPct: [-100, 500],
  // The old ceiling was 24/day, which is BELOW the ~57 promotions a day that 5
  // chains × 5 slots actually produce — so "announce everything" was
  // unreachable no matter how the panel was set.
  announcePerDay: [0, 200],
  announceGapMin: [5, 1440],
  announceCooldownDays: [0, 90],
};

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
  // MIGRATION: an install that predates the range has `perChain` stored, and a
  // stored value beats a shipped default — so it becomes the FLOOR rather than
  // being silently replaced. The ceiling then defaults to the shipped 8, or to
  // the floor if the operator had deliberately set a higher number.
  // ⚠️ `undefined`, never `null`: clampInt does Number(v), and Number(null) is 0
  // — a finite 0, which clamps to the FLOOR instead of falling back to the
  // default. A fresh install came out with a per-chain floor of zero, i.e. a
  // board that never fills itself, and nothing errored. Same trap the launchpad
  // env reader hit with Number('').
  const legacy = Number.isFinite(Number(c.perChain)) ? Number(c.perChain) : undefined;
  g.perChainMin = clampInt(
    c.perChainMin != null ? c.perChainMin : legacy,   // both absent → undefined → the default
    HARD.perChainFloor, HARD.perChainCeil, DEFAULTS.perChainMin,
  );
  g.perChainMax = clampInt(
    c.perChainMax != null ? c.perChainMax : Math.max(g.perChainMin, DEFAULTS.perChainMax),
    HARD.perChainFloor, HARD.perChainCeil, DEFAULTS.perChainMax,
  );
  // A max under the min is a range that can never be satisfied; the floor wins,
  // because it is the number the operator set to keep the board from looking
  // empty.
  if (g.perChainMax < g.perChainMin) g.perChainMax = g.perChainMin;
  g.minGainPct = clampInt(c.minGainPct, ...HARD.minGainPct, DEFAULTS.minGainPct);
  g.fillFromMarket = c.fillFromMarket !== false;
  g.fillMinMcap = clampInt(c.fillMinMcap, HARD.fillMinMcapMin, HARD.fillMinMcapMax, DEFAULTS.fillMinMcap);
  g.fillMinLiq = clampInt(c.fillMinLiq, HARD.fillMinLiqMin, HARD.fillMinLiqMax, DEFAULTS.fillMinLiq);
  g.fillMaxPerCycle = clampInt(c.fillMaxPerCycle, HARD.fillMaxPerCycleMin, HARD.fillMaxPerCycleMax, DEFAULTS.fillMaxPerCycle);
  // An unknown chain id would be topped up forever with nothing eligible, so the
  // list is filtered against the real chain table rather than trusted.
  if (Array.isArray(c.chains)) {
    const ids = c.chains.map((x) => String(x).toLowerCase()).filter((x) => CHAINS[x]);
    if (ids.length) g.chains = [...new Set(ids)];
  }
  if (typeof c.announce === "boolean") g.announce = c.announce;
  // One-time migration. These two were saved under the OLD policy, where the
  // rails decided WHICH promotions got announced and most were dropped. Under
  // the current one — every trending token gets its post — a stored 3/day and
  // 60min are not a preference, they are a leftover that makes the policy
  // impossible: three posts a day against ~57 promotions, and the rest sit in
  // the queue until their slots expire. A value that still equals the old
  // default is treated as never-set.
  const OLD_PER_DAY = 3;
  const OLD_GAP_MIN = 60;
  const perDay = c.announcePerDay === OLD_PER_DAY ? undefined : c.announcePerDay;
  const gapMin = c.announceGapMin === OLD_GAP_MIN ? undefined : c.announceGapMin;
  g.announcePerDay = clampInt(perDay, ...HARD.announcePerDay, DEFAULTS.announcePerDay);
  g.announceGapMin = clampInt(gapMin, ...HARD.announceGapMin, DEFAULTS.announceGapMin);
  g.announceCooldownDays = clampInt(c.announceCooldownDays, ...HARD.announceCooldownDays, DEFAULTS.announceCooldownDays);
  return g;
}

/** Patch any subset of the config; persists and returns the clamped result. */
async function set(patch = {}) {
  const next = { ...get() };
  if (typeof patch.enabled === "boolean") next.enabled = patch.enabled;
  if (typeof patch.announce === "boolean") next.announce = patch.announce;
  // A boolean that only ever reached `get()` and never the FILE is a setting
  // that reverts on the next read — the toggle would report ON and the loop
  // would keep the old value.
  if (typeof patch.fillFromMarket === "boolean") next.fillFromMarket = patch.fillFromMarket;
  for (const k of ["minHours", "maxHours", "minGapMin", "maxGapMin", "perChainMin", "perChainMax", "minGainPct", "fillMinMcap", "fillMinLiq", "fillMaxPerCycle", "announcePerDay", "announceGapMin", "announceCooldownDays"]) {
    if (patch[k] != null) next[k] = patch[k];
  }
  if (Array.isArray(patch.chains)) next.chains = patch.chains;
  await saveJSON(FILE, next);
  return get();
}

async function reset() {
  await saveJSON(FILE, { ...DEFAULTS });
  return get();
}

// ── Announce state (persisted, shared by both processes via DATA_DIR) ───────
// autoTrend had no state file at all, so nothing stopped the same token being
// re-promoted — and, once we publish, re-ANNOUNCED — every few hours as slots
// expire and refill. This is that memory.
//
// `pending` is the cross-process hand-off: forceChain() runs inside the ADMIN
// bot, and channels/post.js is only attach()ed in the MAIN bot (src/bot.js), so
// the admin process cannot post at all. It queues here instead and the main
// process drains it seconds later — the same shape as the force-post job store.
const STATE_FILE = "autoTrendState.json";
const keyOf = (chain, address) => `${chain}:${String(address).toLowerCase()}`;
const dayKey = (now) => new Date(now).toISOString().slice(0, 10);

function loadState() {
  const s = loadJSONSync(STATE_FILE, {}) || {};
  return {
    announced: s.announced && typeof s.announced === "object" ? s.announced : {},
    day: s.day || null,
    lastAt: Number(s.lastAt) || 0,
    pending: Array.isArray(s.pending) ? s.pending : [],
    // Per-chain "how long has this been under its minimum" — see trendingWatch.
    boardWatch: s.boardWatch && typeof s.boardWatch === "object" ? s.boardWatch : {},
  };
}
const saveState = (st) => saveJSON(STATE_FILE, st).catch(() => {});
const todayCount = (st, now) => (st.day && st.day.key === dayKey(now) ? st.day.n : 0);

/** Forget every announcement — the operator's "start fresh" for the cooldowns. */
async function resetAnnounceState() {
  await saveJSON(STATE_FILE, { announced: {}, day: null, lastAt: 0, pending: [] });
}

/** Why this token is NOT getting announced, or null when it may be. One
 *  function so every refusal is a readable log line rather than a silent skip. */
// Refusals that are a matter of TIME. A promotion blocked by one of these has
// not been rejected — it is waiting, and the queue must hold on to it. Anything
// else ("off", "already announced this week") is a real no.
const RETRYABLE = /^(daily cap reached|too soon)/;
const isRetryable = (why) => !!why && RETRYABLE.test(why);

function announceReason(row, st, cfg, now = Date.now()) {
  if (!cfg.announce) return "announcements are off";
  if (!row || !row.chain || !row.address) return "no token";
  if (cfg.announcePerDay <= 0) return "daily cap is 0";
  if (todayCount(st, now) >= cfg.announcePerDay) return `daily cap reached (${cfg.announcePerDay})`;
  if (st.lastAt && now - st.lastAt < cfg.announceGapMin * 60_000) {
    return `too soon — ${Math.ceil((cfg.announceGapMin * 60_000 - (now - st.lastAt)) / 60_000)}min to go`;
  }
  const last = st.announced[keyOf(row.chain, row.address)];
  if (last && now - last < cfg.announceCooldownDays * 86_400_000) {
    return `${row.sym || row.address} was announced ${Math.round((now - last) / 86_400_000)}d ago (cooldown ${cfg.announceCooldownDays}d)`;
  }
  return null;
}

/**
 * Post the auto-spotlight card for one token. MAIN PROCESS ONLY — channels/post
 * is attached there. Best-effort: the promotion has already happened and must
 * never be undone by a failed post.
 */
let _announcer = null; // test seam: swap the channel post for a recorder
async function announceOne(row, hours) {
  if (_announcer) return _announcer(row, hours);
  const post = require("../channels/post");
  const fmt = require("../channels/format");
  const { CHANNELS, SITE_URL } = require("../config/constants");
  const { postMedia } = require("../fulfillment");
  const { chainOf } = require("../config/chains");
  const market = require("../marketdata");
  const tokenEmoji = require("../tokenEmoji");

  const live = await market.fetchMarket(row.chain, row.address).catch(() => null);
  const coin = {
    name: row.name,
    symbol: row.sym || row.symbol,
    chain: row.chain,
    address: row.address,
    tier: row.tier,
    price: live && live.priceUsd,
    mcap: live && live.mcap,
    liq: live && live.liq,
    links: { website: row.website, twitter: row.twitter, telegram: row.telegram },
    siteUrl: `${SITE_URL}/token/${row.chain}/${row.address}`,
  };
  // The pack must exist BEFORE the card renders — emojiTag() reads it synchronously.
  await tokenEmoji
    .ensureFromUrl({ chain: row.chain, address: row.address, symbol: coin.symbol }, row.logoUrl)
    .catch(() => null);
  const media = await postMedia(
    "trending",
    {
      symbol: coin.symbol,
      name: coin.name,
      chain: String(chainOf(row.chain) ? chainOf(row.chain).label : row.chain).toUpperCase(),
      price: live && live.priceUsd ? `$${Number(live.priceUsd).toPrecision(4)}` : "TBA",
      mcap: live && live.mcap ? `$${Math.round(live.mcap).toLocaleString("en-US")}` : null,
      links: coin.links,
    },
    null,
    null,
    row.logoUrl || "",
    // Same badge a paid run gets, stating this slot's REAL length.
    hours ? `Trending ${hours}H` : null,
  ).catch(() => null);
  // Never pinned (the Trending board owns that pin) and never @dexvraio (the
  // announcement headline is a 24H/48H paid inclusion).
  return post.sendMedia(CHANNELS.trending, media, fmt.trendingPost(coin));
}

/**
 * Announce `row` if every rail allows it, and record it. Returns the reason it
 * was skipped, or null when it posted.
 */
async function tryAnnounce(row, { now = Date.now(), hours = 0 } = {}) {
  const cfg = get();
  const st = loadState();
  const why = announceReason(row, st, cfg, now);
  if (why) {
    log.debug(`[autotrend] not announcing ${row && row.sym}: ${why}`);
    return why;
  }
  let msg = null;
  try {
    msg = await announceOne(row, hours);
  } catch (e) {
    log.warn(`[autotrend] announce ${row.sym || row.address}: ${e.message}`);
    return `post failed (${e.message})`;
  }
  if (!msg) return "post failed";
  // Counted only after it really posted — a failed post must not spend the
  // token's cooldown or the day's budget.
  st.announced[keyOf(row.chain, row.address)] = now;
  st.lastAt = now;
  st.day = { key: dayKey(now), n: todayCount(st, now) + 1 };
  await saveState(st);
  log.info(`[autotrend] announced ${row.sym || row.address} on ${row.chain} → ${msg.message_id}`);
  return null;
}

/** Queue an announcement for the MAIN process (used by the admin bot). */
async function queueAnnounce(row, hours = 0) {
  const st = loadState();
  st.pending = [
    ...st.pending.filter((p) => keyOf(p.chain, p.address) !== keyOf(row.chain, row.address)),
    { chain: row.chain, address: row.address, hours, at: Date.now() },
    // A cold start across five chains can enqueue 25 at once, and a slow drain
    // must not silently discard the tail. Bounded, but generously.
  ].slice(-200);
  await saveState(st);
}

/** Main-process drain of whatever the admin bot queued. */
async function drainPending({ now = Date.now() } = {}) {
  const st = loadState();
  if (!st.pending.length) return 0;
  const next = st.pending[0];
  // Look BEFORE removing. The old order popped the head, saved, and then tried
  // to post — so a "too soon, 12 min to go" threw the promotion away, and the
  // token sat on the board with no post for its whole slot. Nothing may leave
  // this queue until it has either posted or been refused for good.
  const cfg = get();
  const why = announceReason({ chain: next.chain, address: next.address }, st, cfg, now);
  if (isRetryable(why)) return 0; // still queued; the next tick tries again

  st.pending = st.pending.slice(1);
  await saveState(st);
  if (why) {
    log.debug(`[autotrend] dropping queued ${next.chain}/${next.address}: ${why}`);
    return 0;
  }
  let listings = [];
  try {
    listings = await api.getListings();
  } catch {
    return 0;
  }
  const row = listings.find((r) => keyOf(r.chain, r.address) === keyOf(next.chain, next.address));
  if (!row) return 0;
  // The queue can be hours deep, and a slot lasts 3–18h. Announcing a token
  // whose slot has already ended posts a card for something no longer on the
  // board — worse than not posting it.
  if (row.trendingRank == null || (row.trendExp && row.trendExp <= now)) {
    log.debug(`[autotrend] dropping queued ${row.sym || row.address}: its slot ended before the queue reached it`);
    return 0;
  }
  return (await tryAnnounce(row, { now, hours: next.hours })) ? 0 : 1;
}

/** How many promotions are waiting to be posted (shown in the admin panel). */
function pendingCount() {
  return loadState().pending.length;
}

/** One top-up pass: promote random eligible listings until `target` are featured.
 *  `rng` is injectable so tests are deterministic. Returns how many were promoted.
 *  Never throws — a hiccup must not take down the service loop. */
// ── Ranking: top gainers ─────────────────────────────────────────────────────
// A trending board is a claim about what is MOVING. Filling it at random made
// that claim false — a token down 80% sat next to one up 40% with nothing to
// tell them apart, and the operator could not point at the board and say why
// anything on it was there.
//
// Live 24h change per candidate, best first. Bounded and paced, because this
// runs on a timer and the price API is shared with the board poster:
//   • at most PROBE_CAP candidates per chain get a lookup
//   • PROBE_GAP_MS between calls
//   • a token whose price cannot be read sorts LAST but is still available —
//     never promoting an unpriced token would quietly exclude every new listing
//     on a chain no indexer covers, which is most of Robinhood.
const PROBE_CAP = 25;
const PROBE_GAP_MS = 250;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function byGain(rows, rng = Math.random) {
  // No shortcut for a single candidate: it still has to be PRICED, or the
  // caller's floor sees an unannotated row and reads it as "never looked" —
  // which is how the one token on a chain silently stopped being promotable.
  const probe = rows.slice(0, PROBE_CAP);
  const rest = rows.slice(PROBE_CAP);
  const scored = [];
  for (const r of probe) {
    let change = null;
    let priced = false;
    try {
      const m = await market.fetchMarket(r.chain, r.address);
      if (m && Number.isFinite(m.change24h)) change = m.change24h;
      // "NO 24h READING" AND "NO MARKET AT ALL" ARE DIFFERENT FACTS, and the
      // board renders them identically — which is how `$BINGBONG` reached a
      // pinned public board as a bare ticker with no percentage and no market
      // cap beside it. A quiet pool still has a price to publish; a token with
      // no pool anywhere has nothing, and a row for it is decoration.
      if (m && Number.isFinite(m.priceUsd)) priced = true;
    } catch {
      /* unpriced — handled below */
    }
    r._change = change;   // carried so the caller can apply a floor without re-fetching
    r._priced = priced;
    scored.push({ r, change });
    await sleep(PROBE_GAP_MS);
  }
  const priced = scored.filter((x) => x.change != null).sort((a, b) => b.change - a.change);
  // Unpriced candidates keep a random order among themselves, so a chain with no
  // price data at all still rotates instead of promoting the same token forever.
  const unpriced = scored.filter((x) => x.change == null).map((x) => x.r);
  for (let i = unpriced.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [unpriced[i], unpriced[j]] = [unpriced[j], unpriced[i]];
  }
  // The unprobed tail keeps _change undefined rather than null, so the floor can
  // tell "we looked and there is no price" from "we never looked".
  for (const r of rest) r._change = undefined;
  return [...priced.map((x) => x.r), ...unpriced, ...rest];
}

/**
 * One top-up pass. `chain` restricts it to a single network and makes the run
 * FORCED: it ignores the enabled switch and the global target, and promotes up
 * to `count` tokens on that chain. That is what the admin panel's per-chain
 * "Run now" needs — the board groups by chain, so a chain with no featured
 * token shows nothing at all, and waiting for the random cycle to happen to
 * pick that chain is not a plan.
 */
// `deps` is a test seam only: the board filler reaches the network and the site
// API, and a test that had to stub those globally would be pinning the wiring
// rather than the behaviour.
async function runOnce({ rng = Math.random, chain = null, count = 1, deps = {} } = {}) {
  const cfg = get();
  if (!cfg.enabled && !chain) return 0; // a forced per-chain run is deliberate
  let listings;
  try {
    listings = await api.getListings();
  } catch (e) {
    log.debug(`[autotrend] listings: ${e.message}`);
    return 0;
  }
  const now = Date.now();
  const isFeatured = (r) => r.status === "approved" && r.trendingRank != null && (!r.trendExp || r.trendExp > now);
  const on = (r, id) => String(r.chain).toLowerCase() === String(id).toLowerCase();

  // Each chain is topped up against ITS OWN count — doing this globally meant
  // the network with the most listings won every shuffle and the rest of the
  // board stayed empty (see DEFAULTS.perChainMin) — and to ITS OWN rolled target. A chain still AT or above
  // the floor is left alone — that is what keeps the counts different from each
  // other instead of every chain sitting on the same number.
  const rollTarget = () => cfg.perChainMin + Math.floor(rng() * (cfg.perChainMax - cfg.perChainMin + 1));
  const plan = chain
    ? [{ id: chain, need: count, forced: true }]
    : cfg.chains.map((id) => {
        const have = listings.filter((r) => isFeatured(r) && on(r, id)).length;
        return {
          id,
          need: have >= cfg.perChainMin ? 0 : rollTarget() - have,
          // How many of those are needed just to REACH the minimum. The gain
          // floor is allowed to leave the rolled part unfilled; it is not
          // allowed to leave the board under the number the operator set.
          needFloor: Math.max(0, cfg.perChainMin - have),
          forced: false,
        };
      });

  let promoted = 0;
  // ONE public post per run, across every chain — not one per chain. A cold
  // start tops up five networks at once, and five cards in a row is a firehose.
  let announcedThisRun = false;
  const short = [];
  // The same shortfall, as data. It used to exist only as English inside
  // `short`, which is why nothing could act on it.
  const gaps = new Map();
  /**
   * ⚠️ ONLY a LISTING shortage belongs here.
   *
   * The board can end up short for two completely different reasons, and only
   * one of them is fixed by listing something:
   *
   *   • the chain has no spare listings left  → nothing to promote → FILL
   *   • the chain has plenty, but they are all DOWN → the `minGainPct` floor
   *     did its job, and the board is short ON PURPOSE
   *
   * Feeding the second case to the filler turns a red market into a listing
   * spree: with `min +5% 24h` set, every chain looks "short" on any red day, so
   * the bot would list `fillMaxPerCycle` fresh tokens per chain per cycle —
   * every cycle, all day — while the tokens already listed there sit unused
   * because they are down 2%. The gain floor and the filler would be fighting
   * each other, and the filler would win because its listings book their slot
   * directly.
   */
  const gap = (id, n) => {
    if (n > 0) gaps.set(id, Math.max(gaps.get(id) || 0, n));
  };

  for (const step of plan) {
    if (step.need <= 0) continue;
    const eligible = listings.filter(
      (r) =>
        r.status === "approved" &&
        !isFeatured(r) &&
        on(r, step.id),
    );
    if (!eligible.length) {
      if (step.forced) log.info(`[autotrend] forced run on ${step.id}: nothing eligible (every listed token there is already featured?)`);
      else { short.push(`${step.id} (needs ${step.need}, none eligible)`); gap(step.id, step.need); }
      continue;
    }
    if (eligible.length < step.need) { short.push(`${step.id} (needs ${step.need}, only ${eligible.length} eligible)`); gap(step.id, step.need - eligible.length); }
    // TOP GAINERS, not a shuffle. A trending board is a claim about what is
    // moving; filling it at random made that claim false, and put a token down
    // 80% next to one up 40% with nothing to tell them apart.
    const ranked = await byGain(eligible, rng);
    // Losers are not promoted. `change` is attached by byGain; null means the
    // price could not be read, and those stay eligible on purpose.
    // A token with no market ANYWHERE (no price, not merely no 24h reading) is
    // only a candidate where nothing else on the chain is priced either — see
    // the floor fill below, which states the reasoning in full.
    const anyPriced = ranked.some((r) => r._priced);
    const hasMarket = (r) => !anyPriced || r._priced !== false;
    // ⚠️ A TRENDING ROW WITHOUT A PERCENTAGE IS THE THING THAT GOT REPORTED.
    //
    // "beberapa token di trending channel mengapa tidak ada kenaikan atau
    // penurunan %" — $MOONCOIN and $RLUSD sat on the pinned board with a market
    // cap and no number beside it. The board is a claim about what is MOVING;
    // a row that cannot say how much is a row that cannot make the claim, and
    // an unreadable change may never be rendered as a 0% to say it anyway.
    //
    // So a slot this bot books ITSELF must carry a reading. The exemption is
    // the same one `hasMarket` makes and is exactly as narrow: only where
    // NOTHING on the chain has a reading do the unreadable go on — otherwise a
    // chain no indexer covers would never fill, which is the whole reason the
    // unpriced exemption exists. The unprobed tail (`_change === undefined`) is
    // treated as unreadable rather than as a maybe: promoting a token we never
    // looked at is how a blank reaches the board with nobody having decided it
    // should.
    const anyReading = ranked.some((r) => Number.isFinite(r._change));
    const hasReading = (r) => !anyReading || Number.isFinite(r._change);
    const worthy = step.forced
      ? ranked
      : ranked.filter(
          (r) => (r._change === null || r._change >= cfg.minGainPct) && hasMarket(r) && hasReading(r),
        );
    // ⚠️ THE MINIMUM OUTRANKS THE GAIN FLOOR.
    //
    // `min +5% 24h` with a flat market left ETHEREUM publishing 3 rows and BASE
    // 2 against a floor of 5 — every spare listing on those chains was down a
    // percent or two, so nothing was promoted and the board simply stayed
    // short. The operator had to tap ⚡ Run now by hand (which ignores the
    // floor) to get a token on the board, which is the tell.
    //
    // So the floor applies to the DISCRETIONARY part of the target only. Up to
    // `perChainMin` the best available candidates go on regardless — `ranked` is
    // already sorted by 24h change, so "regardless" still means the best ones —
    // because a board under the number the operator set is a worse product than
    // a board carrying a token that is down 2%. Above the minimum, the floor is
    // honoured and the chain is simply left where it is.
    const picks = worthy.slice(0, step.need);
    if (!step.forced && picks.length < step.needFloor) {
      const chosen = new Set(picks);
      // …but NOT at any price. The board once carried a token at −99.94% on a
      // $1,648 market cap, and "the board must be full" must not bring that
      // back: a slot filled by a token in free-fall is worse than a short
      // board, which is the one direction this trade-off does not go. Unpriced
      // tokens stay exempt (Robinhood has no indexer — judging them by a number
      // nobody can read would mean never filling that chain at all).
      // The unpriced exemption is deliberate and NARROWER than it looks. Its
      // stated reason is "a chain no indexer covers would never fill" — so it
      // applies to a token whose 24h READING is missing, not to one with no
      // market at all. A token GT and DexScreener both have nothing for
      // publishes as a bare ticker: no percentage, no cap, nothing. That row
      // was on the board, and it is what got reported.
      //
      // `_priced === false` is only trusted where something else on this chain
      // IS priced. Where nothing is, the old reason still holds and the
      // unpriced go on — a short board on a chain no indexer covers helps
      // nobody.
      // `hasReading` binds THIS door too. The free-fall bound taught the same
      // lesson one field over: a rule the floor fill does not honour is a rule
      // the floor fill deletes, because its picks book their slot directly.
      const fillable = (r) =>
        !chosen.has(r) &&
        (r._change === null || r._change >= -FLOOR_FILL_MAX_DROP) &&
        hasMarket(r) &&
        hasReading(r);
      const extra = ranked.filter(fillable).slice(0, step.needFloor - picks.length);
      if (extra.length) {
        log.info(
          `[autotrend] ${step.id}: promoting ${extra.length} below the +${cfg.minGainPct}% floor to reach the minimum of ${cfg.perChainMin} ` +
            `(${extra.map((r) => `${r.sym || "?"} ${r._change === null ? "unpriced" : `${r._change.toFixed(1)}%`}`).join(", ")})`,
        );
      }
      picks.push(...extra);
    }
    // ⚠️ A SPARE IN FREE-FALL IS NOT A SPARE — the fourth cause.
    //
    // Live board, 19 Aug: Base sat at 4/5 with two spare listings and stayed
    // there. Both were below −15%, so the floor fill above skipped them (right),
    // and `gap()` was never called because the chain "has listings" (wrong) —
    // so the market filler was never asked either. Nothing in the loop could
    // move it, ever: the promoter refuses those two on every cycle for the same
    // reason, and refusing is not a state that resolves itself.
    //
    // The gate `gap()` documents is "can this chain fill the minimum from its
    // OWN listings?", and a token this pass may never promote cannot. It is
    // only the FLOOR shortfall that is asked for — above the minimum the
    // operator's `minGainPct` legitimately leaves the chain where it is, which
    // is the red-day spree `gap()` exists to prevent and which this does not
    // re-open.
    if (!step.forced && picks.length < step.needFloor) {
      short.push(`${step.id} (needs ${step.needFloor - picks.length} more to reach the minimum; every spare is below −${FLOOR_FILL_MAX_DROP}%)`);
      gap(step.id, step.needFloor - picks.length);
    }
    if (!picks.length) {
      // No gap() HERE: this chain is at or above the minimum and its spares are
      // simply not up enough — the gain floor working as designed. Anything
      // below the minimum was already gapped above. See gap().
      short.push(`${step.id} (needs ${step.need}; ${ranked.length} candidate(s), none up ${cfg.minGainPct}% or more)`);
      continue;
    }
    if (picks.length < step.need) {
      short.push(`${step.id} (needs ${step.need}, only ${picks.length} up ${cfg.minGainPct}% or more)`);
    }
    for (const r of picks) {
      // Random duration in [minHours, maxHours] — different per token, so the
      // slots expire at staggered (random) times and refill naturally.
      const hours = cfg.minHours + Math.floor(rng() * (cfg.maxHours - cfg.minHours + 1));
      try {
        await api.bookTrending(r.chain, r.address, hours);
        promoted++;
        log.info(
          `[autotrend] ${step.forced ? "FORCED " : ""}promoted ${r.chain}/${String(r.address).slice(0, 8)}… (${r.sym || "?"}) for ${hours}h`,
        );
        // The first promotion of a run posts immediately; the rest queue and
        // drain on the 45s timer, spaced by announceGapMin. A cold start tops
        // up five networks at once — posting all 25 in a burst is the firehose
        // this used to avoid by DROPPING them, which left tokens on the board
        // with no post at all. Queue, don't drop.
        if (!announcedThisRun) {
          const why = await tryAnnounce(r, { hours }).catch(() => "error");
          announcedThisRun = why === null;
          if (isRetryable(why)) await queueAnnounce(r, hours);
        } else {
          await queueAnnounce(r, hours);
        }
      } catch (e) {
        log.debug(`[autotrend] bookTrending ${r.sym}: ${e.message}`);
      }
    }
  }
  // The board is short and nothing here can fix it: those chains need LISTINGS,
  // not another cycle. It is ADVICE about a semi-permanent condition, not an
  // incident — so it goes out once a DAY, and the mark is on disk.
  //
  // It used to be an hourly in-memory guard and it spammed the operator's
  // channel anyway: `lastShortWarnAt` and the logger's own 15-minute
  // de-duplication both live in process memory, so every pm2 restart re-armed
  // both. A deploy afternoon put five identical warnings in the channel inside
  // ninety minutes. pm2 logs still get the line every cycle at debug level.
  // ── The gap the promotion pass could not close ───────────────────────────
  //
  // Promoting can only ever reach as far as what is LISTED on a chain, so a
  // chain with three listings publishes three rows for ever. This is where that
  // stops being a note in a log an operator does not read and becomes an
  // action: list the chain's biggest tokens, exactly as many as are missing.
  //
  // Bounded three ways on purpose — a floor on market cap, a floor on
  // liquidity, and a cap per chain per cycle — because the failure mode of an
  // unbounded filler is a public board full of tokens nobody chose.
  const filled = [];
  const fillWhyByChain = new Map();
  if (cfg.fillFromMarket && cfg.fillMaxPerCycle > 0 && gaps.size) {
    const fill = (deps && deps.fillChain) || require("./trendFill").fillChain;
    for (const [id, need] of gaps) {
      try {
        const r = await fill(id, Math.min(need, cfg.fillMaxPerCycle), { cfg, now, maxDropPct: FLOOR_FILL_MAX_DROP });
        if (r && r.listed.length) {
          filled.push(`${id}: ${r.listed.map((x) => x.sym).join(", ")}`);
          log.info(`[autotrend] filled ${id} with ${r.listed.length} big-cap listing(s) — the board was ${need} short`);
        } else if (r && r.why) {
          fillWhyByChain.set(id, r.why);
          // A fill that could not happen is its own fact, and it is the one an
          // operator needs: "GT is rate-limited" and "every big token here is
          // already listed" have different answers.
          log.debug(`[autotrend] could not fill ${id}: ${r.why}`);
          short.push(`${id} (could not fill: ${r.why})`);
        }
      } catch (e) {
        log.warn(`[autotrend] fill ${id} failed: ${e.message}`);
      }
    }
  }
  if (filled.length) log.info(`[autotrend] board topped up from the market → ${filled.join(" · ")}`);

  // ── Did the board actually end up where the operator set it? ──────────────
  //
  // Everything above is a CAUSE. This watches the promise: every configured
  // chain carries at least `perChainMin`. Three rounds of "trending sangat
  // sedikit" were reported by the operator counting rows in the channel,
  // because nothing here ever said it out loud — see trendingWatch.js.
  if (!chain) {
    try {
      const watch = require("./trendingWatch");
      const st = loadState();
      const after = await api.getListings().catch(() => listings);
      const snapshot = cfg.chains.map((id) => ({
        id,
        featured: after.filter((r) => isFeatured(r) && on(r, id)).length,
        floor: cfg.perChainMin,
        eligible: after.filter((r) => r.status === "approved" && !isFeatured(r) && on(r, id)).length,
        fillWhy: fillWhyByChain.get(id) || null,
        gainFloor: cfg.minGainPct,
      }));
      const { state: nextWatch, alerts } = watch.evaluate(snapshot, st.boardWatch, { now: Date.now() });
      st.boardWatch = nextWatch;
      await saveState(st);
      for (const a of alerts) log.alert(a.text);
    } catch (e) {
      // A diagnostic must never be why a cycle fails.
      log.debug(`[autotrend] board watch: ${e.message}`);
    }
  }

  if (short.length) {
    const line = `[autotrend] board below target on ${short.join(", ")} — list more tokens on those chains, or lower the per-chain target`;
    log.debug(line);
    if (ops.due(SHORT_WARN_KEY, SHORT_WARN_MS)) {
      await ops.mark(SHORT_WARN_KEY).catch(() => {});
      log.noise(line);
    }
  }
  return promoted;
}
const SHORT_WARN_KEY = "autotrend_board_short";
const SHORT_WARN_MS = Math.max(3600_000, Number(process.env.AUTOTREND_SHORT_WARN_HOURS || 24) * 3600_000);

const randInt = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo + 1));

/** Self-rescheduling loop with a RANDOM gap each cycle. Config is re-read every
 *  cycle, so enabling/tuning it from the admin bot applies without a restart.
 *  While disabled it still ticks (every 10 min) so an enable is picked up. */
function start() {
  let timer = null;
  let stopped = false;
  // Drain whatever the ADMIN bot queued (its per-chain "Run now") — here, in the
  // process that can actually post. 45s so a forced promotion is announced
  // within a minute instead of at the next random cycle, up to 2h away.
  const drain = setInterval(() => {
    drainPending().catch((e) => log.debug(`[autotrend] drain: ${e.message}`));
  }, 45_000);
  if (drain.unref) drain.unref();
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
  // RANDOM boot delay, not a fixed 60s: once this loop publishes, a fixed delay
  // puts a public post at exactly one minute after every restart — a visible
  // machine cadence, the same tell the random gap already avoids.
  timer = setTimeout(tick, (30 + Math.random() * 150) * 1000);
  return {
    stop: () => {
      stopped = true;
      clearInterval(drain);
      if (timer) clearTimeout(timer);
    },
  };
}

/**
 * Force a promotion on ONE chain and say what happened.
 *
 * runOnce() returns a count, which is all the scheduler needs — but a button in
 * the admin panel has to explain a zero, and "0" has three very different
 * causes: nothing listed on that chain, everything there already trending, or
 * the API refused the booking. Silence on a tap reads as "the button is
 * broken", which is exactly how this was reported.
 *
 * @returns {Promise<{promoted:number, syms:string[], reason:string}>}
 */
async function forceChain(chain, { count = 1, rng = Math.random } = {}) {
  const cfg = get();
  const id = String(chain || "").toLowerCase();
  let listings;
  try {
    listings = await api.getListings();
  } catch (e) {
    return { promoted: 0, syms: [], reason: `listings unavailable (${e.message})` };
  }
  const now = Date.now();
  const isFeatured = (r) => r.status === "approved" && r.trendingRank != null && (!r.trendExp || r.trendExp > now);
  const onChain = (r) => String(r.chain || "").toLowerCase() === id;
  const approved = listings.filter((r) => r.status === "approved" && onChain(r));
  if (!approved.length) return { promoted: 0, syms: [], reason: `no listings on ${id} yet` };
  // No tier filter: this is the admin's own "put one there now" button.
  const eligible = approved.filter((r) => !isFeatured(r));
  if (!eligible.length) {
    return { promoted: 0, syms: [], reason: `all ${approved.length} listed token(s) on ${id} are already trending` };
  }
  const ranked = await byGain(eligible, rng);
  const syms = [];
  let lastErr = null;
  for (const r of ranked.slice(0, Math.max(1, count))) {
    const hours = cfg.minHours + Math.floor(rng() * (cfg.maxHours - cfg.minHours + 1));
    try {
      await api.bookTrending(r.chain, r.address, hours);
      syms.push(`${r.sym || String(r.address).slice(0, 6)} ${hours}h`);
      log.info(`[autotrend] FORCED ${r.chain}/${String(r.address).slice(0, 8)}… (${r.sym || "?"}) for ${hours}h`);
      // forceChain runs in the ADMIN process, where channels/post was never
      // attach()ed — posting from here throws. Hand it to the main bot, which
      // drains the queue within a minute.
      if (get().announce) await queueAnnounce(r, hours).catch(() => {});
    } catch (e) {
      lastErr = e.message;
      log.warn(`[autotrend] forced bookTrending ${r.sym || r.address}: ${e.message}`);
    }
  }
  if (!syms.length) return { promoted: 0, syms, reason: `the site refused the booking (${lastErr || "unknown"})` };
  return { promoted: syms.length, syms, reason: "" };
}

/** How many tokens are featured per chain right now — the panel shows this so
 *  the operator can see WHICH chain is empty before forcing one. */
async function featuredByChain(now = Date.now()) {
  const out = {};
  let listings = [];
  try {
    listings = await api.getListings();
  } catch (e) {
    log.debug(`[autotrend] featuredByChain: ${e.message}`);
    return out;
  }
  for (const r of listings) {
    if (r.status !== "approved") continue;
    const id = String(r.chain || "").toLowerCase();
    out[id] = out[id] || { featured: 0, eligible: 0 };
    if (r.trendingRank != null && (!r.trendExp || r.trendExp > now)) out[id].featured++;
    else out[id].eligible++;
  }
  return out;
}

module.exports = {
  _test: {
    resetShortWarn: () => ops.clear(SHORT_WARN_KEY),
    SHORT_WARN_KEY,
    setAnnouncer: (fn) => (_announcer = fn),
    setLastAt: async (t) => { const st = loadState(); st.lastAt = t; await saveState(st); },
    setAnnounced: async (chain, address, t) => { const st = loadState(); st.announced[keyOf(chain, address)] = t; await saveState(st); },
  },
  resetState: resetAnnounceState,
  queueAnnounce,
  get,
  set,
  reset,
  runOnce,
  forceChain,
  featuredByChain,
  announceReason,
  tryAnnounce,
  drainPending,
  isRetryable,
  byGain,
  pendingCount,
  resetAnnounceState,
  start,
  DEFAULTS,
  HARD,
  // The free-fall bound, exported because BOTH doors onto the board have to
  // honour it: promotion here, and the market fill in trendFill.js. One of them
  // refusing a token at −20% while the other lists one is the same board saying
  // two things.
  FLOOR_FILL_MAX_DROP,
};
