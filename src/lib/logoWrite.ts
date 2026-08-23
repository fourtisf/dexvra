// The one write the background logo sweep is allowed to make to the public
// listing store — as a PURE decision, so the rule can be driven by a test.
//
// store.ts is unreachable from the node:test runner (it imports "./listings"
// without an extension, which only Next resolves), and this is exactly the kind
// of rule that must not be tested by reading the source: "never overwrites" is a
// mutation property, and a source scan cannot tell a guard from a comment about
// one. Same split as pnl.js in the trade bot — the arithmetic lives where a test
// can call it, the I/O stays in the store.

export interface LogoRow {
  chain: string;
  address: string;
  logoUrl?: string;
}

/**
 * Fill in a resolved logo for one listing.
 *
 * ⚠️ IT CAN ONLY TURN "NOTHING" INTO "SOMETHING". An admin-set logo and a
 * project's own upload are decisions somebody made; a resolved one is the site
 * filling a blank. That asymmetry is what makes this safe to call from a
 * background sweep nobody is watching, and it is the whole function.
 *
 * The address matches case-insensitively (a checksummed address from a market
 * provider and a lowercased one in the store are the same token) and the chain
 * exactly (the same address on two chains is two tokens).
 *
 * Returns the rows to persist and whether anything actually changed, so a sweep
 * can report how much of its work became permanent rather than only living in
 * one process's memory.
 */
export function applyResolvedLogo<T extends LogoRow>(
  rows: T[],
  chain: string,
  address: string,
  logoUrl: string,
): { rows: T[]; wrote: boolean } {
  // The value lands on a public board and in the bot's channel posts, so it is
  // checked here rather than trusted from whatever source produced it.
  if (!/^https:\/\/[^\s"'<>]+$/i.test(String(logoUrl ?? "").trim())) return { rows, wrote: false };
  const want = String(address ?? "").toLowerCase();
  if (!want || !chain) return { rows, wrote: false };

  let wrote = false;
  const next = rows.map((r) => {
    if (wrote || r.chain !== chain || String(r.address).toLowerCase() !== want || r.logoUrl) return r;
    wrote = true;
    return { ...r, logoUrl };
  });
  return wrote ? { rows: next, wrote } : { rows, wrote };
}
