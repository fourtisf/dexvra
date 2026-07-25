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

/** A row holds this many slot-units: two Standard banners, or one full-width. */
export const ROW_UNITS = 2;

/**
 * ONLY the sold "Standard Banner" (728 × 90) is a half-slot. Everything else —
 * "Wide Banner" from the bot, "Homepage Banner" created in the admin panel, and
 * any slot name added later — takes the whole row.
 *
 * The rule is written this way round on purpose: matching /wide/ instead would
 * silently render an admin's own homepage banner at half width with a blank gap
 * beside it, and would do the same to every future slot name. An unknown slot
 * defaulting to full width is the safe failure.
 */
export const isHalfSlot = (slot: string): boolean => /standard/i.test(slot || "");
export const isFullWidthSlot = (slot: string): boolean => !isHalfSlot(slot);
export const unitsOf = (b: BannerLike): number => (isHalfSlot(b.slot) ? 1 : ROW_UNITS);

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

/** Slot-units still free in a row — a lone Standard leaves one half empty, which
 *  the ad row fills with a quiet "Advertise here" tile instead of dead space. */
export function freeUnits<T extends BannerLike>(row: T[], unitsPerRow = ROW_UNITS): number {
  const used = row.reduce((n, b) => n + Math.min(unitsOf(b), unitsPerRow), 0);
  return Math.max(0, unitsPerRow - used);
}
