import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  EMPTY_FILTER,
  PAGE_SIZE,
  countListings,
  filterListings,
  isTrending,
  paginate,
  tabFromHash,
  trendHoursLeft,
} from "./adminView.ts";

const NOW = 10_000_000_000;
const H = 3_600_000;

const row = (o: Record<string, unknown> = {}) => ({
  id: "l_x",
  chain: "solana",
  address: "So1aNaAddr",
  sym: "$BONK",
  name: "Bonk",
  tier: "DIAMOND",
  status: "approved",
  createdAt: 1,
  ...o,
});

test("the hash names the tab, and anything else opens the review queue", () => {
  assert.equal(tabFromHash("#listings"), "listings");
  assert.equal(tabFromHash("#SITE"), "site");
  assert.equal(tabFromHash("pons"), "pons");
  assert.equal(tabFromHash(""), "review");
  assert.equal(tabFromHash("#nope"), "review");
});

test("a trending slot past its end is not trending, even before the sweeper clears it", () => {
  assert.equal(isTrending(row({ trendingRank: 1, trendExp: NOW + H }), NOW), true);
  assert.equal(isTrending(row({ trendingRank: 1, trendExp: NOW - 1 }), NOW), false);
  assert.equal(isTrending(row({ trendingRank: 1 }), NOW), true, "a slot with no end runs until cleared");
  assert.equal(isTrending(row({ trendingRank: 1, status: "pending" }), NOW), false);
  assert.equal(isTrending(row({}), NOW), false);
});

test("hours left round UP, so ten minutes left still reads 1h", () => {
  assert.equal(trendHoursLeft(row({ trendingRank: 1, trendExp: NOW + 10 * 60_000 }), NOW), 1);
  assert.equal(trendHoursLeft(row({ trendingRank: 1, trendExp: NOW + 5 * H + 1 }), NOW), 6);
  assert.equal(trendHoursLeft(row({ trendingRank: 1 }), NOW), null);
  assert.equal(trendHoursLeft(row({ trendingRank: 1, trendExp: NOW - 1 }), NOW), null);
});

test("newest first, by listing time and then by creation time; ties keep the store's order", () => {
  const rows = [
    row({ id: "old", listedAt: 100 }),
    row({ id: "new", listedAt: 300 }),
    row({ id: "mid", createdAt: 200 }),
    row({ id: "tie-a", listedAt: 50 }),
    row({ id: "tie-b", listedAt: 50 }),
  ];
  assert.deepEqual(
    filterListings(rows, EMPTY_FILTER, NOW).map((r) => r.id),
    ["new", "mid", "old", "tie-a", "tie-b"],
  );
});

test("search matches ticker with or without $, the name and the contract", () => {
  const rows = [
    row({ id: "a", sym: "$BONK", name: "Bonk", address: "DezXAZ8z" }),
    row({ id: "b", sym: "$WIF", name: "dogwifhat", address: "EKpQGSJt" }),
  ];
  const q = (s: string) => filterListings(rows, { ...EMPTY_FILTER, q: s }, NOW).map((r) => r.id);
  assert.deepEqual(q("bonk"), ["a"]);
  assert.deepEqual(q("$wif"), ["b"]);
  assert.deepEqual(q("dogwif"), ["b"]);
  assert.deepEqual(q("ekpq"), ["b"]);
  assert.deepEqual(q("  "), ["a", "b"], "a blank search keeps everything");
  assert.deepEqual(q("BONK"), ["a"], "case does not matter");
  const bare = [row({ id: "c", sym: "PEPE", name: "Pepe", address: "0xabc" })];
  assert.deepEqual(
    filterListings(bare, { ...EMPTY_FILTER, q: "$pepe" }, NOW).map((r) => r.id),
    ["c"],
    "a typed $ finds a ticker stored without one",
  );
});

test("the status chips: approved, pending, rejected, trending and the bot's free rows", () => {
  const rows = [
    row({ id: "ap", status: "approved" }),
    row({ id: "pe", status: "pending" }),
    row({ id: "re", status: "rejected" }),
    row({ id: "tr", status: "approved", trendingRank: 1, trendExp: NOW + H }),
    row({ id: "ex", status: "approved", trendingRank: 1, trendExp: NOW - H }),
    row({ id: "fr", status: "approved", tier: "FREE" }),
  ];
  const by = (status: any) => filterListings(rows, { ...EMPTY_FILTER, status }, NOW).map((r) => r.id).sort();
  assert.deepEqual(by("pending"), ["pe"]);
  assert.deepEqual(by("rejected"), ["re"]);
  assert.deepEqual(by("trending"), ["tr"], "an expired slot is not in the trending view");
  assert.deepEqual(by("free"), ["fr"]);
  assert.deepEqual(by("approved"), ["ap", "ex", "fr", "tr"]);
});

test("chain and tier narrow the list and combine with the rest", () => {
  const rows = [
    row({ id: "s-d", chain: "solana", tier: "DIAMOND" }),
    row({ id: "s-f", chain: "solana", tier: "FREE" }),
    row({ id: "r-d", chain: "robinhood", tier: "DIAMOND" }),
  ];
  const ids = (f: any) => filterListings(rows, { ...EMPTY_FILTER, ...f }, NOW).map((r) => r.id).sort();
  assert.deepEqual(ids({ chain: "robinhood" }), ["r-d"]);
  assert.deepEqual(ids({ tier: "DIAMOND" }), ["r-d", "s-d"]);
  assert.deepEqual(ids({ chain: "solana", tier: "FREE" }), ["s-f"]);
});

test("pagination: fixed-size pages, and a page past the end clamps to the last one", () => {
  const rows = Array.from({ length: 2 * PAGE_SIZE + 7 }, (_, i) => i);
  const p1 = paginate(rows, 1);
  assert.equal(p1.items.length, PAGE_SIZE);
  assert.deepEqual([p1.from, p1.to, p1.pages, p1.total], [1, PAGE_SIZE, 3, rows.length]);
  const p3 = paginate(rows, 3);
  assert.deepEqual([p3.from, p3.to, p3.items.length], [2 * PAGE_SIZE + 1, rows.length, 7]);
  assert.equal(paginate(rows, 99).page, 3, "past the end lands on the last page, never an empty one");
  assert.equal(paginate(rows, 0).page, 1);
  const none = paginate([], 4);
  assert.deepEqual([none.page, none.pages, none.from, none.to, none.items.length], [1, 1, 0, 0, 0]);
});

test("one count pass for the badges, the cards and the chips", () => {
  const c = countListings(
    [
      row({ status: "approved" }),
      row({ status: "approved", tier: "FREE" }),
      row({ status: "pending" }),
      row({ status: "rejected" }),
      row({ status: "approved", trendingRank: 2, trendExp: NOW + H }),
      row({ status: "approved", trendingRank: 2, trendExp: NOW - H }),
    ],
    NOW,
  );
  assert.deepEqual(c, { total: 6, approved: 4, pending: 1, rejected: 1, trending: 1, free: 1 });
});

// ── The page itself ─────────────────────────────────────────────────────────
// It cannot be imported here (it uses "@/" aliases), so its wiring is pinned
// by reading the comment-stripped source.
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const PAGE = strip(readFileSync(new URL("../app/panel/page.tsx", import.meta.url), "utf8"));
const LIST = strip(readFileSync(new URL("../components/admin/ListingsTable.tsx", import.meta.url), "utf8"));

test("the console renders one tab at a time, and the listings through the filter and the pager", () => {
  for (const t of ["review", "listings", "pons", "add", "site"]) {
    assert.match(PAGE, new RegExp(`tab === "${t}"`), `the ${t} tab is gated on the open tab`);
  }
  assert.match(LIST, /filterListings\(/, "the table draws through the filter");
  assert.match(LIST, /paginate\(/, "and through the pager — never every row at once");
  assert.doesNotMatch(LIST, /\brows\.map\(/, "no path draws the unfiltered, unpaged rows");
});

test("the tier picker offers FREE, so a bot listing no longer reads as Diamond", () => {
  // A <select> whose value matches no option shows its FIRST option — every
  // FREE row used to read "Diamond", and one careless tap would have upgraded it.
  assert.match(LIST, /const TIER_OPTIONS = \[[^\]]*\bFREE_TIER\b[^\]]*\]/, "FREE is one of the options");
  assert.ok((LIST.match(/TIER_OPTIONS\.map\(/g) || []).length >= 2, "the filter and the Manage picker both draw from it");
});

test("the table's clock is re-read when the rows reload, so a 5h slot reads 5h", () => {
  assert.match(LIST, /useEffect\(\(\) => setNow\(Date\.now\(\)\), \[rows\]\)/);
});

test("a refused action is SAID, never swallowed", () => {
  assert.match(PAGE, /setNote\(/, "the page has a place to report a failed action");
  assert.doesNotMatch(PAGE, /if \(r\.ok\) await load\(\);\s*\}/, "no action drops its failure on the floor");
});
