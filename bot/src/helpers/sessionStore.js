"use strict";
/**
 * The main bot's session store, owned HERE rather than created inside
 * `telegraf.session()`, so code running AFTER a handler returned can ask what
 * a chat's session is NOW.
 *
 * Why that is needed: a background answer (the listing form's second look at
 * a token's own metadata, `handlers/listing.js` lateFill) holds the `ctx` of
 * the update that started it — and `ctx.session` there is the object as it was
 * THEN. Every flow entry REPLACES the session wholesale (`freshSession`,
 * `/start`, listedGuard), so a buyer who moved on to another flow is invisible
 * through the old `ctx`, and a late answer would repaint a review card over
 * the new flow. `peek` reads the store's current object, which is what a guard
 * has to compare against.
 *
 * Still telegraf's own in-memory store — same TTL (none), same semantics; only
 * the instance is reachable now. The key is the one the bot already used.
 */
const { MemorySessionStore } = require("telegraf");

const store = new MemorySessionStore();
const key = (ctx) => (ctx && ctx.from && ctx.chat ? `${ctx.from.id}:${ctx.chat.id}` : undefined);

/** The chat's CURRENT session object, or undefined. Read-only by contract. */
function peek(ctx) {
  const k = key(ctx);
  return k ? store.get(k) : undefined;
}

module.exports = { store, key, peek };
