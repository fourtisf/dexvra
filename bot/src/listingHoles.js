"use strict";
/**
 * What a listing still lacks, and what a later read may fill in — the ONE owner
 * of that rule, for the two places that ask it.
 *
 * $KVR (KOVRA, pump.fun) came back "Logo: not set · Website: not set · X: not
 * set" on its review card, and `launchpads:check` on the box, minutes later,
 * prefilled all three from the mint's own metadata. So the miss was a minute,
 * not a token: an RPC refusing this box for a few seconds, or a CID no gateway
 * held yet. Two later reads exist so that minute stops being permanent:
 *
 *   1. the review card's second look (handlers/listing.js `lateFill`), while
 *      the buyer is still reading it;
 *   2. fulfilment's FINAL look (fulfillment.js `finalLook`), immediately before
 *      the row is created — for the buyer who confirmed inside four seconds, or
 *      whose second look met the same refusing RPC.
 *
 * Two copies of "which fields may a late read touch" is how one of them comes
 * to overwrite something the buyer decided, so both CALL this.
 *
 * PURE: no I/O, so the rules are tested by being called.
 *
 * The rules, each one a way a late read could do harm:
 *   · HOLES ONLY. Nothing the buyer typed or uploaded, and nothing an earlier
 *     read found, is ever replaced.
 *   · A FIELD THE BUYER REMOVED STAYS REMOVED. `/skip` on the logo or the
 *     overview is a decision about this listing — usually "not that picture" —
 *     and a late read putting it back is the bot overruling them on a public
 *     post. `removed` is recorded at the `/skip` and carried into the order.
 *   · The auto-written intro (`autoIntro`) is a PLACEHOLDER, not the buyer's
 *     words, so the project's own description replaces it. Whether the overview
 *     IS that placeholder is decided where the form still knows its own name
 *     and ticker (`autoOverview`), never re-derived later — fulfilment repairs
 *     a ticker the site would refuse, and the intro rebuilt from the repaired
 *     one would no longer match, silently keeping the placeholder.
 *   · https or http only for a logo: the site's LOGO_RE takes nothing else, and
 *     an `ipfs://` would fail the WHOLE listing over its picture.
 */
const { chainOf } = require("./config/chains");

// Length limits count code points so an emoji at the boundary never gets its
// surrogate pair split (which would store/send ill-formed text).
const cpSlice = (s, n) => Array.from(String(s)).slice(0, n).join("");
const cleanOverview = (s) => cpSlice(String(s || "").replace(/\s+/g, " ").trim(), 500) || null;

/**
 * Auto-written project intro — used when the token carries no on-chain/API
 * description and the user didn't type one, so the review card and channel post
 * always read as a finished listing instead of "not set". Editable like any
 * field. Returns null only if we don't even know the token name yet.
 */
function autoIntro(f) {
  const nm = String(f.name || "").trim();
  if (!nm) return null;
  const sy = f.sym ? ` ($${String(f.sym).replace(/^\$+/, "")})` : "";
  const ch = f.chain && chainOf(f.chain) ? chainOf(f.chain).label : f.chain || "";
  return `${nm}${sy} is now live and trading on ${ch}.`;
}

const SOCIALS = ["website", "twitter", "telegram"];

const lacksArt = (f) => !(f && (f.logoFileId || f.logoUrl));
const lacksSocials = (f) => !(f && (f.website || f.twitter || f.telegram));

/**
 * Could a late read change anything here? `opts` = { removed, autoOverview }.
 * A logo the buyer removed, or an overview that is theirs, is not a hole.
 */
function hasHoles(f, { removed = {}, autoOverview = false } = {}) {
  if (!f) return false;
  const r = removed || {};
  if (lacksArt(f) && !r.logo) return true;
  if (SOCIALS.some((k) => !f[k])) return true;
  return !r.overview && (!f.overview || !!autoOverview);
}

/**
 * What `info` — a token lookup's merged record — adds to `f`, holes only.
 * Returns a plain object of the fields to assign; empty when nothing.
 */
function additions(f, info, { removed = {}, autoOverview = false } = {}) {
  const add = {};
  if (!f || !info) return add;
  const r = removed || {};
  if (lacksArt(f) && !r.logo && typeof info.logoUrl === "string" && /^https?:\/\/\S+$/i.test(info.logoUrl.trim())) {
    add.logoUrl = info.logoUrl.trim();
  }
  for (const k of SOCIALS) if (!f[k] && info[k]) add[k] = info[k];
  const desc = info.description ? cleanOverview(info.description) : null;
  if (desc && !r.overview && (!f.overview || autoOverview)) add.overview = desc;
  return add;
}

/** The names of the holes a reader would recognise — for a log line or an
 *  alert. Social names are what the review card calls them. */
function holeNames(f, { removed = {} } = {}) {
  const r = removed || {};
  const out = [];
  if (lacksArt(f) && !r.logo) out.push("logo");
  const label = { website: "website", twitter: "X", telegram: "Telegram" };
  for (const k of SOCIALS) if (!f[k]) out.push(label[k]);
  return out;
}

module.exports = { SOCIALS, cpSlice, cleanOverview, autoIntro, lacksArt, lacksSocials, hasHoles, additions, holeNames };
