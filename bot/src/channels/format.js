// Channel post payloads — driven by editable WYSIWYG templates (src/templates.js
// → post_listing_xpress / post_listing_tiered / post_trending / post_banner /
// post_rankup / post_pump). Each template IS the full post; this file supplies
// the sanitized live values, strips the social/tier lines the token lacks, and
// hands the result to the template engine → a { text, entities } payload (or
// { html } for a legacy saved template) that channels/post.js sends — GramJS
// first (premium emoji animate), Bot API fallback. Admins restyle any post via
// @dexvraadminbot without touching code.
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

// ── WYSIWYG template stripping ───────────────────────────────────────────────
// Every channel-post template stores the FULL post (header, socials, footer
// inline). Before rendering, lines for data the token doesn't have are removed:
//   • a social line ({twitter}/{website}/{telegram}) whose link is missing
//   • the whole social paragraph — incl. its header line — when ALL its social
//     lines dropped (a token with no socials never shows an orphan header)
//   • the {tierEmoji}/{tier} badge line on a listing without a tier
// Works on BOTH stored forms: markup strings and admin-pasted {text, entities}
// (line ranges are removed and entity offsets remapped, so premium emoji stay
// glued to the right characters).
const SOCIAL_KEYS = ["twitter", "website", "telegram"];

function stripLines(val, { all, missing, dropParagraph }) {
  if (!missing.length) return val;
  const isEntity = val && typeof val === "object" && val.text != null;
  const text = isEntity ? val.text : String(val);
  const lines = text.split("\n");
  const refs = (line, keys) => keys.filter((k) => line.includes(`{${k}}`));
  const drop = lines.map((l) => {
    const r = refs(l, all);
    return r.length > 0 && r.every((k) => missing.includes(k));
  });
  if (dropParagraph) {
    let start = 0;
    for (let i = 0; i <= lines.length; i++) {
      if (i < lines.length && lines[i].trim() !== "") continue;
      const para = [];
      for (let j = start; j < i; j++) para.push(j);
      const tracked = para.filter((j) => refs(lines[j], all).length > 0);
      if (tracked.length && tracked.every((j) => drop[j])) {
        for (const j of para) drop[j] = true;
        if (i < lines.length) drop[i] = true; // the blank separator below it
      }
      start = i + 1;
    }
  }
  if (!drop.some(Boolean)) return val;
  if (!isEntity) return lines.filter((_, i) => !drop[i]).join("\n"); // collapseGaps cleans leftovers
  return dropEntityLines(val, lines, drop);
}

// Remove dropped lines from an ENTITY template: cut their UTF-16 ranges out of
// the text, shift/shrink entities across the cuts, drop entities inside them.
function dropEntityLines(val, lines, drop) {
  const ranges = []; // merged [start, end) ranges, end incl the trailing \n
  let off = 0;
  for (let i = 0; i < lines.length; i++) {
    const len = lines[i].length + (i < lines.length - 1 ? 1 : 0);
    if (drop[i]) {
      const prev = ranges[ranges.length - 1];
      if (prev && prev[1] === off) prev[1] = off + len;
      else ranges.push([off, off + len]);
    }
    off += len;
  }
  const removedBefore = (pos) => {
    let n = 0;
    for (const [s, e] of ranges) {
      if (pos <= s) break;
      n += Math.min(pos, e) - s;
    }
    return n;
  };
  let text = "";
  let last = 0;
  for (const [s, e] of ranges) {
    text += val.text.slice(last, s);
    last = e;
  }
  text += val.text.slice(last);
  const entities = [];
  for (const e of val.entities || []) {
    const s = e.offset - removedBefore(e.offset);
    const en = e.offset + e.length - removedBefore(e.offset + e.length);
    if (en - s > 0) entities.push({ ...e, offset: s, length: en - s });
  }
  return { text, entities };
}

/** The template for `key`, with the lines the token can't fill stripped out —
 *  social links it lacks, the "Announce On X" line when no tweet was made, the
 *  tier badge line on an untiered listing — ready for tpl.renderValue(). */
function stripForCoin(key, coin, { noTier } = {}) {
  const links = (coin && coin.links) || {};
  let val = tpl.getRawValue(key);
  const missing = SOCIAL_KEYS.filter((k) => !links[k]);
  val = stripLines(val, { all: SOCIAL_KEYS, missing, dropParagraph: true });
  if (!(coin && coin.xUrl)) {
    val = stripLines(val, { all: ["xUrl"], missing: ["xUrl"], dropParagraph: true });
  }
  if (noTier) {
    val = stripLines(val, { all: ["tierEmoji", "tier"], missing: ["tierEmoji", "tier"], dropParagraph: false });
  }
  return val;
}

// Legacy {socials} var (templates saved before the one-template-per-post era):
// the built block, one social per line, missing links dropped, "" when none.
function legacySocials(coin) {
  const links = coin.links || {};
  if (!SOCIAL_KEYS.some((k) => links[k])) return "";
  const kept = tpl.SOCIALS_BLOCK.split("\n")
    .filter((line) => !SOCIAL_KEYS.some((k) => line.includes(`{${k}}`) && !links[k]))
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

// Dexvra channel-link URLs — substituted into the footer's [label]({site}) etc.
function channelLinks() {
  return {
    site: SITE_URL,
    listing: tme(CHANNELS.listing),
    trending: tme(CHANNELS.trending),
    announce: tme(CHANNELS.announce),
  };
}

// Legacy {footer} var (pre-WYSIWYG saved templates): the built footer block.
function legacyFooter() {
  return "\n\n" + tpl.substitute(tpl.FOOTER_BLOCK, channelLinks());
}

// Vars shared by every coin-based channel post — live values plus the legacy
// {socials}/{footer} vars so admin templates saved before the restructure keep
// rendering their blocks.
function coinVars(coin) {
  const links = coin.links || {};
  return {
    name: clean(coin.name),
    symbol: clean(sym(coin.symbol)),
    chainEmoji: chainEmoji(coin.chain),
    chain: clean(chainName(coin.chain)),
    address: clean(coin.address),
    price: priceStr(coin.price),
    mcap: mcStr(coin.mcap),
    liq: liqStr(coin.liq),
    coinUrl: coinUrl(coin),
    coinUrlLabel: coinUrlLabel(coin),
    twitter: links.twitter ? cleanUrl(links.twitter) : "",
    website: links.website ? cleanUrl(links.website) : "",
    telegram: links.telegram ? cleanUrl(links.telegram) : "",
    xUrl: coin.xUrl ? cleanUrl(coin.xUrl) : "",
    ...channelLinks(),
    socials: legacySocials(coin),
    footer: legacyFooter(),
  };
}

const coinUrl = (coin) => coin.siteUrl || `${SITE_URL}/token/${coin.chain}/${coin.address}`;
// The link LABEL shows the FULL token-page path (never truncated — operator
// wants the complete dexvra.io/token/<chain>/<address> visible).
const coinUrlLabel = (coin) => coinUrl(coin).replace(/^https?:\/\//, "");

function listingPost(coin) {
  const isXpress = coin.tier === "XPRESS";
  const key = isXpress ? "post_listing_xpress" : "post_listing_tiered";
  const val = stripForCoin(key, coin, { noTier: !coin.tier });
  return tpl.renderValue(val, {
    ...coinVars(coin),
    logoEmoji: tokenEmoji.emojiTag(coin.chain, coin.address, coin.symbol),
    tierEmoji: coin.tier ? TIER_EMOJI[String(coin.tier).toUpperCase()] || "" : "",
    tier: coin.tier ? clean(tierLabel(coin.tier)) : "",
    overview: overviewBlock(coin.overview || autoOverview(coin, "listing")), // legacy
  });
}

function trendingPost(coin) {
  const val = stripForCoin("post_trending", coin);
  return tpl.renderValue(val, {
    ...coinVars(coin),
    logoEmoji: tokenEmoji.emojiTag(coin.chain, coin.address, coin.symbol),
    overview: overviewBlock(coin.overview || autoOverview(coin, "trending")), // legacy
  });
}

// "×" multiple from a percent gain: +540% → "6.4×", +100% → "2×".
function xMultiple(percent) {
  const x = 1 + percent / 100;
  return (Number.isInteger(x) ? String(x) : x.toFixed(1)) + "×";
}

function pumpPost(coin, percent, firstMc, lastMc) {
  const val = stripForCoin("post_pump", coin);
  return tpl.renderValue(val, {
    ...coinVars(coin),
    percent: Math.round(percent),
    multiple: xMultiple(percent),
    firstMc: "$" + formatNumber(firstMc),
    lastMc: "$" + formatNumber(lastMc),
  });
}

function bannerPost(booking) {
  // No token on a banner post — any social lines an admin adds strip away.
  const val = stripForCoin("post_banner", null);
  return tpl.renderValue(val, {
    title: booking.title ? clean(booking.title) : "A featured project",
    slot: clean(booking.slot),
    linkUrl: cleanUrl(booking.linkUrl),
    ...channelLinks(),
    footer: legacyFooter(),
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
  const val = stripForCoin("post_rankup", coin);
  return tpl.renderValue(val, {
    ...coinVars(coin),
    rank,
    change: changeSentence(change24h),
  });
}

module.exports = { listingPost, trendingPost, pumpPost, bannerPost, rankupPost, coinUrl, sym, chainName };
