// Once-only delivery for group alerts, on JSON persistence instead of Redis.
//
// THE BUG THIS EXISTS TO PREVENT
// The obvious implementation marks a transaction "alerted" and then sends it.
// One 429, one dropped socket, and the alert never posts AND the transaction
// can never alert again — silently, in a healthy paying group. fourtis shipped
// that three separate times (the pump latch, the portal invite, and the buy
// alert) before writing the rule down: NEVER SPEND THE DEDUPE BUDGET BEFORE
// THE MESSAGE EXISTS.
//
// So delivery is two-phase:
//
//   claim()    a short NX-style hold, so two overlapping polls that both see
//              the same transaction cannot both send it.
//   commit()   the long latch, written ONLY once Telegram has returned a
//              message_id. This is the "never again" mark.
//   release()  the claim is dropped and the next poll retries — for a
//              TRANSIENT failure, where the alert is still wanted.
//
// A FATAL chat error commits instead of releasing: a group that removed the bot
// must not be retried on every poll forever, because those retries come out of
// the same GeckoTerminal / Telegram budget every healthy group shares.
//
// WHY NOT REDIS
// Dexvra has no Redis. It has one bot process and a JSON store that already
// mirrors to Mongo (helpers/persist.js), so the atomicity Redis' NX buys across
// processes is bought here by doing check-and-set synchronously in memory
// BEFORE the await. The file write is the durable copy, not the lock.
const { loadJSONSync, saveJSON } = require("../helpers/persist");

const FILE = "buyLatch.json";

// How long a claim survives without being committed. Long enough to cover a
// slow send (Telegram's own timeout is 120s in this bot), short enough that a
// process killed mid-send re-alerts on the next poll instead of losing the
// transaction. Deliberately NOT the 1h latch: a crash must cost one duplicate
// at worst, never a permanent hole.
const CLAIM_MS = 120 * 1000;
// How long a delivered transaction stays un-repeatable. The trades feed returns
// a 24h window, but the block cursor already stops us re-reading old trades —
// this is the backstop for a cursor that rewinds (a restored file, a pool that
// re-resolves). One hour covers that without growing the file unbounded.
const LATCH_MS = 60 * 60 * 1000;
// Bound the file. Entries expire on their own, but a sweep only runs on write,
// so a burst of groups going quiet at once should not leave megabytes behind.
const MAX_ENTRIES = 20000;

const CLAIMED = "i";
const DONE = "d";

let marks = loadJSONSync(FILE, {}) || {};
let dirty = false;

const now = () => Date.now();
const keyOf = (chatId, txHash) => `${chatId}:${txHash}`;

/** Drop everything already expired. Cheap — this map is small in practice. */
function sweep(at = now()) {
  let removed = 0;
  for (const [k, v] of Object.entries(marks)) {
    if (!v || !(Number(v.u) > at)) {
      delete marks[k];
      removed++;
    }
  }
  // Pathological case: more live entries than we ever want to hold. Evict the
  // soonest-to-expire first — they are the claims, and losing a claim costs at
  // most a duplicate alert, while losing a latch costs a repeat of every
  // transaction in the group.
  const keys = Object.keys(marks);
  if (keys.length > MAX_ENTRIES) {
    keys
      .sort((a, b) => Number(marks[a].u) - Number(marks[b].u))
      .slice(0, keys.length - MAX_ENTRIES)
      .forEach((k) => {
        delete marks[k];
        removed++;
      });
  }
  if (removed) dirty = true;
  return removed;
}

/** Persist. Never throws — a failed write costs a duplicate alert after a
 *  restart, which is strictly better than failing the send that follows it. */
async function flush() {
  if (!dirty) return;
  dirty = false;
  await saveJSON(FILE, marks).catch(() => {});
}

/**
 * Try to take the right to send this transaction's alert.
 * Returns true when the caller owns it and MUST follow up with commit() or
 * release(). Returns false when it is already claimed or already delivered.
 *
 * The check and the write are synchronous on purpose: `await` between them is
 * exactly the window in which two polls both see "free".
 */
function claim(chatId, txHash, at = now()) {
  if (!chatId || !txHash) return false;
  const k = keyOf(chatId, txHash);
  const cur = marks[k];
  if (cur && Number(cur.u) > at) return false; // held or latched
  marks[k] = { s: CLAIMED, u: at + CLAIM_MS };
  dirty = true;
  sweep(at);
  flush();
  return true;
}

/** The alert posted. Latch it for good (well — for LATCH_MS). */
async function commit(chatId, txHash, at = now()) {
  marks[keyOf(chatId, txHash)] = { s: DONE, u: at + LATCH_MS };
  dirty = true;
  await flush();
}

/** The send failed in a way that should be retried. Hand the claim back. */
async function release(chatId, txHash) {
  const k = keyOf(chatId, txHash);
  if (marks[k] === undefined) return;
  delete marks[k];
  dirty = true;
  await flush();
}

/** Has this transaction already been delivered here? (Diagnostics/tests.) */
function isDelivered(chatId, txHash, at = now()) {
  const v = marks[keyOf(chatId, txHash)];
  return !!(v && v.s === DONE && Number(v.u) > at);
}

/** Test seam — forget everything without touching the operator's file. */
function _reset() {
  marks = {};
  dirty = false;
}

module.exports = {
  claim,
  commit,
  release,
  isDelivered,
  sweep,
  flush,
  _reset,
  FILE,
  CLAIM_MS,
  LATCH_MS,
};
