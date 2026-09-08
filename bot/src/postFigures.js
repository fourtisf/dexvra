"use strict";
/**
 * DID THE POST GO OUT WITH ITS REAL MARKET FIGURES? — the promise, watched.
 *
 * ⚠️ "Market cap: TBA · Price: TBA" REACHED 12,528 SUBSCRIBERS over a token
 * dexvra.io was pricing at $0.001004 on a $950.2K cap in the same minute, and
 * the only thing anywhere that noticed was a person opening the channel and
 * screenshotting it. That is the shape this file keeps paying for — the
 * trending board's blank percentage, the free-listing feed going quiet, a
 * chain of $0 rows — and every time the answer has been the same one: WATCH
 * THE PROMISE, because the causes keep changing.
 *
 * The cause that day was the GeckoTerminal queue and it is fixed (`POST_MARKET`
 * in fulfillment.js reads DexScreener first). The causes still available all
 * render IDENTICALLY: both indexers refusing this box, a chain neither covers,
 * a token with genuinely no pool, the shared budget spent, an upstream renaming
 * a field. So what is measured here is the RENDER — what the buyer's
 * announcement actually said — and never a cause.
 *
 * ⚠️ IT MEASURES WITH THE RENDERER'S OWN PREDICATE. `channels/format.js` prints
 * TBA for `!(p > 0)`, so that is the test here too: a watch with its own idea
 * of "missing" eventually disagrees with the post it is watching, which is how
 * `fonts:check` printed nine green ticks over a banner publishing boxes.
 */
const log = require("./helpers/logger");

/** Renders as a figure, rather than as TBA / — (`priceStr`, `mcStr`, `liqStr`). */
const rendered = (v) => Number(v) > 0;

const FIGURES = [
  ["price", (m) => rendered(m && m.priceUsd)],
  ["market cap", (m) => rendered(m && m.mcap)],
  ["liquidity", (m) => rendered(m && m.liq)],
];

/**
 * ⚠️ LIQUIDITY ALONE IS NOT AN ALERT, and that is a judgement rather than an
 * oversight. A token still on a bonding curve has no pool depth to report —
 * `launchpads.js` returns `liquidityUsd: null` deliberately, because a 0 there
 * reads as a rug — so a missing liquidity line is routinely a FACT ABOUT THE
 * TOKEN. Paging on it would make this permanently red on every pre-migration
 * listing, which is the state `chart:preview` sat in for weeks. Price and
 * market cap are the two the buyer's post cannot do without, and they are the
 * two that were reported. A missing liquidity is still NAMED whenever one of
 * those fires, because three holes and one hole are different pictures.
 */
const KEY_FIGURES = new Set(["price", "market cap"]);

/** Which of the post's three market figures will publish as a hole. */
function missingFigures(live) {
  return FIGURES.filter(([, ok]) => !ok(live)).map(([name]) => name);
}

const esc = (s) =>
  String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * The ops alert for a paid post that published a hole — or null when it did not.
 *
 * PURE, so the test CALLS it. "Never pages on a healthy post" and "says which
 * of the two silences it was" are behavioural rules, and a source scan cannot
 * tell a rule from a comment about one — the `logoWrite.ts` contract.
 */
function figureAlert({ kind, chain, address, sym, name, tier, live, why, siteUrl } = {}) {
  const missing = missingFigures(live);
  if (!missing.some((f) => KEY_FIGURES.has(f))) return null;

  // ⚠️ "WE COULD NOT ASK" AND "NOTHING IS THERE" ARE DIFFERENT FACTS, and only
  // the first is ours to fix. They are also the only two states the operator
  // can act on differently: one is a budget or an outage, the other is a token
  // no indexer covers yet, and sending them the same sentence is how three
  // rounds of this went to the wrong setting.
  const cause = why
    ? esc(why)
    : live
      ? "an indexer answered and publishes no " + missing.filter((f) => KEY_FIGURES.has(f)).join(" or ") + " for it"
      : "neither DexScreener nor GeckoTerminal returned anything — either both refused this box, or the token has no indexed pool yet";

  const label = kind === "trending" ? "Trending slot" : "Listing";
  const head = `⚠️ <b>${label} published without ${missing.map(esc).join(" · ")}</b>`;
  return [
    head,
    `<b>$${esc(sym || "?")}</b>${name ? ` — ${esc(name)}` : ""} · ${esc(String(chain).toUpperCase())}${tier ? ` · ${esc(tier)}` : ""}`,
    `Why: ${cause}`,
    `<code>${esc(address)}</code>`,
    siteUrl ? esc(siteUrl) : "",
    // A count is not a diagnosis. `market:check` is the script that separates
    // the three causes ON THE BOX, which is the only place they can be told
    // apart — whether an indexer answers this server is a property of its
    // egress today, not of this code.
    `Run <code>npm run market:check -- ${esc(chain)}</code> on the box.`,
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Send it, if there is one.
 *
 * ⚠️ THE POST IS ALREADY OUT BY THE TIME THIS RUNS, so a throw here would turn
 * a degraded announcement into a FAILED ORDER — the rule the free-listing
 * report already states one service over. Never deduped: each of these is a
 * separate paying customer, and collapsing two would hide one of them.
 */
function reportFigures(args) {
  try {
    const html = figureAlert(args);
    if (html) log.alert(html);
    return html;
  } catch (e) {
    log.warn(`[fulfil] figure watch: ${e.message}`);
    return null;
  }
}

module.exports = { missingFigures, figureAlert, reportFigures, KEY_FIGURES };
