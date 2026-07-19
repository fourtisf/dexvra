// Trending rank-up alerts. Ranks the active FEATURED trending tokens by live
// 24h price change (the same "gainers" metric the website's board uses) and
// announces when a token CLIMBS into the top RANKUP_TOP positions. Makes the
// Trending channel feel alive between the (static, tier-ordered) board posts,
// and reinforces "list on Dexvra so you're seen when you run".
//
// Framed as a PERFORMANCE ranking, never the featured rail's tier order — the
// website's featured slots are ordered by tier (Diamond first) and carry no
// number, so this posts "climbing by 24h performance", not a board position.
//
// Best-effort: an API/market blip skips the cycle, never throws.
const { RANKUP_CHECK_MS, RANKUP_TOP, RANKUP_MIN_CHANGE, CHANNELS } = require("../config/constants");
const api = require("../api/dexvra");
const { fetchMarket } = require("../marketdata");
const fmt = require("../channels/format");
const post = require("../channels/post");
const { chainOf } = require("../config/chains");
const { SITE_URL } = require("../config/constants");
const { loadJSONSync, saveJSON } = require("../helpers/persist");
const log = require("../helpers/logger");

const STATE_FILE = "rankup.json";
// { lastRank: {key: n}, alertedAt: {key: ts} }
const state = loadJSONSync(STATE_FILE, { lastRank: {}, alertedAt: {} });
const ALERT_COOLDOWN_MS = 6 * 3_600_000; // don't re-alert the same token within 6h

const keyOf = (r) => `${r.chain}:${String(r.address).toLowerCase()}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Date.now();

function coinOf(r, m) {
  return {
    name: r.name,
    symbol: r.sym,
    chain: r.chain,
    address: r.address,
    tier: r.tier,
    price: m && m.priceUsd,
    mcap: m && m.mcap,
    links: { website: r.website, twitter: r.twitter, telegram: r.telegram },
    siteUrl: `${SITE_URL}/token/${r.chain}/${r.address}`,
  };
}

async function scanOnce(tg) {
  let listings;
  try {
    listings = await api.getListings();
  } catch (e) {
    log.debug(`[rankup] getListings: ${e.message}`);
    return;
  }
  const t = now();
  const featured = (listings || []).filter(
    (r) => r.status === "approved" && r.trendingRank != null && (!r.trendExp || r.trendExp > t),
  );
  if (featured.length < 2) return; // a leaderboard needs at least a race

  // Fetch live 24h change for each featured token (bounded set — paid slots).
  const scored = [];
  for (const r of featured) {
    const m = await fetchMarket(r.chain, r.address).catch(() => null);
    await sleep(300); // be polite to GeckoTerminal
    if (!m || typeof m.change24h !== "number") continue;
    scored.push({ r, m, change: m.change24h });
  }
  if (scored.length < 2) return;

  scored.sort((a, b) => b.change - a.change);

  const alerts = [];
  scored.forEach((s, i) => {
    const rank = i + 1;
    const key = keyOf(s.r);
    const prev = state.lastRank[key];
    state.lastRank[key] = rank;
    // Alert only on a genuine CLIMB into the top band, above the noise floor,
    // and not within the per-token cooldown.
    const climbedIntoTop = rank <= RANKUP_TOP && (prev == null || prev > rank);
    const enoughGain = s.change >= RANKUP_MIN_CHANGE;
    const cool = (state.alertedAt[key] || 0) < t - ALERT_COOLDOWN_MS;
    if (climbedIntoTop && enoughGain && cool) {
      state.alertedAt[key] = t;
      alerts.push({ ...s, rank });
    }
  });

  // prune ranks for tokens no longer featured
  const liveKeys = new Set(scored.map((s) => keyOf(s.r)));
  for (const k of Object.keys(state.lastRank)) if (!liveKeys.has(k)) delete state.lastRank[k];
  await saveJSON(STATE_FILE, state).catch(() => {});

  for (const a of alerts) {
    try {
      const payload = fmt.rankupPost(coinOf(a.r, a.m), a.rank, a.change);
      await post.sendText(CHANNELS.trending, payload);
      log.info(`[rankup] ${a.r.sym || a.r.address} climbed to #${a.rank} (+${a.change.toFixed(1)}% 24h)`);
    } catch (e) {
      log.debug(`[rankup] post failed: ${e.message}`);
    }
  }
}

function start(tg) {
  const run = () => scanOnce(tg).catch((e) => log.debug(`[rankup] ${e.message}`));
  const iv = setInterval(run, RANKUP_CHECK_MS);
  const kick = setTimeout(run, 30_000);
  return {
    stop: () => {
      clearInterval(iv);
      clearTimeout(kick);
    },
  };
}

module.exports = { start, scanOnce };
