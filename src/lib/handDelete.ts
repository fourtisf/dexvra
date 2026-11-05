// THE OPERATOR'S DELETE — one listing, named by hand, from the server.
//
// "bisakah delete from server?" The admin console's 🗑 deletes any row, because
// an admin removing a listing is a decision. The internal DELETE refuses
// anything somebody paid for, because it exists for BULK scripts, and the one
// thing a bulk cleanup must never do is take a purchase away. An operator
// deleting one named row from a shell is the first kind of act reached through
// the second kind of door — so it has its own route, and two things keep it a
// decision rather than a loophole:
//
//   1. the caller RESTATES the row's address, and it must be the stored one —
//      an id from a loop over the roster is not "the token I meant";
//   2. on the bot side exactly ONE script may call it (`listing:delete`, which
//      names one chain + address and is a dry run without --apply). A test
//      counts the callers, so a bulk script cannot grow a way round the guard.
//
// Pure and alias-free, so `node --test` can call it.

/** Why this by-hand delete is refused, or null when it may go ahead. */
export function handDeleteRefusal(row: { address: string } | null | undefined, given: unknown): string | null {
  if (!row) return "not found";
  const typed = typeof given === "string" ? given.trim() : "";
  if (!typed) return "refused: restate the listing's address — a by-hand delete names the token it removes";
  if (typed.toLowerCase() !== String(row.address).toLowerCase()) {
    return "refused: the address given is not this listing's address — nothing was deleted";
  }
  return null;
}
