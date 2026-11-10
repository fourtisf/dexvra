// The admin console's view rules — which tab is open, which listings a filter
// keeps, in what order, and which page of them is drawn. PURE and alias-free,
// so `npm test` drives it directly: a rule about what the operator sees is
// tested by being CALLED, never by reading the component.
//
// "perbaiki admin panel agar lebih clean … ini terlalu banyak spam": the
// console used to be one scroll — three site-content editors, the review
// queue, the Pons queue, then EVERY listing (~700 rows, nine controls each)
// and an add form at the very bottom. These rules are what replaced it: one
// tab at a time, the listings filtered and paged, newest first.

export const ADMIN_TABS = ["review", "listings", "pons", "add", "site"] as const;
export type AdminTab = (typeof ADMIN_TABS)[number];

/** The tab a URL hash names; anything else opens the review queue — the one
 *  screen with work waiting on it. The hash keeps a reload (and a bookmark) on
 *  the tab the operator was using. */
export function tabFromHash(hash: string): AdminTab {
  const h = String(hash || "").replace(/^#/, "").trim().toLowerCase();
  return (ADMIN_TABS as readonly string[]).includes(h) ? (h as AdminTab) : "review";
}

export const STATUS_FILTERS = ["all", "approved", "pending", "rejected", "trending", "free"] as const;
export type StatusFilter = (typeof STATUS_FILTERS)[number];

/** The fields these rules read — a structural subset of StoredListing, so the
 *  module needs no import from the store. */
export interface AdminRow {
  id: string;
  chain: string;
  address: string;
  sym: string;
  name: string;
  tier: string;
  status: string;
  createdAt?: number;
  listedAt?: number;
  trendingRank?: number | null;
  trendExp?: number | null;
}

export interface ListFilter {
  q: string;
  status: StatusFilter;
  chain: string; // "all" or a chain id
  tier: string; // "all" or a tier key
}

export const EMPTY_FILTER: ListFilter = { q: "", status: "all", chain: "all", tier: "all" };

/** A slot is TRENDING while it is set, approved, and not past its end. The
 *  site stops featuring a slot the moment `trendExp` passes and the bot's
 *  sweeper clears the rank a little later — counting the rank alone would
 *  report slots as trending that the site has already stopped showing. */
export function isTrending(r: AdminRow, now: number): boolean {
  if (r.trendingRank == null || r.status !== "approved") return false;
  return !(r.trendExp != null && r.trendExp <= now);
}

/** Hours left on a trending slot, rounded UP (a slot with 10 minutes left
 *  still reads "1h"); null when the slot has no end or is not trending. */
export function trendHoursLeft(r: AdminRow, now: number): number | null {
  if (!isTrending(r, now) || r.trendExp == null) return null;
  return Math.max(1, Math.ceil((r.trendExp - now) / 3_600_000));
}

/** When a row arrived: the listing time, else the store's creation time. */
export const arrivedAt = (r: AdminRow): number => r.listedAt ?? r.createdAt ?? 0;

/** A search matches the ticker (with or without its "$"), the name or the
 *  contract. */
function matches(r: AdminRow, q: string): boolean {
  if (!q) return true;
  const needle = q.toLowerCase().replace(/^\$/, "");
  return `${r.sym} ${r.name} ${r.address}`.toLowerCase().includes(needle);
}

function statusKeeps(r: AdminRow, s: StatusFilter, now: number): boolean {
  switch (s) {
    case "all":
      return true;
    case "trending":
      return isTrending(r, now);
    case "free":
      return String(r.tier).toUpperCase() === "FREE";
    default:
      return r.status === s;
  }
}

/** Every row the filter keeps, NEWEST FIRST — the row an operator is looking
 *  for is almost always one that just arrived. Ties keep the store's order. */
export function filterListings<T extends AdminRow>(rows: readonly T[], f: ListFilter, now: number): T[] {
  const q = f.q.trim();
  return rows
    .map((r, i) => ({ r, i }))
    .filter(
      ({ r }) =>
        matches(r, q) &&
        statusKeeps(r, f.status, now) &&
        (f.chain === "all" || r.chain === f.chain) &&
        (f.tier === "all" || r.tier === f.tier),
    )
    .sort((a, b) => arrivedAt(b.r) - arrivedAt(a.r) || a.i - b.i)
    .map(({ r }) => r);
}

export const PAGE_SIZE = 50;

export interface Paged<T> {
  items: T[];
  page: number; // 1-based, clamped into range
  pages: number; // at least 1
  from: number; // 1-based index of the first row shown (0 when empty)
  to: number;
  total: number;
}

/** One page of rows. A page past the end clamps to the last one, so deleting
 *  the final row of the last page never strands the operator on an empty
 *  page. */
export function paginate<T>(rows: readonly T[], page: number, size = PAGE_SIZE): Paged<T> {
  const total = rows.length;
  const pages = Math.max(1, Math.ceil(total / size));
  const p = Math.min(pages, Math.max(1, Math.floor(Number(page) || 1)));
  const start = (p - 1) * size;
  const items = rows.slice(start, start + size);
  return { items, page: p, pages, from: total ? start + 1 : 0, to: start + items.length, total };
}

export interface AdminCounts {
  total: number;
  approved: number;
  pending: number;
  rejected: number;
  trending: number;
  free: number;
}

/** One pass for every number the console prints — the tab badges, the stat
 *  cards and the filter chips all read this, so they cannot disagree. */
export function countListings(rows: readonly AdminRow[], now: number): AdminCounts {
  const c: AdminCounts = { total: rows.length, approved: 0, pending: 0, rejected: 0, trending: 0, free: 0 };
  for (const r of rows) {
    if (r.status === "approved") c.approved++;
    else if (r.status === "pending") c.pending++;
    else if (r.status === "rejected") c.rejected++;
    if (isTrending(r, now)) c.trending++;
    if (String(r.tier).toUpperCase() === "FREE") c.free++;
  }
  return c;
}
