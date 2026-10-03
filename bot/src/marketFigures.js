"use strict";
/**
 * THE THREE FIGURES A LISTING PUBLISHES — price, market cap, liquidity — and
 * whether a reading actually carries them. PURE: no I/O, no clock of its own,
 * so every rule here is tested by being CALLED.
 *
 * ⚠️ "Market cap: TBA · Price: TBA" WENT OUT FOR $SFX (Safix, Robinhood,
 * Uniswap v4) to 12,445 subscribers while DexScreener carried it at a $1.0M cap
 * on $85K of liquidity and dexvra.io priced it at $1.10M in the same minute.
 * Nothing about the token was missing. The post had exactly ONE bounded read of
 * the market, no second attempt and no fallback, so one refused request (a
 * DexScreener 429 on an IP whose background pipelines share that budget) or one
 * slow GeckoTerminal queue WAS the post — and the listing form had read the very
 * same figures minutes earlier and thrown them away.
 *
 * So a post now has three layers, and this module is the one owner of the
 * question each of them asks:
 *   1. the live read, re-asked while a figure is still a hole (`needsAnotherRead`);
 *   2. the figures the listing FORM read at paste time (`snapshotOf` /
 *      `usableSnapshot`), used only for what the live read could not fill, and
 *      only while they are recent;
 *   3. an honest TBA / — when nobody anywhere has a reading.
 *
 * A figure is RENDERED when it is > 0 — the renderer's own predicate
 * (`channels/format.js` priceStr / mcStr / liqStr), so this can never disagree
 * with the post it is deciding about.
 */

const FIELDS = ["priceUsd", "mcap", "liq"];
const pos = (v) => Number(v) > 0;

/** Which of the three would publish as a hole. */
function holes(m) {
  return FIELDS.filter((k) => !pos(m && m[k]));
}

/**
 * Is another live read worth making?
 *
 * Price and market cap: always, while either is missing — they are the two a
 * listing post cannot do without.
 *
 * ⚠️ LIQUIDITY ONLY WHEN THE READING NAMES A POOL. A token still on a bonding
 * curve has no pool depth at all (`launchpads.js` returns `liquidityUsd: null`
 * deliberately, because a 0 there reads as a rug), and re-asking would cost
 * every pre-migration listing the whole retry window for a number that does not
 * exist. A reading that DOES name a pool is a pool whose depth we failed to
 * read — the $SFX shape, where one indexer answered the price and the one with
 * the depth had refused us — and that is exactly a hole a second read fills.
 */
function needsAnotherRead(m) {
  if (!m) return true;
  if (!pos(m.priceUsd) || !pos(m.mcap)) return true;
  return !pos(m.liq) && !!m.poolAddress;
}

/**
 * Fill the HOLES of `a` from `b` — never replace a value `a` already has.
 *
 * The rule `discovery.mergeInfo` states: an earlier answer is not overwritten by
 * a later one, so a retry can only ever ADD a figure. A figure is a hole when it
 * would not render (≤ 0 or absent); any other field is a hole when null.
 */
function mergeFigures(a, b) {
  if (!a) return b ? { ...b } : null;
  if (!b) return { ...a };
  const out = { ...a };
  for (const k of FIELDS) if (!pos(out[k]) && pos(b[k])) out[k] = Number(b[k]);
  for (const [k, v] of Object.entries(b)) {
    if (FIELDS.includes(k)) continue;
    if (out[k] == null && v != null) out[k] = v;
  }
  return out;
}

/**
 * The figures the listing FORM read, as a dated snapshot — or null when it read
 * none. First positive value per field across the records, in the order given
 * (the caller passes its best source first).
 */
function snapshotOf(records, now) {
  const recs = (records || []).filter((r) => r && typeof r === "object");
  const pick = (k) => {
    for (const r of recs) if (pos(r[k])) return Number(r[k]);
    return null;
  };
  const s = { priceUsd: pick("priceUsd"), mcap: pick("mcap"), liq: pick("liq"), at: now };
  return s.priceUsd || s.mcap || s.liq ? s : null;
}

/**
 * A snapshot recent enough to publish, or null.
 *
 * ⚠️ A STAMP IN THE FUTURE IS REFUSED, not trusted: clock skew or a restored
 * backup, and there is no way to learn how old the reading really is. Every
 * figure published here is a CLAIM, and a reading of unknown age is not one
 * this can make. Same for a missing stamp.
 */
function usableSnapshot(snap, now, maxAgeMs) {
  if (!snap || typeof snap !== "object") return null;
  const at = Number(snap.at);
  if (!Number.isFinite(at) || at > now) return null;
  if (!(maxAgeMs > 0) || now - at > maxAgeMs) return null;
  const out = {};
  for (const k of FIELDS) if (pos(snap[k])) out[k] = Number(snap[k]);
  return Object.keys(out).length ? { ...out, at } : null;
}

/**
 * The figures to STORE on the site's row — positive values only, and absent
 * otherwise. The row's captured figures are what dexvra.io renders for a token
 * no provider has priced yet (`figureReading` prints a captured non-zero), and a
 * re-list must never erase one it does not carry (`lib/relist.ts`), so a hole is
 * left out rather than written as 0.
 */
function rowFigures(m) {
  const out = {};
  if (m && pos(m.priceUsd)) out.price = Number(m.priceUsd);
  if (m && pos(m.mcap)) out.mcap = Number(m.mcap);
  if (m && pos(m.liq)) out.liq = Number(m.liq);
  return out;
}

module.exports = { FIELDS, holes, needsAnotherRead, mergeFigures, snapshotOf, usableSnapshot, rowFigures };
