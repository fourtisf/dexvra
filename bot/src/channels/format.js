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
// Per-network emoji the bot AUTO-PICKS from the token's chain, driven by the
// editable `chain_emojis` template (one `chainid = emoji` per line). Unknown
// chains fall back to 💠 so the "Chain:" line always has a leading glyph.
function chainEmojiMap() {
  const map = {};
  for (const line of String(tpl.getRaw("chain_emojis") || "").split("\n")) {
    const i = line.indexOf("=");
    if (i <= 0) continue;
    const k = line.slice(0, i).trim().toLowerCase();
    const v = line.slice(i + 1).trim();
    if (k && v) map[k] = v;
  }
  return map;
}
function chainEmoji(chain) {
  const id = (chainOf(chain) && chainOf(chain).id) || String(chain || "").toLowerCase();
  return chainEmojiMap()[id] || "💠";
}
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

const liqStr = (n) => (n && Number(n) > 0 ? "$" + formatNumber(n) : "—");
const twitterInline = (links) => (links && links.twitter ? ` | [X](${cleanUrl(links.twitter)})` : "");

// Social-links block — driven by the editable `post_socials` template (admins
// change the emoji/label/layout in @dexvraadminbot). One social PER LINE; a line
// whose link the token lacks is dropped so the block never shows a dead link.
// Returns "" for a token with no socials so the parent template collapses.
function socialsBlock(coin) {
  const links = coin.links || {};
  const present = { twitter: !!links.twitter, website: !!links.website, telegram: !!links.telegram };
  if (!present.twitter && !present.website && !present.telegram) return "";
  const kept = tpl
    .getRaw("post_socials")
    .split("\n")
    .filter((line) => !["twitter", "website", "telegram"].some((k) => line.includes(`{${k}}`) && !present[k]))
    .join("\n");
  const out = tpl.substitute(kept, {
    symbol: clean(sym(coin.symbol)),
    twitter: links.twitter ? cleanUrl(links.twitter) : "",
    website: links.website ? cleanUrl(links.website) : "",
    telegram: links.telegram ? cleanUrl(links.telegram) : "",
  });
  return out + "\n\n";
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
    ? `${nm} (${sy}) is featured on the Dexvra Trending board.`
    : `${nm} (${sy}) is now live and trading on ${ch}.`;
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

// Footer block — driven by the editable `post_footer` template (admins change
// the emoji/labels in @dexvraadminbot; the channel URLs stay {placeholders}).
function footer() {
  return (
    "\n\n" +
    tpl.substitute(tpl.getRaw("post_footer"), {
      site: SITE_URL,
      listing: tme(CHANNELS.listing),
      trending: tme(CHANNELS.trending),
      announce: tme(CHANNELS.announce),
    })
  );
}

const coinUrl = (coin) => coin.siteUrl || `${SITE_URL}/token/${coin.chain}/${coin.address}`;
// The link LABEL shows the FULL token-page path (never truncated — operator
// wants the complete dexvra.io/token/<chain>/<address> visible).
const coinUrlLabel = (coin) => coinUrl(coin).replace(/^https?:\/\//, "");

function listingPost(coin) {
  const tierBadge = TIER_EMOJI[String(coin.tier || "").toUpperCase()] || "";
  const tierLine =
    coin.tier && coin.tier !== "XPRESS"
      ? `\n${tierBadge} **${clean(tierLabel(coin.tier))} tier**`
      : "";
  const head =
    coin.tier === "XPRESS"
      ? `${em("⚡", E.zap)} **Xpress Listing — ${clean(coin.name)} live on Dexvra**`
      : `${em("🚨", E.sirenHead)} **New Listing on Dexvra**`;
  return tpl.render("post_listing", {
    head,
    tierLine,
    logoEmoji: tokenEmoji.emojiTag(coin.chain, coin.address, coin.symbol),
    overview: overviewBlock(coin.overview || autoOverview(coin, "listing")),
    name: clean(coin.name),
    symbol: clean(sym(coin.symbol)),
    twitter: twitterInline(coin.links),
    chainEmoji: chainEmoji(coin.chain),
    chain: clean(chainName(coin.chain)),
    address: clean(coin.address),
    price: priceStr(coin.price),
    mcap: mcStr(coin.mcap),
    liq: liqStr(coin.liq),
    coinUrl: coinUrl(coin),
    coinUrlLabel: coinUrlLabel(coin),
    socials: socialsBlock(coin),
    footer: footer(),
  });
}

function trendingPost(coin) {
  return tpl.render("post_trending", {
    symbol: clean(sym(coin.symbol)),
    name: clean(coin.name),
    chainEmoji: chainEmoji(coin.chain),
    chain: clean(chainName(coin.chain)),
    logoEmoji: tokenEmoji.emojiTag(coin.chain, coin.address, coin.symbol),
    overview: overviewBlock(coin.overview || autoOverview(coin, "trending")),
    address: clean(coin.address),
    price: priceStr(coin.price),
    mcap: mcStr(coin.mcap),
    liq: liqStr(coin.liq),
    coinUrl: coinUrl(coin),
    coinUrlLabel: coinUrlLabel(coin),
    socials: socialsBlock(coin),
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
    chainEmoji: chainEmoji(coin.chain),
    chain: clean(chainName(coin.chain)),
    address: clean(coin.address),
    coinUrl: coinUrl(coin),
    socials: socialsBlock(coin),
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
  // Own emphasized line under the body. Absurd low-liquidity readings
  // (e.g. +490,749%) look like spam, so above a sane cap we drop the number.
  if (v > 5000) return "\n\n**Momentum is surging** over the last 24h.";
  return `\n\n**+${withCommas(Math.round(v))}%** over the last 24h — and still climbing.`;
}

function rankupPost(coin, rank, change24h) {
  return tpl.render("post_rankup", {
    symbol: clean(sym(coin.symbol)),
    name: clean(coin.name),
    chainEmoji: chainEmoji(coin.chain),
    chain: clean(chainName(coin.chain)),
    rank,
    change: changeSentence(change24h),
    coinUrl: coinUrl(coin),
    socials: socialsBlock(coin),
    footer: footer(),
  });
}

module.exports = { listingPost, trendingPost, pumpPost, bannerPost, rankupPost, coinUrl, sym, chainName };
