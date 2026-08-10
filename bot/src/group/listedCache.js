// Is the token a group is tracking actually listed on dexvra.io?
//
// The buy bot is free and works on ANY contract, so most groups running it have
// never bought a listing. Their alerts were still linking to a dexvra.io token
// page that does not exist — a 404 on every buy, on the one link that is
// supposed to sell the product.
//
// CACHED, because the answer comes from a full listings fetch and the question
// is asked on every alert. Nothing else in the bot may call findListing() from
// the alert path.
const api = require("../api/dexvra");
const log = require("../helpers/logger");

// A listing never disappears mid-session, so a HIT is kept for the life of the
// process. A MISS is re-checked, because the point of the "not listed yet" note
// is to sell a listing — it has to stop appearing once they buy one, without
// waiting for a restart.
const MISS_TTL_MS = 10 * 60 * 1000;
const cache = new Map(); // `${chain}:${address}` → { listed, at }

const keyOf = (chain, address) => `${String(chain || "").toLowerCase()}:${String(address || "").toLowerCase()}`;

/**
 * true / false, or NULL when we could not tell.
 *
 * null is not "not listed", and the difference matters: an unreachable internal
 * API must never make a paying customer's group read "your token isn't listed
 * yet". The caller shows the link and skips the note on null.
 */
async function isListed(chain, address) {
  if (!chain || !address) return null;
  const key = keyOf(chain, address);
  const hit = cache.get(key);
  if (hit && (hit.listed || Date.now() - hit.at < MISS_TTL_MS)) return hit.listed;
  try {
    const rec = await api.findListing(chain, address);
    const listed = !!rec;
    cache.set(key, { listed, at: Date.now() });
    return listed;
  } catch (e) {
    log.debug(`[buybot] listing check for ${key} failed (${e && e.message}) — treating as unknown`);
    return null;
  }
}

/** Drop a cached answer — for the tests, and for anything that learns a group
 *  just bought a listing and wants the note gone on the next alert. */
function forget(chain, address) {
  if (chain == null) return void cache.clear();
  cache.delete(keyOf(chain, address));
}

module.exports = { isListed, forget, MISS_TTL_MS, _cache: cache };
