// X / Twitter posting (twitter-api-v2). Fully built but DISABLED unless the
// listing account's 4 keys are present (X_ENABLED). Two accounts supported
// ("listing" default, "official" for announcements). Media is uploaded when a
// buffer is provided; otherwise (and on any v1 upload 403 — free tier) it falls
// back to a text-only tweet. Returns the tweet id or null; never throws.
const { X, X_ENABLED, X_HANDLE, SITE_URL } = require("./config/constants");
const { fmtPrice, formatNumber } = require("./helpers/format");
const { chainOf } = require("./config/chains");
const log = require("./helpers/logger");

let TwitterApi = null;
function lib() {
  if (!TwitterApi) TwitterApi = require("twitter-api-v2").TwitterApi;
  return TwitterApi;
}

function clientFor(account) {
  const cfg = account === "official" ? X.official : X.listing;
  if (!cfg.appKey || !cfg.appSecret || !cfg.accessToken || !cfg.accessSecret) return null;
  return new (lib())({
    appKey: cfg.appKey,
    appSecret: cfg.appSecret,
    accessToken: cfg.accessToken,
    accessSecret: cfg.accessSecret,
  });
}

const symTag = (s) => String(s || "").replace(/^\$+/, "").toUpperCase();
const coinUrl = (coin) => coin.siteUrl || `${SITE_URL}/token/${coin.chain}/${coin.address}`;
// Branded footer (order: Listing → Trending → Announcement).
const X_FOOTER = "\n\n🌐 dexvra.io | 🚨 Listing | 🔥 Trending | 📢 Announcement";

async function send(account, text, mediaBuffer, mimeType) {
  if (!X_ENABLED) {
    log.debug("[x] disabled (no keys) — skipping tweet");
    return null;
  }
  const client = clientFor(account);
  if (!client) {
    log.debug(`[x] no keys for account ${account}`);
    return null;
  }
  try {
    let mediaIds;
    if (mediaBuffer) {
      try {
        const id = await client.v1.uploadMedia(mediaBuffer, { mimeType: mimeType || "image/png" });
        mediaIds = [id];
      } catch (e) {
        log.debug(`[x] media upload failed (${e.message}) — text-only`);
      }
    }
    const res = await client.v2.tweet(text, mediaIds ? { media: { media_ids: mediaIds } } : undefined);
    const id = res && res.data && res.data.id;
    log.info(`[x] tweeted (${account}) id=${id}`);
    return id || null;
  } catch (e) {
    log.warn(`[x] tweet failed (${account}): ${e.message}`);
    return null;
  }
}

function listingText(coin) {
  const tag = symTag(coin.symbol);
  const chain = chainOf(coin.chain) ? chainOf(coin.chain).label : coin.chain;
  return (
    `🚀 New Listing on @${X_HANDLE}\n\n` +
    `${coin.name} ( #${tag} ) · ${chain}\n` +
    `${coinUrl(coin)}\n` +
    `CA: ${coin.address}\n` +
    (coin.price ? `Price: ${fmtPrice(coin.price)}` : "") +
    (coin.mcap ? `  |  MC: $${formatNumber(coin.mcap)}` : "") +
    X_FOOTER
  );
}

function trendingText(coin) {
  const tag = symTag(coin.symbol);
  return (
    `🔥 #${tag} is Trending on @${X_HANDLE}\n\n` +
    `${coin.name}\n${coinUrl(coin)}` +
    X_FOOTER
  );
}

function pumpText(coin, percent, firstMc, lastMc) {
  const tag = symTag(coin.symbol);
  return (
    `📈 Pump Alert #Dexvra 🚨\n\n` +
    `💎 #${tag} is up ${Math.round(percent)}% since listing on Dexvra!\n` +
    `💸 First MC: $${formatNumber(firstMc)} | Last MC: $${formatNumber(lastMc)}\n` +
    `${coinUrl(coin)}\n#NewListing #Altcoin #Memecoin #DYOR`
  );
}

module.exports = {
  enabled: () => X_ENABLED,
  postListing: (coin, media, mime) => send("listing", listingText(coin), media, mime),
  postTrending: (coin, media, mime) => send("listing", trendingText(coin), media, mime),
  postPump: (coin, percent, firstMc, lastMc, media, mime) =>
    send("listing", pumpText(coin, percent, firstMc, lastMc), media, mime),
  postBanner: (booking) =>
    send(
      "official",
      `📢 ${booking.title || "A project"} is now featured on @${X_HANDLE}!\n${booking.linkUrl}\n#Dexvra #Ad`,
      null,
    ),
};
