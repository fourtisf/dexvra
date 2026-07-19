// Channel post payloads — driven by editable templates (src/templates.js →
// post_listing / post_trending / post_pump / post_banner). This file builds the
// dynamic values (sanitized fields, socials line, footer, tier line) in PREMIUM
// MARKUP and hands them to the template engine; the result is a
// { text, entities } payload (or { html } for a legacy saved template) that
// channels/post.js sends — GramJS first (premium emoji animate), Bot API
// fallback. Admins restyle any post via @dexvraadminbot without touching code.
const { fmtPrice, formatNumber } = require("../helpers/format");
const { chainOf } = require("../config/chains");
const { tierLabel } = require("../config/packages");
const { SITE_URL, CHANNELS } = require("../config/constants");
const premium = require("../premium");
const tpl = require("../templates");

const { EMOJI: E, em } = tpl;

const sym = (s) => {
  const t = String(s || "").replace(/^\$+/, "");
  return t ? `$${t}` : "$TOKEN";
};
const chainName = (c) => (chainOf(c) ? chainOf(c).label : String(c).toUpperCase());
const priceStr = (p) => (p && p > 0 ? fmtPrice(p) : "TBA");
const mcStr = (m) => (m && m > 0 ? "$" + formatNumber(m) : "TBA");
const tme = (handle) => `https://t.me/${String(handle).replace(/^@/, "")}`;
const clean = (v) => premium.sanitizeVar(v); // user-supplied values → markup-safe

// Tier badges — premium where fourtis has proven IDs, unicode otherwise.
const TIER_EMOJI = {
  DIAMOND: em("💎", E.diamond),
  GOLD: em("🥇", E.gold),
  SILVER: "🥈",
  BRONZE: "🥉",
  XPRESS: em("⚡", E.zap),
};

function socialLines(links = {}) {
  const out = [];
  if (links.website) out.push(`${em("🌐", E.globe)}[Website](${links.website})`);
  if (links.twitter) out.push(`${em("🚀", E.rocket)}[X](${links.twitter})`);
  if (links.telegram) out.push(`${em("✈️", E.plane)}[Telegram](${links.telegram})`);
  return out.length ? out.join("  ·  ") : "";
}

function footer() {
  return (
    `\n\n${em("📎", E.clip)} **Dexvra**\n` +
    `${em("🌐", E.globe2)} [Website](${SITE_URL})  ·  ` +
    `🔥 [Trending](${tme(CHANNELS.trending)})  ·  ` +
    `${em("🚨", E.siren)} [Listing](${tme(CHANNELS.listing)})  ·  ` +
    `${em("📢", E.megaphone)} [Announce](${tme(CHANNELS.announce)})`
  );
}

const coinUrl = (coin) => coin.siteUrl || `${SITE_URL}/token/${coin.chain}/${coin.address}`;

function listingPost(coin) {
  const tierBadge = TIER_EMOJI[String(coin.tier || "").toUpperCase()] || "";
  const tierLine =
    coin.tier && coin.tier !== "XPRESS" ? `${tierBadge} **${clean(tierLabel(coin.tier))}**\n` : "";
  const head =
    coin.tier === "XPRESS"
      ? `${em("⚡", E.zap)} **Dexvra Express Listing** ${em("⚡", E.zap)}`
      : `${em("🚨", E.sirenHead)} **New Listing on Dexvra** ${em("🚨", E.sirenHead)}`;
  return tpl.render("post_listing", {
    head,
    tierLine,
    name: clean(coin.name),
    symbol: clean(sym(coin.symbol)),
    chain: clean(chainName(coin.chain)),
    address: clean(coin.address),
    price: priceStr(coin.price),
    mcap: mcStr(coin.mcap),
    coinUrl: coinUrl(coin),
    socials: socialLines(coin.links),
    footer: footer(),
  });
}

function trendingPost(coin) {
  return tpl.render("post_trending", {
    symbol: clean(sym(coin.symbol)),
    name: clean(coin.name),
    chain: clean(chainName(coin.chain)),
    address: clean(coin.address),
    price: priceStr(coin.price),
    mcap: mcStr(coin.mcap),
    coinUrl: coinUrl(coin),
    socials: socialLines(coin.links),
    footer: footer(),
  });
}

function pumpPost(coin, percent, firstMc, lastMc) {
  return tpl.render("post_pump", {
    name: clean(coin.name),
    symbol: clean(sym(coin.symbol)),
    percent: Math.round(percent),
    firstMc: "$" + formatNumber(firstMc),
    lastMc: "$" + formatNumber(lastMc),
    address: clean(coin.address),
    coinUrl: coinUrl(coin),
    footer: footer(),
  });
}

function bannerPost(booking) {
  return tpl.render("post_banner", {
    title: booking.title ? clean(booking.title) : "A featured project",
    slot: clean(booking.slot),
    linkUrl: booking.linkUrl,
    footer: footer(),
  });
}

module.exports = { listingPost, trendingPost, pumpPost, bannerPost, coinUrl, sym, chainName };
