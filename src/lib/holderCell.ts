/**
 * What the token page's Holders cell says. PURE, so the rule is tested by
 * being called.
 *
 * A MEASURED count wins (/api/holders — the chain's explorer, else GT's token
 * info); a count the row itself carries (an admin typed it, or the demo seed)
 * comes next; otherwise "—".
 *
 * ⚠️ NEVER A NUMBER NOBODY TOOK. The row defaults `holders` to 0 and no provider
 * ever filled it, so every listing on the site printed "HOLDERS 0" — $SFX with
 * 1,570 holders on DexScreener among them. A zero is a claim, and that one was
 * false everywhere it appeared.
 *
 * ⚠️ GROUPED, NOT ABBREVIATED, below a million. `fmtNum` gives "1.6K", which is
 * right for a market cap and wrong for a COUNT: 1,570 and 1,620 both render
 * "1.6K", and how many wallets hold it is the number the reader came for — the
 * rule the trades panel already carries for buys and sells.
 */
export function holdersCell(feed: { count: number | null } | null, stored: number | null | undefined): string {
  const n = feed?.count != null ? feed.count : stored != null && stored > 0 ? stored : null;
  if (n == null || !Number.isFinite(n) || n < 0) return "—";
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  return Math.round(n).toLocaleString("en-US");
}
