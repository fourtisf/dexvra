// Channel post text builders (HTML, Unicode emoji — a Bot API bot can't send
// premium custom emoji). Structure mirrors the fourtis cards. `coin`:
//   { name, symbol, chain, address, tier, price, mcap, links:{website,twitter,telegram}, siteUrl }
const { escapeHtml, fmtPrice, formatNumber } = require("../helpers/format");
const { chainOf } = require("../config/chains");
const { tierEmoji, tierLabel } = require("../config/packages");
const { SITE_URL, CHANNELS } = require("../config/constants");

const sym = (s) => {
  const t = String(s || "").replace(/^\$+/, "");
  return t ? `$${t}` : "$TOKEN";
};
const chainName = (c) => (chainOf(c) ? chainOf(c).label : String(c).toUpperCase());
const priceStr = (p) => (p && p > 0 ? fmtPrice(p) : "TBA");
const mcStr = (m) => (m && m > 0 ? "$" + formatNumber(m) : "TBA");

function tme(handle) {
  return `https://t.me/${String(handle).replace(/^@/, "")}`;
}

/** Project social links block (only the ones present). */
function socialLines(links = {}) {
  const out = [];
  if (links.website) out.push(`🌐 <a href="${escapeHtml(links.website)}">Website</a>`);
  if (links.twitter) out.push(`🐦 <a href="${escapeHtml(links.twitter)}">X</a>`);
  if (links.telegram) out.push(`💬 <a href="${escapeHtml(links.telegram)}">Telegram</a>`);
  return out.length ? out.join("  ·  ") : "";
}

/** Dexvra footer common to every post. */
function footer() {
  return (
    `\n\n📎 <b>Dexvra</b>\n` +
    `🌐 <a href="${SITE_URL}">Website</a>  ·  ` +
    `🔥 <a href="${tme(CHANNELS.trending)}">Trending</a>  ·  ` +
    `🚨 <a href="${tme(CHANNELS.listing)}">Listing</a>  ·  ` +
    `📢 <a href="${tme(CHANNELS.announce)}">Announce</a>`
  );
}

function coinUrl(coin) {
  return coin.siteUrl || `${SITE_URL}/token/${coin.chain}/${coin.address}`;
}

function listingPost(coin) {
  const tierLine = coin.tier
    ? `${tierEmoji(coin.tier)} <b>${escapeHtml(tierLabel(coin.tier))}</b>\n`
    : "";
  const head = coin.tier === "XPRESS" ? "⚡ <b>Dexvra Express Listing</b>" : "🚀 <b>New Listing on Dexvra</b>";
  const social = socialLines(coin.links);
  return (
    `${head}\n\n` +
    tierLine +
    `<b>${escapeHtml(coin.name)}</b> <a href="${coinUrl(coin)}">(${escapeHtml(sym(coin.symbol))})</a>\n` +
    `🔗 <b>Contract:</b>\n<code>${escapeHtml(coin.address)}</code>\n` +
    `📊 <b>Chain:</b> ${escapeHtml(chainName(coin.chain))}\n` +
    `💲 <b>Price:</b> ${priceStr(coin.price)}  |  <b>MC:</b> ${mcStr(coin.mcap)}\n` +
    (social ? `${social}\n` : "") +
    `\n🟢 <a href="${coinUrl(coin)}">Buy / View on Dexvra</a>` +
    footer()
  );
}

function trendingPost(coin) {
  const social = socialLines(coin.links);
  return (
    `🔥 <b>${escapeHtml(sym(coin.symbol))} is now Trending on Dexvra</b> ⚡\n\n` +
    `<b>${escapeHtml(coin.name)}</b>  ·  ${escapeHtml(chainName(coin.chain))}\n` +
    `🔗 <b>CA:</b> <code>${escapeHtml(coin.address)}</code>\n` +
    `💲 <b>Price:</b> ${priceStr(coin.price)}  |  <b>MC:</b> ${mcStr(coin.mcap)}\n` +
    (social ? `${social}\n` : "") +
    `\n🔥 <a href="${coinUrl(coin)}">View on Dexvra Trending</a>` +
    footer()
  );
}

function pumpPost(coin, percent, firstMc, lastMc) {
  const pct = Math.round(percent);
  return (
    `📈 <b>Pump Alert — Dexvra</b> ⚡\n\n` +
    `<b>${escapeHtml(coin.name)} | ${escapeHtml(sym(coin.symbol))}</b> is up <b>${pct}%</b> since listing on ` +
    `<a href="${coinUrl(coin)}">Dexvra</a>\n\n` +
    `🚨 <b>First MC:</b> $${formatNumber(firstMc)}  |  <b>Last MC:</b> $${formatNumber(lastMc)}\n` +
    `🔗 <code>${escapeHtml(coin.address)}</code>` +
    footer()
  );
}

function bannerPost(booking) {
  const title = booking.title ? escapeHtml(booking.title) : "A featured project";
  return (
    `📢 <b>Featured on Dexvra</b>\n\n` +
    `${title} is now running a <b>${escapeHtml(booking.slot)}</b> banner across Dexvra.\n` +
    `👉 <a href="${escapeHtml(booking.linkUrl)}">Check it out</a>` +
    footer()
  );
}

module.exports = { listingPost, trendingPost, pumpPost, bannerPost, coinUrl, sym, chainName };
