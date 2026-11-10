// A DELETED LISTING LEAVES THE BOARD AT ONCE — not on the next market cycle.
//
// "kalo token sudah dihapus berarti token bener2 dihapus". The board is a CACHE
// (`listings:market`, 60s TTL) and `cached()` serves the stale copy while a
// refresh runs — with deliberately no upper bound on how stale, because a
// provider outage must not blank the board. So a row an admin deleted stayed
// on dexvra.io until the next rebuild SUCCEEDED, which on a rate-limited
// afternoon is "until GeckoTerminal answers". And three other surfaces read
// that same payload: the channel's trending mirror (`/api/internal/board-rank`),
// the Top Gainers banner (`/api/tokens`), and the SSR seed of every page.
//
// The fix is a membership check at SERVE time, against the store the delete
// just wrote. The store is an in-memory read, so this costs nothing; the
// market numbers stay as cached, only rows no longer listed are dropped.
//
// Pure and alias-free, so `node --test` can call it.

export interface Keyed {
  chain: string;
  address: string;
}

/** The store's own identity rule: chain + address, address case-insensitive
 *  (`addListing` treats two spellings of one address as the same listing). */
export const listingKey = (r: Keyed): string => `${r.chain}:${String(r.address).toLowerCase()}`;

/**
 * The board tokens whose listing is STILL in the store. `rows` is null when
 * the store could not be read — and then nothing is dropped: "we could not
 * ask" is not "nothing is listed", and filtering against an empty answer
 * would blank the whole board over a read failure.
 */
export function keepCurrent<T extends Keyed>(tokens: T[], rows: Keyed[] | null): T[] {
  if (!rows) return tokens;
  const live = new Set(rows.map(listingKey));
  return tokens.filter((t) => live.has(listingKey(t)));
}
