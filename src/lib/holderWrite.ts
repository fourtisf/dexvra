// The one write /api/holders makes to the listing store — as a PURE decision,
// for the reason logoWrite.ts states: store.ts cannot be loaded by the test
// runner, and "never writes a zero" is a mutation property a source scan
// cannot tell from a comment about one.
//
// WHY IT WRITES AT ALL. The sources this box can reach come and go: on the box,
// robinhoodchain.blockscout.com answered 403, DexScreener's internal host 403,
// and GeckoTerminal almost never has a free slot. A count that one of them
// managed to give us once is worth keeping. So it is stored on the row, where
// the board, the Dexvra Score and the token page already read `holders`, and a
// source that is refusing us tomorrow costs a slightly old number, not a "—".

export interface HolderRow {
  chain: string;
  address: string;
  holders: number;
}

/** A move smaller than this is not worth rewriting the whole store (and its
 *  Mongo mirror) for — holder counts tick constantly. */
export const HOLDER_WRITE_MIN_CHANGE = 0.01;

export function applyHolderCount<T extends HolderRow>(
  rows: T[],
  chain: string,
  address: string,
  count: number,
): { rows: T[]; wrote: boolean } {
  // ⚠️ ONLY A POSITIVE MEASUREMENT. A listed token has a supply and somebody
  // holds it, so 0 is "not indexed yet" — writing it would put back the
  // "HOLDERS 0" this whole feature exists to end.
  if (!Number.isFinite(count) || count <= 0) return { rows, wrote: false };
  const n = Math.round(count);
  const want = String(address ?? "").toLowerCase();
  if (!want || !chain) return { rows, wrote: false };
  let wrote = false;
  const next = rows.map((r) => {
    if (wrote || r.chain !== chain || String(r.address).toLowerCase() !== want) return r;
    const was = Number(r.holders) || 0;
    if (was > 0 && Math.abs(n - was) / was < HOLDER_WRITE_MIN_CHANGE) return r;
    wrote = true;
    return { ...r, holders: n };
  });
  return wrote ? { rows: next, wrote } : { rows, wrote };
}
