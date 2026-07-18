// Channel post text — now driven by editable templates (src/templates.js →
// post_listing / post_trending / post_pump / post_banner). This file builds the
// dynamic values (escaped fields, socials line, footer, tier line) and hands
// them to the template engine, so admins can restyle any post via @dexvraadminbot
// without touching code. HTML + Unicode emoji (Bot API).
const { escapeHtml, fmtPrice, formatNumber } = require("../helpers/format");
const { chainOf } = require("../config/chains");
const { tierEmoji, tierLabel } = require("../config/packages");
const { SITE_URL, CHANNELS } = require("../config/constants");
const tpl = require("../templates");

const sym = (s) => {
  const t = String(s || "").replace(/^\$+/, "");
  return t ? `$${t}` : "$TOKEN";
};
const chainName = (c) => (chainOf(c) ? chainOf(c).label : String(c).toUpperCase());
const priceStr = (p) => (p && p > 0 ? fmtPrice(p) : "TBA");
const mcStr = (m) => (m && m > 0 ? "$" + formatNumber(m) : "TBA");
const tme = (handle) => `https://t.me/${String(handle).replace(/^@/, "")}`;

function socialLines(links = {}) {
  const out = [];
  if (links.website) out.push(`🌐 <a href="${escapeHtml(links.website)}">Website</a>`);
  if (links.twitter) out.push(`🐦 <a href="${escapeHtml(links.twitter)}">X</a>`);
  if (links.telegram) out.push(`💬 <a href="${escapeHtml(links.telegram)}">Telegram</a>`);
  return out.length ? out.join("  ·  ") : "";
}

function footer() {
  return (
    `\n\n📎 <b>Dexvra</b>\n` +
    `🌐 <a href="${SITE_URL}">Website</a>  ·  ` +
    `🔥 <a href="${tme(CHANNELS.trending)}">Trending</a>  ·  ` +
    `🚨 <a href="${tme(CHANNELS.listing)}">Listing</a>  ·  ` +
    `📢 <a href="${tme(CHANNELS.announce)}">Announce</a>`
  );
}

const coinUrl = (coin) => coin.siteUrl || `${SITE_URL}/token/${coin.chain}/${coin.address}`;

function listingPost(coin) {
  const tierLine = coin.tier ? `${tierEmoji(coin.tier)} <b>${escapeHtml(tierLabel(coin.tier))}</b>\n` : "";
  const head = coin.tier === "XPRESS" ? "⚡ <b>Dexvra Express Listing</b>" : "🚀 <b>New Listing on Dexvra</b>";
  return tpl.t("post_listing", {
    head,
    tierLine,
    name: escapeHtml(coin.name),
    symbol: escapeHtml(sym(coin.symbol)),
    chain: escapeHtml(chainName(coin.chain)),
    address: escapeHtml(coin.address),
    price: priceStr(coin.price),
    mcap: mcStr(coin.mcap),
    coinUrl: coinUrl(coin),
    socials: socialLines(coin.links),
    footer: footer(),
  });
}

function trendingPost(coin) {
  return tpl.t("post_trending", {
    symbol: escapeHtml(sym(coin.symbol)),
    name: escapeHtml(coin.name),
    chain: escapeHtml(chainName(coin.chain)),
    address: escapeHtml(coin.address),
    price: priceStr(coin.price),
    mcap: mcStr(coin.mcap),
    coinUrl: coinUrl(coin),
    socials: socialLines(coin.links),
    footer: footer(),
  });
}

function pumpPost(coin, percent, firstMc, lastMc) {
  return tpl.t("post_pump", {
    name: escapeHtml(coin.name),
    symbol: escapeHtml(sym(coin.symbol)),
    percent: Math.round(percent),
    firstMc: "$" + formatNumber(firstMc),
    lastMc: "$" + formatNumber(lastMc),
    address: escapeHtml(coin.address),
    coinUrl: coinUrl(coin),
    footer: footer(),
  });
}

function bannerPost(booking) {
  return tpl.t("post_banner", {
    title: booking.title ? escapeHtml(booking.title) : "A featured project",
    slot: escapeHtml(booking.slot),
    linkUrl: escapeHtml(booking.linkUrl),
    footer: footer(),
  });
}

module.exports = { listingPost, trendingPost, pumpPost, bannerPost, coinUrl, sym, chainName };
