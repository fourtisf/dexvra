// Every live booking must reach the screen — that's what the advertiser paid
// for, and what /advertise promises ("Rotating homepage banner slots").
import test from "node:test";
import assert from "node:assert";
import { packBannerRows, isHalfSlot, isFullWidthSlot, freeUnits, unitsOf, ROW_UNITS } from "./bannerRows.ts";

const std = (id: string) => ({ slot: "Standard Banner", id });
const wide = (id: string) => ({ slot: "Wide Banner", id });
const house = (id: string) => ({ slot: "Homepage Banner", id }); // admin panel
const ids = (rows: { id: string }[][]) => rows.map((r) => r.map((b) => b.id));

test("only the sold Standard is a half-slot; everything else fills the row", () => {
  assert.strictEqual(isHalfSlot("Standard Banner"), true);
  assert.strictEqual(isHalfSlot("standard banner"), true, "case-insensitive — the slot string comes from the bot");
  assert.strictEqual(unitsOf(std("a")), 1);
  // Wide (bot), Homepage Banner (admin panel) and any slot added later.
  for (const slot of ["Wide Banner", "Homepage Banner", "Takeover 2026", ""]) {
    assert.strictEqual(isFullWidthSlot(slot), true, `${slot || "(empty)"} must take the whole row`);
    assert.strictEqual(unitsOf({ slot }), ROW_UNITS);
  }
});

test("an admin-panel banner is full width, not a half with a gap", () => {
  // The panel writes slot:"Homepage Banner" — matching /wide/ instead would have
  // rendered the operator's own banner at half width beside dead space.
  assert.deepStrictEqual(ids(packBannerRows([house("h")])), [["h"]]);
  assert.strictEqual(freeUnits([house("h")]), 0, "it fills the row on its own");
});

test("freeUnits reports the gap a house tile should fill", () => {
  assert.strictEqual(freeUnits([std("a")]), 1, "a lone Standard leaves half the row");
  assert.strictEqual(freeUnits([std("a"), std("b")]), 0);
  assert.strictEqual(freeUnits([wide("w")]), 0);
  assert.strictEqual(freeUnits([]), ROW_UNITS);
});

test("two Standards share a row, like the reference layout", () => {
  assert.deepStrictEqual(ids(packBannerRows([std("a"), std("b")])), [["a", "b"]]);
});

test("a Wide never shares its row", () => {
  assert.deepStrictEqual(ids(packBannerRows([wide("w"), std("a"), std("b")])), [["w"], ["a", "b"]]);
  // …including when it lands mid-sequence: the half before it keeps its row.
  assert.deepStrictEqual(ids(packBannerRows([std("a"), wide("w"), std("b")])), [["a"], ["w"], ["b"]]);
});

test("nobody is dropped, whatever the mix", () => {
  for (const list of [
    [std("a")],
    [std("a"), std("b"), std("c")],
    [wide("w1"), wide("w2")],
    [std("a"), std("b"), wide("w"), std("c"), std("d"), std("e")],
  ]) {
    const flat = packBannerRows(list).flat();
    assert.deepStrictEqual(
      flat.map((b) => b.id),
      list.map((b) => b.id),
      "same bookings, same order — a paid booking is never skipped",
    );
  }
});

test("an odd Standard still gets its own row (never silently cut)", () => {
  assert.deepStrictEqual(ids(packBannerRows([std("a"), std("b"), std("c")])), [["a", "b"], ["c"]]);
});

test("no bookings → no rows (the strip renders nothing)", () => {
  assert.deepStrictEqual(packBannerRows([]), []);
});

test("a Wide can't overflow a narrower row (mobile: 1 unit per row)", () => {
  // Phones drop to one banner per row; a Wide must still occupy exactly one row
  // rather than being packed away or producing an empty one.
  assert.deepStrictEqual(ids(packBannerRows([wide("w"), std("a")], 1)), [["w"], ["a"]]);
});
