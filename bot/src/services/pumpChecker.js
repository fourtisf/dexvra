// Pump alerts: polls each approved listing's live price and fires a one-time
// alert when it's up 100–2000% from the baseline (the price first observed by
// the bot ≈ listing time). Posts as a reply to the original listing post (like
// fourtis) and tweets. Baseline + once-only latch persist across restarts.
const { PUMP_CHECK_MS, CHANNELS, SITE_URL } = require("../config/constants");
const api = require("../api/dexvra");
const { fetchMarket } = require("../marketdata");
const postids = require("../channels/postids");
const fmt = require("../channels/format");
const post = require("../channels/post");
const x = require("../twitter");
const { DedupSet, loadJSONSync, saveJSON } = require("../helpers/persist");
const log = require("../helpers/logger");

const BASE_FILE = "pumpbase.json";
let baseline = loadJSONSync(BASE_FILE, {});
const latch = new DedupSet("pumplatch.json");
const keyOf = (r) => `${r.chain}:${String(r.address).toLowerCase()}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function coinOf(r, price, mcap) {
  return {
    name: r.name,
    symbol: r.sym,
    chain: r.chain,
    address: r.address,
    tier: r.tier,
    price,
    mcap,
    links: { website: r.website, twitter: r.twitter, telegram: r.telegram },
    siteUrl: `${SITE_URL}/token/${r.chain}/${r.address}`,
  };
}

function start(tg) {
  const run = async () => {
    let listings;
    try {
      listings = await api.getListings();
    } catch {
      return;
    }
    const now = Date.now();
    for (const r of listings) {
      if (r.status !== "approved") continue;
      const key = keyOf(r);
      const m = await fetchMarket(r.chain, r.address).catch(() => null);
      await sleep(300); // be polite to GeckoTerminal
      if (!m || !m.priceUsd) continue;

      if (!baseline[key]) {
        baseline[key] = { price: m.priceUsd, mcap: m.mcap || null, at: now };
        await saveJSON(BASE_FILE, baseline).catch(() => {});
        continue; // no alert on first observation
      }
      const base = baseline[key];
      if (!base.price || m.priceUsd < base.price) continue;
      const pct = ((m.priceUsd - base.price) / base.price) * 100;
      if (pct < 100 || pct >= 2000) continue; // same band as fourtis
      if (latch.has(key)) continue;

      await latch.add(key);
      const coin = coinOf(r, m.priceUsd, m.mcap);
      const ids = postids.get(r.chain, r.address);
      const card = fmt.pumpPost(coin, pct, base.mcap || 0, m.mcap || 0);
      try {
        await post.sendText(CHANNELS.listing, card, { replyTo: ids.listingMsgId });
        if (ids.annMsgId) await post.sendText(CHANNELS.announce, card, { replyTo: ids.annMsgId });
      } catch (e) {
        log.warn(`[pump] post: ${e.message}`);
      }
      x.postPump(coin, pct, base.mcap || 0, m.mcap || 0).catch(() => {});
      log.event(`📈 Pump: ${r.sym} +${Math.round(pct)}% since listing (${r.chain})`);
    }
  };
  const iv = setInterval(run, PUMP_CHECK_MS);
  const kick = setTimeout(run, 15000);
  return {
    stop: () => {
      clearInterval(iv);
      clearTimeout(kick);
    },
  };
}

module.exports = { start };
