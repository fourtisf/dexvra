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
// When the admin PASTED premium custom emoji, the template is stored as
// {text, entities} and the text alone only carries the unicode fallback — so
// rebuild each mapping as premium markup ([fallback](emoji/ID)) from the
// entities, letting the custom emoji survive into the rendered post.
function chainEmojiMap() {
  const val = tpl.getRawValue("chain_emojis");
  const isEntity = val && typeof val === "object" && val.text != null;
  const text = isEntity ? val.text : String(val || "");
  const ents = ((isEntity && val.entities) || []).filter((e) => e.type === "custom_emoji" && e.custom_emoji_id);
  const map = {};
  let off = 0;
  for (const line of text.split("\n")) {
    const lineStart = off;
    off += line.length + 1;
    const i = line.indexOf("=");
    if (i <= 0) continue;
    const k = line.slice(0, i).trim().toLowerCase();
    const rest = line.slice(i + 1);
    let v = rest.trim();
    if (!k || !v) continue;
    if (ents.length) {
      const vStart = lineStart + i + 1 + (rest.length - rest.trimStart().length);
      const vEnd = vStart + v.length;
      const inLine = ents
        .filter((e) => e.offset >= vStart && e.offset + e.length <= vEnd)
        .sort((a, b) => a.offset - b.offset);
      if (inLine.length) {
        let out = "";
        let pos = vStart;
        for (const e of inLine) {
          out += text.slice(pos, e.offset) + `[${text.slice(e.offset, e.offset + e.length)}](emoji/${e.custom_emoji_id})`;
          pos = e.offset + e.length;
        }
        v = out + text.slice(pos, vEnd);
      }
    }
    map[k] = v;
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

const SEG_SEP = /\s*[·|]\s*/g; // side-by-side row separators: " · " or " | "

function stripLines(val, { all, missing, dropParagraph }) {
  if (!missing.length) return val;
  const isEntity = val && typeof val === "object" && val.text != null;
  const text = isEntity ? val.text : String(val);
  const lines = text.split("\n");
  const refs = (s, keys) => keys.filter((k) => s.includes(`{${k}}`));
  const drop = new Array(lines.length).fill(false);
  const starts = [];
  {
    let off = 0;
    for (let i = 0; i < lines.length; i++) {
      starts[i] = off;
      off += lines[i].length + 1;
    }
  }
  const segCuts = [];
  for (let i = 0; i < lines.length; i++) {
    const r = refs(lines[i], all);
    if (!r.length) continue;
    if (r.every((k) => missing.includes(k))) drop[i] = true; // whole line dead
    else segCuts.push(...segmentCuts(lines[i], starts[i], r.filter((k) => missing.includes(k))));
  }
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
  const ranges = [];
  for (let i = 0; i < lines.length; i++) {
    if (drop[i]) ranges.push([starts[i], starts[i] + lines[i].length + (i < lines.length - 1 ? 1 : 0)]);
  }
  ranges.push(...segCuts);
  const merged = mergeRanges(ranges);
  if (!merged.length) return val;
  return cutRanges(isEntity ? val : text, merged, isEntity);
}

// A side-by-side row ("❌ [X]({twitter}) · 🌐 [Website]({website}) · …") keeps
// its live segments: a segment whose link is missing is cut together with ONE
// adjacent separator so the row collapses cleanly. Rows with no separators
// fall back to whole-line semantics (handled by the caller's line pass).
function segmentCuts(line, base, missKeys) {
  if (!missKeys.length) return [];
  const seps = [];
  SEG_SEP.lastIndex = 0;
  let m;
  while ((m = SEG_SEP.exec(line)) !== null) seps.push([m.index, m.index + m[0].length]);
  if (!seps.length) return [];
  const segs = [];
  let pos = 0;
  for (const [s, e] of seps) {
    segs.push({ start: pos, end: s });
    pos = e;
  }
  segs.push({ start: pos, end: line.length });
  const cuts = [];
  for (let j = 0; j < segs.length; j++) {
    const s = line.slice(segs[j].start, segs[j].end);
    if (!missKeys.some((k) => s.includes(`{${k}}`))) continue;
    const cutStart = j > 0 ? segs[j - 1].end : segs[j].start; // take the separator BEFORE…
    const cutEnd = j > 0 ? segs[j].end : segs[j + 1] ? segs[j + 1].start : segs[j].end; // …or AFTER for the first segment
    cuts.push([base + cutStart, base + cutEnd]);
  }
  return cuts;
}

function mergeRanges(ranges) {
  const sorted = ranges.filter(([s, e]) => e > s).sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else out.push([r[0], r[1]]);
  }
  return out;
}

// Cut [start, end) ranges out of the text; the entity form also shifts/shrinks
// entities across the cuts (UTF-16 units) and drops the ones inside them.
function cutRanges(valOrText, ranges, isEntity) {
  const text = isEntity ? valOrText.text : valOrText;
  const removedBefore = (pos) => {
    let n = 0;
    for (const [s, e] of ranges) {
      if (pos <= s) break;
      n += Math.min(pos, e) - s;
    }
    return n;
  };
  let out = "";
  let last = 0;
  for (const [s, e] of ranges) {
    out += text.slice(last, s);
    last = e;
  }
  out += text.slice(last);
  if (!isEntity) return out;
  const entities = [];
  for (const e of valOrText.entities || []) {
    const s = e.offset - removedBefore(e.offset);
    const en = e.offset + e.length - removedBefore(e.offset + e.length);
    if (en - s > 0) entities.push({ ...e, offset: s, length: en - s });
  }
  return { text: out, entities };
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

// The CA must be ONE-TAP COPYABLE — Telegram copies `code`-formatted text on
// tap. The default templates keep {address} bare and the VALUE arrives pre-
// wrapped as `code` markup, so tap-to-copy survives ANY admin rewrite of the
// template (incl. plain-text pastes that lose formatting). A legacy template
// that still writes its own `{address}` backticks keeps them — pre-wrapping
// there would leak stray backtick characters around the address.
function addressVar(val, address) {
  const text = val && typeof val === "object" && val.text != null ? val.text : String(val);
  const a = clean(address);
  return text.includes("`{address}`") ? a : a ? "`" + a + "`" : "";
}

// Legacy {socials} var (templates saved before the one-template-per-post era):
// the built block with missing links stripped the same way, "" when none.
function legacySocials(coin) {
  const links = coin.links || {};
  if (!SOCIAL_KEYS.some((k) => links[k])) return "";
  const missing = SOCIAL_KEYS.filter((k) => !links[k]);
  const kept = String(stripLines(tpl.SOCIALS_BLOCK, { all: SOCIAL_KEYS, missing, dropParagraph: false }));
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
    address: addressVar(val, coin.address),
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
    address: addressVar(val, coin.address),
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
    address: addressVar(val, coin.address),
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
    address: addressVar(val, coin.address),
    rank,
    change: changeSentence(change24h),
  });
}

module.exports = { listingPost, trendingPost, pumpPost, bannerPost, rankupPost, coinUrl, sym, chainName };
