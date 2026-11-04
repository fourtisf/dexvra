// Pump alerts: polls each approved listing's live price and announces every ROUND
// MILESTONE it passes — +100%, +200%, +300% … up to the ceiling — measured from
// the baseline (the price first observed by the bot ≈ listing time). One alert per
// step, each posted as a REPLY to the original listing post and tweeted as a quote
// of the listing tweet; carries the admin's pump GIF/video clip when one is set.
// The window (default 100%–2000%) is admin-configurable; see the milestone block
// below for why the number announced is a step and not the raw gain. Baseline and
// the per-step latch persist across restarts.
const { PUMP_CHECK_MS, CHANNELS, SITE_URL, X_POST_TIMEOUT_MS, CLIP_BUDGET_MS } = require("../config/constants");
const api = require("../api/dexvra");
// ⚠️ `fetchPrice`, NOT `fetchMarket`. This loop prices EVERY approved listing
// every three minutes and reads two fields off the answer — the price and the
// market cap — so on the heavy read it was, by itself, most of a
// thirty-requests-a-minute GeckoTerminal ceiling that is counted per IP and
// shared with the website's candlestick charts on the same box. DexScreener
// publishes both numbers and costs us none of that budget; GT is still asked
// for the chains and the tokens DexScreener cannot answer. See marketdata.js.
const market = require("../marketdata"); // called as market.fetchPrice — a seam the tests can stub
const postids = require("../channels/postids");
const fmt = require("../channels/format");
const post = require("../channels/post");
const bannerTemplate = require("../bannerTemplate");
const listingMotion = require("../listingMotion"); // called as listingMotion.render — a seam the tests can stub
const { bounded } = require("../helpers/bounded");
const { chainOf } = require("../config/chains");
const x = require("../twitter");
const { fmtPrice, formatNumber } = require("../helpers/format");
const { DedupSet, loadJSONSync, saveJSON } = require("../helpers/persist");
const log = require("../helpers/logger");

// Alert window (min%/max%) is admin-configurable via pumpConfig — read fresh
// each poll so an @dexvraadminbot change applies next cycle. Above the ceiling
// is almost always bad market data (thin liquidity / a bad tick), so it's
// skipped rather than posted.
const pumpConfig = require("./pumpConfig");
const BASE_FILE = "pumpbase.json";
let baseline = loadJSONSync(BASE_FILE, {});
const latch = new DedupSet("pumplatch.json");
const keyOf = (r) => `${r.chain}:${String(r.address).toLowerCase()}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// The pause between two tokens' price reads. A test sets it to 0.
const POLITE_MS = Math.max(0, Number(process.env.PUMP_POLITE_MS ?? 300) || 0);

// ---------------------------------------------------------------- a deleted token is SILENT
//
// "SAYA SUDAH DELETE TOKEN FROM DATABASE TPI PUMP ALERT MASIH SPAMM" — a
// honeypot ($NASDUCK, Robinhood) deleted from the site went on posting
// "+1200%", "+1900% since listing" into @dexvralisting. Three things let it:
//
//  1. THE LIST WAS READ ONCE PER SWEEP. A sweep prices every approved listing
//     one at a time — ~680 rows, a request and a 300ms pause each, and on the
//     GeckoTerminal-primary chains a queue behind the site's charts — so one
//     sweep runs for many minutes, and a row deleted after the read was still
//     priced and still announced from that stale copy.
//  2. SWEEPS OVERLAPPED. `setInterval` fires every PUMP_CHECK_MS whether or
//     not the last sweep finished, so several ran at once, each holding its own
//     stale list — and two of them crossing the same token in the same minute
//     could both decide "post" before either latched: the same step twice.
//  3. NOTHING WAS EVER FORGOTTEN. The baseline and the step latch outlived the
//     row, so a token deleted and later re-added picked up the OLD baseline and
//     announced "+1900% since listing" about a listing that was minutes old.
//
// So: one sweep at a time; the SITE is asked again, fresh, immediately before
// anything is sent (a read that fails sends nothing — silence is the safe way
// to be wrong about a deletion); and a token gone from the site has its pump
// state dropped, so a re-listing starts a new ladder from its own price.

const { liveMap, confirmListed, auditScam } = require("../helpers/stillListed");
// Called through the module object (audit.checkRow), so a test can stand in for it.
const audit = require("./listingAudit");

// Past this share of the market cap missing from the pool, the price is not a
// market — it is a number a thin pool prints. $NASDUCK announced "+1900%" on a
// pool GMGN measured at $507 against a $684M cap (0.00007%). `PUMP_MIN_LIQ_PCT`
// (percent; 0 turns it off). An unpublished liquidity makes no claim.
const PUMP_MIN_LIQ_PCT = (() => {
  const raw = process.env.PUMP_MIN_LIQ_PCT;
  if (raw == null || String(raw).trim() === "") return 0.5; // blank is ABSENT, never 0
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 0.5;
})();

/** Why this reading may not be announced as a pump, or null. */
function unbackedPrice(m, minPct = PUMP_MIN_LIQ_PCT) {
  if (!(minPct > 0) || !m) return null;
  const liq = Number(m.liq);
  const mcap = Number(m.mcap);
  if (!(liq > 0) || !(mcap > 0)) return null;
  const pct = (liq / mcap) * 100;
  if (pct >= minPct) return null;
  return `liquidity $${formatNumber(liq)} is ${pct < 0.01 ? pct.toExponential(1) : pct.toFixed(2)}% of its $${formatNumber(mcap)} cap — the price is not backed by a pool`;
}

/**
 * Drop the pump state of every token no longer approved on the site.
 *
 * ⚠️ A LIST THAT LOOKS LIKE AN OUTAGE IS NOT A WAVE OF DELETIONS. A site that
 * lost its store answers with its seed rows; read literally that "deletes"
 * every real listing at once and re-baselines them all. So an empty read
 * prunes nothing, and one that would drop more than half of a sizeable ledger
 * in one sweep is refused and said — an operator deleting tokens does it a few
 * at a time.
 */
async function forgetGone(live, { base = baseline, latchSet = latch } = {}) {
  const known = Object.keys(base);
  if (!live.size) return { dropped: 0, refused: false };
  const gone = known.filter((k) => !live.has(k));
  if (!gone.length) return { dropped: 0, refused: false };
  if (known.length >= 20 && gone.length > known.length / 2) {
    log.warn(
      `[pump] ${gone.length} of ${known.length} tracked tokens are missing from the site's list at once — ` +
        "that reads as a site outage, not deletions; their pump state is kept",
    );
    return { dropped: 0, refused: true };
  }
  const goneSet = new Set(gone);
  for (const k of gone) delete base[k];
  await saveJSON(BASE_FILE, base).catch(() => {});
  // Latch keys are `${key}` (legacy) or `${key}@${step}`.
  await latchSet.deleteWhere((lk) => goneSet.has(String(lk).replace(/@\d+$/, "")));
  log.info(`[pump] forgot ${gone.length} token(s) no longer on the site: ${gone.slice(0, 5).join(", ")}${gone.length > 5 ? " …" : ""}`);
  return { dropped: gone.length, refused: false };
}

// ---------------------------------------------------------------- milestones
//
// A pump alert announces a ROUND STEP — +100%, +200%, +300% … up to the ceiling —
// and announces one EVERY time the token reaches a new step.
//
// It used to fire exactly once per token, at whatever the raw gain happened to be
// on the poll that caught it. That is why a token up 282% announced "+282%": not a
// threshold anybody chose, just the number the 30-second poll landed on. A token
// that then went on to 10x said nothing more about it.
//
// Two rules keep the ladder from becoming noise:
//   • a step is announced at most once, ever (latched per token AND per step);
//   • a token that JUMPS several steps between polls — 90% straight to 450% —
//     announces ONCE, at the highest step it reached, and the steps it skipped are
//     marked consumed rather than posted. Four alerts in one second for one price
//     move is spam, not information.
const MILESTONE_STEP = Math.max(1, Math.round(Number(process.env.PUMP_MILESTONE_STEP) || 100));

/** The step this gain has reached, or null if it has not reached one.
 *  Floored, so +282% is "+200%" — the milestone actually passed, never rounded up
 *  to one the token has not reached. */
function milestoneFor(pct, minPct, maxPct) {
  if (!(pct >= minPct)) return null;
  const m = Math.floor(pct / MILESTONE_STEP) * MILESTONE_STEP;
  return m >= minPct && m <= maxPct ? m : null;
}
/** Latch keys for every step from the floor up to and including `milestone`. */
function stepKeys(key, milestone, minPct, maxPct) {
  const out = [];
  const first = Math.ceil(minPct / MILESTONE_STEP) * MILESTONE_STEP;
  for (let m = first; m <= milestone && m <= maxPct; m += MILESTONE_STEP) out.push(`${key}@${m}`);
  return out;
}

/** Retire a pre-ladder token onto the ladder, ONCE.
 *
 *  Before the ladder a token latched under its BARE key, so on the first poll
 *  after the upgrade it is already standing above steps it never announced.
 *  Those steps are consumed rather than posted, or deploying would have dumped an
 *  alert for every previously-pumped listing into the channel at once.
 *
 *  Dropping the legacy marker is the other half, and leaving it out is a bug that
 *  looks exactly like success: the marker made `latch.has(key)` true FOREVER, so
 *  every later step took this same silent branch and the token could never alert
 *  again. It went unnoticed because nothing is logged and nothing is posted —
 *  the only trace was consumed step keys in the latch file with no matching
 *  alert. Absorb once, drop the marker, and the very next step posts normally. */
async function absorbLegacy(latchSet, key, milestone, minPct, maxPct) {
  await latchSet.addAll(stepKeys(key, milestone, minPct, maxPct));
  await latchSet.delete(key);
  return true;
}

/** What this poll should do with a token standing at `milestone`:
 *    'retire' — a pre-ladder token: consume its history, drop the legacy marker,
 *               post nothing;
 *    'skip'   — this step has already been announced;
 *    'post'   — announce it.
 *
 *  ORDER MATTERS, and getting it wrong is subtle enough to have shipped twice.
 *  The legacy marker is checked FIRST. Checking the step latch first looks
 *  equivalent and is not: a token already carrying a consumed step key for where
 *  it currently stands would 'skip' every poll, so the marker survived until the
 *  token reached a NEW step — and the migration branch then ate that step too,
 *  because retiring never posts. Retiring on the very next poll costs the token
 *  nothing it had not already lost, and it alerts normally from then on. */
function decide(latchSet, key, milestone) {
  if (latchSet.has(key)) return "retire";
  if (latchSet.has(`${key}@${milestone}`)) return "skip";
  return "post";
}

function coinOf(r, price, mcap) {
  return {
    name: r.name,
    symbol: r.sym,
    chain: r.chain,
    address: r.address,
    tier: r.tier,
    price,
    mcap,
    links: { website: r.website, twitter: r.twitter, telegram: r.telegram },
    siteUrl: `${SITE_URL}/token/${r.chain}/${r.address}`,
  };
}

/** Fetch a token logo into a Buffer (relative /api/media/… → public SITE_URL). */
async function fetchLogoBuffer(logoUrl) {
  if (!logoUrl) return null;
  const url = logoUrl.startsWith("http") ? logoUrl : `${SITE_URL}${logoUrl}`;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(12000) });
    if (!r.ok) return null;
    return Buffer.from(await r.arrayBuffer());
  } catch {
    return null;
  }
}

/** The pump clip: the listing's motion piece with PUMP ALERT, the gain
 *  counting up where the name goes, and LISTED AT → NOW in the panel. Null on
 *  any failure or past the budget — the caller's ladder continues. */
async function pumpMotion(r, base, m, pct, logoBuffer) {
  if (!bannerTemplate.postingEnabled() || !listingMotion.enabled("pump")) return null;
  const c = chainOf(r.chain);
  const coin = {
    symbol: r.sym,
    name: r.name,
    chain: r.chain,
    change: `+${Math.round(pct)}%`,
    priceFrom: base.price > 0 ? fmtPrice(base.price) : null,
    priceTo: m.priceUsd > 0 ? fmtPrice(m.priceUsd) : null,
    mcap: m.mcap > 0 ? "$" + formatNumber(m.mcap) : null,
  };
  const cancel = { cancelled: false };
  return bounded(
    listingMotion
      .render(coin, logoBuffer, { variant: "pump", badge: c ? c.label : String(r.chain || "").toUpperCase(), cancel })
      .catch(() => null),
    CLIP_BUDGET_MS,
    () => {
      cancel.cancelled = true;
      log.warn(`[pump] ${r.sym} media: premium motion passed ${CLIP_BUDGET_MS}ms — falling back`);
      return null;
    },
  );
}

/** Build the pump-alert media, best first:
 *   1. the premium motion clip ("buatkan vidio untuk pump alert"), drawn in
 *      code with the token's own logo — it needs no admin upload, so a pump
 *      alert is no longer a bare text reply on a box nobody gave a clip to;
 *   2. the admin's pump GIF/video with the token overlay (▲ +N% · old→new
 *      price · MCAP pill · logo ring · cyan $ticker) composited onto it, or the
 *      raw clip if that fails;
 *   3. null — the caller posts a plain text reply.
 *  PUMP_MOTION=0 restores 2 → 3 exactly. */
async function pumpMedia(r, base, m, pct) {
  let logoBuffer = null;
  try {
    logoBuffer = await fetchLogoBuffer(r.logoUrl);
    const motion = await pumpMotion(r, base, m, pct, logoBuffer);
    if (motion) {
      log.info(`[pump] ${r.sym} media: premium motion ✔`);
      return motion;
    }
  } catch (e) {
    log.warn(`[pump] ${r.sym} motion: ${e.message}`);
  }
  const media = bannerTemplate.mediaOverride("pump"); // admin GIF/video (null → text reply)
  if (!media) return null;
  try {
    const filled = await bannerTemplate.composeOntoClip("pump", media, logoBuffer, {
      symbol: r.sym,
      name: r.name,
      chain: r.chain,
      change: `+${Math.round(pct)}%`,
      priceFrom: fmtPrice(base.price),
      priceTo: fmtPrice(m.priceUsd),
      price: fmtPrice(m.priceUsd),
      mcap: m.mcap ? "$" + formatNumber(m.mcap) : null,
    });
    if (filled) {
      log.info(`[pump] ${r.sym} media: admin clip + pump overlay ✔`);
      return filled;
    }
    log.warn(`[pump] ${r.sym} media: overlay composite failed — sending clip as-is`);
  } catch (e) {
    log.warn(`[pump] ${r.sym} overlay: ${e.message}`);
  }
  // Raw clip: a .gif has to become an MP4 or Telegram posts it as a file card
  // instead of playing it (see bannerTemplate.toInlineClip).
  return bannerTemplate.toInlineClip(media);
}

/**
 * Where a pump alert is allowed to appear for this token: ONLY a channel where
 * it HAS a listing post to reply to. That is the whole rule, and it is a
 * business rule, not just a Telegram one:
 *
 *   Xpress Listing            → @dexvralisting only. An Xpress buyer gets no
 *                               @dexvraio announcement, so there is nothing to
 *                               reply to there and no pump alert there either.
 *   Listing & Trending (top   → both channels, each replying to ITS OWN post.
 *   tiers, which do announce)
 *
 * An empty list means NO alert. A pump alert must never be posted stand-alone:
 * out of thread it reads as an ad for a token the channel never listed.
 */
function pumpTargets(ids = {}) {
  const out = [];
  if (ids.listingMsgId) out.push({ channel: CHANNELS.listing, replyTo: ids.listingMsgId });
  if (ids.annMsgId) out.push({ channel: CHANNELS.announce, replyTo: ids.annMsgId });
  return out;
}

// ONE SWEEP AT A TIME — see the header block above `liveMap`.
let sweeping = false;
// What was last said about a token whose price is not backed by its pool, so
// the line is written once per step rather than every three minutes.
const unbackedSaid = new Map();

/** One pass over every approved listing. Returns null when a sweep was already
 *  running (this tick is skipped, never queued), else `{ priced, posted }`. */
async function sweep({ now = Date.now() } = {}) {
  if (sweeping) {
    log.debug("[pump] previous sweep still running — this tick skipped");
    return null;
  }
  sweeping = true;
  const startedAt = Date.now();
  try {
    return await sweepOnce(now);
  } finally {
    sweeping = false;
    const took = Date.now() - startedAt;
    if (took > PUMP_CHECK_MS) {
      log.info(`[pump] sweep took ${Math.round(took / 1000)}s — longer than PUMP_CHECK_MS (${Math.round(PUMP_CHECK_MS / 1000)}s); overlapping ticks were skipped`);
    }
  }
}

async function sweepOnce(now) {
  const out = { priced: 0, posted: 0, skipped: [] };
  let listings;
  try {
    listings = await api.getListings();
  } catch {
    return out;
  }
  const live = liveMap(listings);
  await forgetGone(live);
  for (const r of listings) {
    if (r.status !== "approved") continue;
    const key = keyOf(r);
    // A token our own audit has flagged as a scam is never announced as a pump.
    if (auditScam(key)) continue;
    const m = await market.fetchPrice(r.chain, r.address).catch(() => null);
    if (POLITE_MS) await sleep(POLITE_MS); // be polite to the indexers — mostly DexScreener now
    if (!m || !m.priceUsd) continue;
    out.priced++;

    // A baseline belongs to ONE listing. A token deleted and re-added (a new
    // listedAt) is a new listing, and "since listing" must mean since that one.
    if (baseline[key] && r.listedAt && baseline[key].listedAt && Number(baseline[key].listedAt) !== Number(r.listedAt)) {
      delete baseline[key];
      await latch.deleteWhere((lk) => String(lk).replace(/@\d+$/, "") === key);
    } else if (baseline[key] && !baseline[key].listedAt && r.listedAt) {
      // A baseline recorded before this field existed adopts the listing it is
      // standing on, so the NEXT re-listing is told apart.
      baseline[key].listedAt = r.listedAt;
      await saveJSON(BASE_FILE, baseline).catch(() => {});
    }
    if (!baseline[key]) {
      baseline[key] = { price: m.priceUsd, mcap: m.mcap || null, at: now, listedAt: r.listedAt || null };
      await saveJSON(BASE_FILE, baseline).catch(() => {});
      continue; // no alert on first observation
    }
    const base = baseline[key];
    if (!base.price || m.priceUsd < base.price) continue;
    const pct = ((m.priceUsd - base.price) / base.price) * 100;
    const { minPct, maxPct } = pumpConfig.get(); // admin-set window (default 100%–2000%)
    if (pct < minPct || pct > maxPct) continue;

    // Announce the STEP reached, not the raw gain this poll happened to catch.
    const milestone = milestoneFor(pct, minPct, maxPct);
    if (milestone == null) continue;
    // retire / skip / post — see decide(). MIGRATION off the old once-per-token
    // latch happens first: before the ladder a token latched under its BARE key,
    // and every one of those already stands above steps it never announced, so
    // announcing them would dump an alert for every previously-pumped listing
    // into a channel with twelve thousand subscribers the moment this deploys.
    const action = decide(latch, key, milestone);
    if (action === "skip") continue; // this step already went out
    if (action === "retire") {
      await absorbLegacy(latch, key, milestone, minPct, maxPct);
      log.event(
        `📈 Pump: ${r.sym || r.address} pre-ladder — steps ≤ ${milestone}% absorbed, next alert at +${milestone + MILESTONE_STEP}%`,
      );
      continue;
    }

    const ids = postids.get(r.chain, r.address);
    const targets = pumpTargets(ids);
    if (!targets.length) {
      // Nothing to reply to — usually a token listed before post ids were
      // recorded, or one whose listing post failed. No latch: if the id shows
      // up later the pump can still be announced.
      log.debug(`[pump] ${r.sym || r.address}: no listing post to reply to — skipped`);
      continue;
    }
    // A price a thin pool printed is not a pump. No latch: if the pool fills
    // in, the step can still be announced.
    const unbacked = unbackedPrice(m);
    if (unbacked) {
      if (unbackedSaid.get(key) !== milestone) {
        unbackedSaid.set(key, milestone);
        log.info(`[pump] ${r.sym || r.address} +${milestone}% NOT announced — ${unbacked}`);
      }
      out.skipped.push({ key, why: unbacked });
      continue;
    }
    // ⚠️ ASK THE SITE AGAIN, NOW. The list this sweep is walking was read at
    // its start, possibly many minutes ago; an operator may have deleted the
    // token since. Nothing — not the tweet, not the channel post — goes out
    // until a fresh read says it is still listed. No latch on a refusal.
    const still = await confirmListed(r, base);
    if (!still.ok) {
      log.info(`[pump] ${r.sym || r.address} +${milestone}% NOT announced — ${still.why}`);
      out.skipped.push({ key, why: still.why });
      continue;
    }
    // ⚠️ AND A FREE LISTING GETS ONE LAST LOOK. The audit re-checks bot-made
    // rows on a slow rotation, so a token that turned into a honeypot after
    // listing could pump — and be announced to the channel — before the
    // rotation reached it. Same judge, asked now (listingAudit.checkRow).
    // EVIDENCE holds the alert, flags the row and pages ops once; "could not
    // ask" does not hold it — the token cleared the door and the audit
    // already, and an upstream outage must not silence every free listing.
    const look = await audit.checkRow(r).catch((e) => ({ auditable: true, ok: false, why: e.message }));
    if (look.auditable && look.ok && look.why && !/^no logo/i.test(look.why)) {
      await audit.flagNow(r, look.why).catch(() => {});
      log.info(`[pump] ${r.sym || r.address} +${milestone}% NOT announced — ${look.why}`);
      out.skipped.push({ key, why: look.why });
      continue;
    }
    if (look.auditable && !look.ok) log.debug(`[pump] ${r.sym || r.address}: last look could not decide (${look.why}) — announcing on the door's verdict`);
    const coin = coinOf(r, m.priceUsd, m.mcap);
    const media = await pumpMedia(r, base, m, milestone); // admin pump clip + overlay (null → text reply)
    // A pump tweet MUST quote the token's own listing tweet — the same rule
    // pumpTargets enforces on Telegram, for the same reason: standing alone on
    // the listing feed, "+240% since listing" is indistinguishable from a shill
    // post for a token that account never announced. The quoted listing card is
    // what makes it a follow-up. No known listing tweet → no tweet at all
    // (the Telegram alert still goes out, and the card's X line drops itself).
    //
    // Fired BEFORE the card is BUILT, not after it is sent: the card carries an
    // "Announce On X" line, and a tweet made afterwards can never reach it.
    // Timeboxed and best-effort — the alert still posts if X is slow or off.
    let pumpTweetId = null;
    if (ids.listingTweetId) {
      pumpTweetId = await Promise.race([
        x.postPump(coin, milestone, base.mcap || 0, m.mcap || 0, ids.listingTweetId, media).catch(() => null),
        new Promise((res) => setTimeout(res, X_POST_TIMEOUT_MS, null)),
      ]);
    } else if (x.enabled()) {
      log.debug(`[pump] ${r.sym || r.address}: no listing tweet to quote — Telegram only`);
    }
    if (pumpTweetId) coin.xUrl = `https://x.com/i/status/${pumpTweetId}`;
    const card = fmt.pumpPost(coin, milestone, base.mcap || 0, m.mcap || 0);
    // "Did the alert post?" means ANY target took it, not specifically the
    // listing channel. Counting only CHANNELS.listing left a token that has an
    // @dexvraio announcement but no listing-channel post (the listing post
    // failed, or an admin force-posted only the announcement) posting to
    // @dexvraio successfully, never latching, and re-firing on EVERY poll —
    // duplicate announcements forever, and now a duplicate tweet with them.
    let posted = null;
    try {
      for (const t of targets) {
        const msg = await post.sendMedia(t.channel, media, card, { replyTo: t.replyTo });
        if (msg) posted = posted || msg;
      }
    } catch (e) {
      log.warn(`[pump] post: ${e.message}`);
    }
    // Latch only AFTER the alert really posted. Spending the once-per-token
    // budget at DETECTION time meant a failed post burned it forever and the
    // token could never alert again.
    if (!posted) {
      log.warn(`[pump] ${r.sym || r.address}: +${milestone}% alert did not post — not latching, will retry next cycle`);
      continue;
    }
    // Consume the step just announced AND every step below it, so a jump that
    // cleared several at once cannot backfill them as separate alerts later.
    await latch.addAll(stepKeys(key, milestone, minPct, maxPct));
    out.posted++;
    log.event(`📈 Pump: ${r.sym} +${milestone}% since listing (${r.chain}, actual +${Math.round(pct)}%)`);
  }
  return out;
}

function start(tg) {
  // A tick that lands while a sweep is still running is SKIPPED (see sweep()),
  // never stacked — overlapping sweeps were how a deleted token kept posting.
  const tick = () => sweep().catch((e) => log.warn(`[pump] sweep: ${e.message}`));
  const iv = setInterval(tick, PUMP_CHECK_MS);
  const kick = setTimeout(tick, 15000);
  return {
    stop: () => {
      clearInterval(iv);
      clearTimeout(kick);
    },
  };
}

module.exports = {
  start,
  sweep,
  pumpTargets,
  milestoneFor,
  stepKeys,
  absorbLegacy,
  decide,
  confirmListed,
  forgetGone,
  unbackedPrice,
  liveMap,
  MILESTONE_STEP,
  PUMP_MIN_LIQ_PCT,
  // Test seams: the in-memory state the sweep reads and writes.
  _state: () => ({ baseline, latch }),
  _pumpMedia: pumpMedia,
};
