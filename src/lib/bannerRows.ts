// How live banner bookings are laid out in the homepage ad row.
//
// Kept out of the component and pure because this decides WHICH paying
// advertisers are on screen: the previous version rendered banners[0] only, so a
// second concurrent booking was invisible for its whole paid run. /advertise
// sells "Rotating homepage banner slots" — this is the code that has to keep
// that promise.

export interface BannerLike {
  slot: string;
}

/** A row holds this many slot-units: two Standard banners, or one Wide. */
export const ROW_UNITS = 2;

/** Wide bookings are sold as the full-width slot; everything else is a half. */
export const isWideSlot = (slot: string): boolean => /wide/i.test(slot || "");
export const unitsOf = (b: BannerLike): number => (isWideSlot(b.slot) ? ROW_UNITS : 1);

/**
 * Pack bookings into rows of ROW_UNITS, preserving order (newest first, the
 * order activeBanners() returns). A Wide banner never shares its row; two
 * Standards pair up. Rows past the first are paged through on a timer, so every
 * booking is shown regardless of how many are live at once.
 */
export function packBannerRows<T extends BannerLike>(list: T[], unitsPerRow = ROW_UNITS): T[][] {
  const rows: T[][] = [];
  let row: T[] = [];
  let used = 0;
  for (const b of list) {
    const u = Math.min(unitsOf(b), unitsPerRow);
    if (used + u > unitsPerRow) {
      rows.push(row);
      row = [];
      used = 0;
    }
    row.push(b);
    used += u;
  }
  if (row.length) rows.push(row);
  return rows;
}
