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
const log = require("../helpers/logger");

const FILE = "autoTrend.json";
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
  perChain: 5,
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
  perChainMin: 0,   // 0 = leave this chain to paid slots only
  perChainMax: 20,
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
  g.perChain = clampInt(c.perChain, HARD.perChainMin, HARD.perChainMax, DEFAULTS.perChain);
  // An unknown chain id would be topped up forever with nothing eligible, so the
  // list is filtered against the real chain table rather than trusted.
  if (Array.isArray(c.chains)) {
    const ids = c.chains.map((x) => String(x).toLowerCase()).filter((x) => CHAINS[x]);
    if (ids.length) g.chains = [...new Set(ids)];
  }
  if (typeof c.announce === "boolean") g.announce = c.announce;
  g.announcePerDay = clampInt(c.announcePerDay, ...HARD.announcePerDay, DEFAULTS.announcePerDay);
  g.announceGapMin = clampInt(c.announceGapMin, ...HARD.announceGapMin, DEFAULTS.announceGapMin);
  g.announceCooldownDays = clampInt(c.announceCooldownDays, ...HARD.announceCooldownDays, DEFAULTS.announceCooldownDays);
  return g;
}

/** Patch any subset of the config; persists and returns the clamped result. */
async function set(patch = {}) {
  const next = { ...get() };
  if (typeof patch.enabled === "boolean") next.enabled = patch.enabled;
  if (typeof patch.announce === "boolean") next.announce = patch.announce;
  for (const k of ["minHours", "maxHours", "minGapMin", "maxGapMin", "perChain", "announcePerDay", "announceGapMin", "announceCooldownDays"]) {
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
  if (rows.length <= 1) return rows.slice();
  const probe = rows.slice(0, PROBE_CAP);
  const rest = rows.slice(PROBE_CAP);
  const scored = [];
  for (const r of probe) {
    let change = null;
    try {
      const m = await market.fetchMarket(r.chain, r.address);
      if (m && Number.isFinite(m.change24h)) change = m.change24h;
    } catch {
      /* unpriced — handled below */
    }
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
async function runOnce({ rng = Math.random, chain = null, count = 1 } = {}) {
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

  // Each chain is topped up against ITS OWN count. Doing this globally meant the
  // network with the most listings won every shuffle and the rest of the board
  // stayed empty — see DEFAULTS.perChain.
  const plan = chain
    ? [{ id: chain, need: count, forced: true }]
    : cfg.chains.map((id) => ({ id, need: cfg.perChain - listings.filter((r) => isFeatured(r) && on(r, id)).length, forced: false }));

  let promoted = 0;
  // ONE public post per run, across every chain — not one per chain. A cold
  // start tops up five networks at once, and five cards in a row is a firehose.
  let announcedThisRun = false;
  const short = [];

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
      else short.push(`${step.id} (needs ${step.need}, none eligible)`);
      continue;
    }
    if (eligible.length < step.need) short.push(`${step.id} (needs ${step.need}, only ${eligible.length} eligible)`);
    // TOP GAINERS, not a shuffle. A trending board is a claim about what is
    // moving; filling it at random made that claim false, and put a token down
    // 80% next to one up 40% with nothing to tell them apart.
    const ranked = await byGain(eligible, rng);
    for (const r of ranked.slice(0, step.need)) {
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
  // not another cycle. Once an hour so it registers without becoming noise.
  if (short.length && Date.now() - lastShortWarnAt > 3600_000) {
    lastShortWarnAt = Date.now();
    log.warn(`[autotrend] board below target on ${short.join(", ")} — list more tokens on those chains, or lower the per-chain target`);
  }
  return promoted;
}
let lastShortWarnAt = 0;

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
    resetShortWarn: () => (lastShortWarnAt = 0),
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
};
