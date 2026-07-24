// Pump alerts: polls each approved listing's live price and fires a one-time
// alert when it's up 100–5000% (up to 50×) from the baseline (the price first
// observed by the bot ≈ listing time). Posts as a REPLY to the original listing
// post (like fourtis) and tweets; carries the admin's pump GIF/video clip when
// one is set. Baseline + once-only latch persist across restarts.
const { PUMP_CHECK_MS, CHANNELS, SITE_URL } = require("../config/constants");
const api = require("../api/dexvra");
const { fetchMarket } = require("../marketdata");
const postids = require("../channels/postids");
const fmt = require("../channels/format");
const post = require("../channels/post");
const bannerTemplate = require("../bannerTemplate");
const x = require("../twitter");
const { fmtPrice, formatNumber } = require("../helpers/format");
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

/** Fetch a token logo into a Buffer (relative /api/media/… → public SITE_URL). */
async function fetchLogoBuffer(logoUrl) {
  if (!logoUrl) return null;
  const url = logoUrl.startsWith("http") ? logoUrl : `${SITE_URL}${logoUrl}`;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(12000) });
    if (!r.ok) return null;
    return Buffer.from(await r.arrayBuffer());
  } catch {
    return null;
  }
}

/** Build the pump-alert media. When the admin has set a pump GIF/video, the
 *  token overlay (▲ +N% · old→new price · MCAP pill · logo ring · cyan $ticker)
 *  is composited onto it — the same auto-fill the listing/trending banners get,
 *  but with pump's DISTINCT layout. Falls back to the raw clip on any failure,
 *  and null when no clip is set (caller then posts a plain text reply). */
async function pumpMedia(r, base, m, pct) {
  const media = bannerTemplate.mediaOverride("pump"); // admin GIF/video (null → text reply)
  if (!media) return null;
  try {
    const logoBuffer = await fetchLogoBuffer(r.logoUrl);
    const filled = await bannerTemplate.composeOntoClip("pump", media, logoBuffer, {
      symbol: r.sym,
      name: r.name,
      chain: r.chain,
      change: `+${Math.round(pct)}%`,
      priceFrom: fmtPrice(base.price),
      priceTo: fmtPrice(m.priceUsd),
      price: fmtPrice(m.priceUsd),
      mcap: m.mcap ? "$" + formatNumber(m.mcap) : null,
    });
    if (filled) {
      log.info(`[pump] ${r.sym} media: admin clip + pump overlay ✔`);
      return filled;
    }
    log.warn(`[pump] ${r.sym} media: overlay composite failed — sending clip as-is`);
  } catch (e) {
    log.warn(`[pump] ${r.sym} overlay: ${e.message}`);
  }
  return media;
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
      if (pct < 100 || pct >= 5000) continue; // 100% floor, 50× ceiling (fourtis: 5000)
      if (latch.has(key)) continue;

      await latch.add(key);
      const coin = coinOf(r, m.priceUsd, m.mcap);
      const ids = postids.get(r.chain, r.address);
      const card = fmt.pumpPost(coin, pct, base.mcap || 0, m.mcap || 0);
      const media = await pumpMedia(r, base, m, pct); // admin pump clip + overlay (null → text reply)
      try {
        await post.sendMedia(CHANNELS.listing, media, card, { replyTo: ids.listingMsgId });
        if (ids.annMsgId) await post.sendMedia(CHANNELS.announce, media, card, { replyTo: ids.annMsgId });
      } catch (e) {
        log.warn(`[pump] post: ${e.message}`);
      }
      // Quote the original listing tweet on X (falls back to a standalone
      // tweet when the listing tweet id isn't known).
      x.postPump(coin, pct, base.mcap || 0, m.mcap || 0, ids.listingTweetId).catch(() => {});
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
