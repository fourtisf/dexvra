// Every live booking must reach the screen — that's what the advertiser paid
// for, and what /advertise promises ("Rotating homepage banner slots").
import test from "node:test";
import assert from "node:assert";
import { packBannerRows, isWideSlot, unitsOf, ROW_UNITS } from "./bannerRows.ts";

const std = (id: string) => ({ slot: "Standard Banner", id });
const wide = (id: string) => ({ slot: "Wide Banner", id });
const ids = (rows: { id: string }[][]) => rows.map((r) => r.map((b) => b.id));

test("slot sizing: Wide takes the whole row, Standard a half", () => {
  assert.strictEqual(isWideSlot("Wide Banner"), true);
  assert.strictEqual(isWideSlot("wide banner"), true, "case-insensitive — the slot string comes from the bot");
  assert.strictEqual(isWideSlot("Standard Banner"), false);
  assert.strictEqual(unitsOf(wide("a")), ROW_UNITS);
  assert.strictEqual(unitsOf(std("a")), 1);
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
