'use strict';
/*
 * IS ANY CHAIN UNDER ITS MINIMUM RIGHT NOW — and if so, for how long, and why?
 *
 * WHY THIS EXISTS. "Trending base dan ethereum sangat sedikit" was reported
 * three times in two days, and each time the CAUSE was different:
 *
 *   1. the chain had no listings left to promote        → the market filler
 *   2. the filler fired on a red day and would have      → gate it on listing
 *      listed dozens of tokens                             scarcity only
 *   3. `min +5% 24h` refused every spare, so the board   → the minimum outranks
 *      sat under the floor with nothing able to fix it      the gain floor
 *
 * Three fixes, one symptom — and in all three the OPERATOR was the detector.
 * They read the channel, counted rows, and asked. Nothing in the bot ever said
 * "Ethereum has been under 5 for two hours"; the closest thing was one advisory
 * log line, at noise level, aimed at somebody reading pm2.
 *
 * So this watches the SYMPTOM. Causes will keep changing — a fourth one will
 * turn up — and the thing worth alerting on is the promise the operator set:
 * every configured chain carries at least `perChainMin` tokens.
 *
 * Rules it is built under, all borrowed from `upstreams.js`, which had to learn
 * them the same way:
 *   • alert on the TRANSITION, after a grace period — a chain that is short for
 *     one cycle while a slot rolls over is not an incident, and an alert every
 *     cycle is a channel nobody reads by the second hour;
 *   • a RECOVERY is an alert too, or the operator cannot tell a fixed board
 *     from a forgotten one;
 *   • the message says what the OPERATOR can do, and names which of the causes
 *     it is — "short" alone sends them to the same three-round investigation.
 */

/** How long a chain must stay under its floor before it is worth saying. */
const GRACE_MS = Math.max(60_000, Number(process.env.TREND_SHORT_GRACE_MS) || 45 * 60_000);
/** …and how often to repeat while it stays short. A board short for a week must
 *  not be one alert on day one that everybody has scrolled past. */
const REPEAT_MS = Math.max(GRACE_MS, Number(process.env.TREND_SHORT_REPEAT_MS) || 12 * 60 * 60_000);

/**
 * Why is this chain short, in the operator's terms — and what fixes it.
 *
 * The three causes need three different answers, and telling them apart is
 * exactly what took three rounds. `fill` is what the market filler reported for
 * this chain on the last pass, when it ran.
 */
function diagnose({ featured, floor, eligible = 0, fillWhy = null, gainFloor = 0 }) {
  if (featured >= floor) return null;
  if (eligible > 0) {
    // There ARE spare listings. Since the minimum outranks the gain floor, the
    // only way this survives a cycle is that they are all in free-fall (below
    // FLOOR_FILL_MAX_DROP), or the cycle has not run yet.
    return {
      code: 'spares_unusable',
      // Two readings, and the honest line names both: the watch runs right after
      // a cycle (so "nothing was promotable" is the answer), while the check
      // script can run at any moment, including between cycles.
      text:
        `${eligible} spare listing(s) here, and none went on — either they are all down more than 15% ` +
        `(the one thing never auto-promoted), or the next cycle has not run yet. ⚡ Run now settles it.`,
    };
  }
  if (fillWhy) {
    return {
      code: 'fill_failed',
      text: `no spare listings, and the market fill could not help: ${fillWhy}`,
    };
  }
  return {
    code: 'no_listings',
    text:
      `no spare listings on this chain and nothing was filled from the market. ` +
      `Check 🧲 Fill from market is ON and its 🏦 floor is not so high that nothing qualifies` +
      (gainFloor > 0 ? `, then list a token there yourself if it stays this way.` : `.`),
  };
}

/**
 * Fold this cycle's per-chain snapshot into the watch state and return the
 * alerts to send. PURE — the caller owns persistence and the sending, so a test
 * can walk a board through days of cycles in milliseconds.
 *
 * @param {Array<{id, featured, floor, eligible, fillWhy}>} chains
 * @param {object} prev  state.boardWatch from the store
 * @returns {{ state: object, alerts: Array<{chain, kind, text}> }}
 */
function evaluate(chains, prev = {}, { now = Date.now(), graceMs = GRACE_MS, repeatMs = REPEAT_MS } = {}) {
  const state = {};
  const alerts = [];
  for (const c of chains) {
    const was = prev[c.id] || null;
    const why = diagnose(c);
    if (!why) {
      // Back at or above the floor. Only announce it if we complained.
      if (was && was.alertedAt) {
        alerts.push({
          chain: c.id,
          kind: 'recovered',
          text: `✅ <b>${c.id}</b> is back at target — <b>${c.featured}</b> on the board (minimum ${c.floor}).`,
        });
      }
      continue; // no entry: the chain is healthy, and a healthy chain keeps no state
    }
    const since = (was && was.since) || now;
    const shortFor = now - since;
    const entry = { since, why: why.code };
    // Under the floor, but not for long enough to be more than a slot rolling
    // over between cycles.
    if (shortFor < graceMs) {
      state[c.id] = entry;
      continue;
    }
    const alertedAt = was && was.alertedAt;
    if (!alertedAt || now - alertedAt >= repeatMs) {
      alerts.push({
        chain: c.id,
        kind: 'short',
        text:
          `⚠️ <b>Trending board short on ${c.id}</b>\n` +
          `<b>${c.featured}</b> on the board, minimum is <b>${c.floor}</b> — for ${Math.round(shortFor / 60_000)} min.\n` +
          `${why.text}`,
      });
      entry.alertedAt = now;
    } else {
      entry.alertedAt = alertedAt;
    }
    state[c.id] = entry;
  }
  return { state, alerts };
}

module.exports = { evaluate, diagnose, GRACE_MS, REPEAT_MS };
