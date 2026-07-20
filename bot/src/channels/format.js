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
const tokenEmoji = require("../tokenEmoji");

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
const cleanUrl = (v) => premium.sanitizeUrl(v); // user URLs → can't close [label](url)

// Tier badges — premium where fourtis has proven IDs, unicode otherwise.
const TIER_EMOJI = {
  DIAMOND: em("💎", E.diamond),
  GOLD: em("🥇", E.gold),
  SILVER: "🥈",
  BRONZE: "🥉",
  XPRESS: em("⚡", E.zap),
};

// Carries its own trailing spacing so the template collapses cleanly (no
// stray blank lines) when a token has no socials.
function socialLines(links = {}) {
  const out = [];
  if (links.website) out.push(`[Website](${cleanUrl(links.website)})`);
  if (links.twitter) out.push(`[X](${cleanUrl(links.twitter)})`);
  if (links.telegram) out.push(`[Telegram](${cleanUrl(links.telegram)})`);
  return out.length ? `${em("🌐", E.globe)} ${out.join(" · ")}\n\n` : "";
}

// Fallback overview for tokens with no description (fresh pump.fun launches
// rarely have one on GT) — the post always reads complete. Context-aware and
// deliberately does NOT mention dexvra.io or stats: the CTA and data rows
// directly below already carry those (review finding: duplication).
function autoOverview(coin, mode) {
  const nm = String(coin.name || "").trim();
  const sy = sym(coin.symbol);
  const ch = chainName(coin.chain);
  if (!nm) return "";
  return mode === "trending"
    ? `${nm} (${sy}) currently holds a featured slot on the Dexvra Trending board.`
    : `${nm} (${sy}) has just gone live on ${ch}.`;
}

// Project overview paragraph — one clean block under the title, own spacing.
// Truncation counts CODE POINTS (Array.from), never slicing through a
// surrogate pair — overviews routinely contain emoji, and a split pair sends
// ill-formed U+FFFD text to Telegram.
function overviewBlock(text) {
  if (!text) return "";
  let s = String(text).replace(/\s+/g, " ").trim();
  if (!s) return "";
  const chars = Array.from(s);
  if (chars.length > 300) {
    s = chars.slice(0, 300).join("");
    const cut = s.lastIndexOf(" ");
    s = (cut > 200 ? s.slice(0, cut) : s).trimEnd() + "…";
  }
  return `${clean(s)}\n\n`;
}

function footer() {
  return (
    `\n\n${em("💎", E.diamond)} **Dexvra** · [dexvra.io](${SITE_URL}) · ` +
    `[Trending](${tme(CHANNELS.trending)}) · ` +
    `[Listings](${tme(CHANNELS.listing)}) · ` +
    `[Announcements](${tme(CHANNELS.announce)})`
  );
}

const coinUrl = (coin) => coin.siteUrl || `${SITE_URL}/token/${coin.chain}/${coin.address}`;

function listingPost(coin) {
  const tierBadge = TIER_EMOJI[String(coin.tier || "").toUpperCase()] || "";
  const tierLine =
    coin.tier && coin.tier !== "XPRESS"
      ? `${tierBadge} **${clean(tierLabel(coin.tier))} tier** — featured placement\n`
      : "";
  const head =
    coin.tier === "XPRESS"
      ? `${em("⚡", E.zap)} **Xpress Listing — live on Dexvra**`
      : `${em("🚨", E.sirenHead)} **New Listing on Dexvra**`;
  return tpl.render("post_listing", {
    head,
    tierLine,
    logoEmoji: tokenEmoji.emojiTag(coin.chain, coin.address, coin.symbol),
    overview: overviewBlock(coin.overview || autoOverview(coin, "listing")),
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
    logoEmoji: tokenEmoji.emojiTag(coin.chain, coin.address, coin.symbol),
    overview: overviewBlock(coin.overview || autoOverview(coin, "trending")),
    address: clean(coin.address),
    price: priceStr(coin.price),
    mcap: mcStr(coin.mcap),
    coinUrl: coinUrl(coin),
    socials: socialLines(coin.links),
    footer: footer(),
  });
}

// "×" multiple from a percent gain: +540% → "6.4×", +100% → "2×".
function xMultiple(percent) {
  const x = 1 + percent / 100;
  return (Number.isInteger(x) ? String(x) : x.toFixed(1)) + "×";
}

function pumpPost(coin, percent, firstMc, lastMc) {
  return tpl.render("post_pump", {
    name: clean(coin.name),
    symbol: clean(sym(coin.symbol)),
    percent: Math.round(percent),
    multiple: xMultiple(percent),
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
    linkUrl: cleanUrl(booking.linkUrl),
    footer: footer(),
  });
}

const withCommas = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

// A clean optional 24h-change sentence. Non-positive / invalid → omitted.
// Absurd low-liquidity readings (e.g. +490,749%) look like spam, so above a
// sane cap we state momentum without the junk number.
function changeSentence(change24h) {
  const v = Number(change24h);
  if (!Number.isFinite(v) || v <= 0) return "";
  if (v > 5000) return " Momentum is building over the last 24h.";
  return ` Up +${withCommas(Math.round(v))}% over the last 24h.`;
}

function rankupPost(coin, rank, change24h) {
  return tpl.render("post_rankup", {
    symbol: clean(sym(coin.symbol)),
    name: clean(coin.name),
    chain: clean(chainName(coin.chain)),
    rank,
    change: changeSentence(change24h),
    coinUrl: coinUrl(coin),
    footer: footer(),
  });
}

module.exports = { listingPost, trendingPost, pumpPost, bannerPost, rankupPost, coinUrl, sym, chainName };
