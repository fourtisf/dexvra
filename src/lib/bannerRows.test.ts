// Every live booking must reach the screen — that's what the advertiser paid
// for, and what /advertise promises ("Rotating homepage banner slots") — and a
// Wide must sit to the LEFT of the Standards sharing its row.
import test from "node:test";
import assert from "node:assert";
import { packBannerRows, unitsOf, freeUnits, slotLabel, ROW_UNITS } from "./bannerRows.ts";

const std = (id: string) => ({ slot: "Standard Banner", id });
const wide = (id: string) => ({ slot: "Wide Banner", id });
const house = (id: string) => ({ slot: "Homepage Banner", id }); // admin panel
const ids = (rows: { id: string }[][]) => rows.map((r) => r.map((b) => b.id));

test("column spans: Standard 1, Wide 2, anything else the whole row", () => {
  assert.strictEqual(ROW_UNITS, 4);
  assert.strictEqual(unitsOf(std("a")), 1);
  assert.strictEqual(unitsOf(wide("a")), 2);
  assert.strictEqual(unitsOf({ slot: "standard banner" }), 1, "case-insensitive — the string comes from the bot");
  // An unknown slot spans the row: the harmless failure, vs. a mystery banner
  // squeezed into a quarter column.
  for (const slot of ["Homepage Banner", "Takeover 2026", ""]) {
    assert.strictEqual(unitsOf({ slot }), ROW_UNITS, `${slot || "(empty)"} spans the row`);
  }
});

test("a Wide sits on the LEFT of the Standards sharing its row", () => {
  // Booking order is newest-first; the layout must still put the big one first.
  assert.deepStrictEqual(ids(packBannerRows([std("a"), std("b"), wide("w")])), [["w", "a", "b"]]);
  assert.deepStrictEqual(ids(packBannerRows([std("a"), wide("w")])), [["w", "a"]]);
});

test("order within the same width is preserved (newest first)", () => {
  assert.deepStrictEqual(ids(packBannerRows([std("a"), std("b"), std("c"), std("d")])), [["a", "b", "c", "d"]]);
  assert.deepStrictEqual(ids(packBannerRows([wide("w1"), wide("w2")])), [["w1", "w2"]]);
});

test("one Wide + two Standards fills a row exactly", () => {
  const row = [wide("w"), std("a"), std("b")];
  assert.deepStrictEqual(ids(packBannerRows(row)), [["w", "a", "b"]]);
  assert.strictEqual(freeUnits(row), 0);
});

test("nobody is dropped, whatever the mix", () => {
  for (const list of [
    [std("a")],
    [std("a"), std("b"), std("c"), std("d"), std("e")],
    [wide("w1"), wide("w2"), wide("w3")],
    [house("h"), std("a"), wide("w")],
  ]) {
    const flat = packBannerRows(list).flat();
    assert.strictEqual(flat.length, list.length, "every paid booking is laid out");
    for (const b of list) assert.ok(flat.includes(b), `${b.id} kept`);
  }
});

test("a full-row banner never shares its row", () => {
  assert.deepStrictEqual(ids(packBannerRows([house("h"), std("a")])), [["h"], ["a"]]);
});

test("freeUnits reports the gap a house tile should fill", () => {
  assert.strictEqual(freeUnits([std("a")]), 3, "a lone Standard leaves three columns");
  assert.strictEqual(freeUnits([wide("w")]), 2);
  assert.strictEqual(freeUnits([wide("w"), std("a")]), 1);
  assert.strictEqual(freeUnits([house("h")]), 0);
  assert.strictEqual(freeUnits([]), ROW_UNITS);
});

test("no bookings → no rows (the strip renders nothing)", () => {
  assert.deepStrictEqual(packBannerRows([]), []);
});

test("a Wide can't overflow a narrower row (mobile: 1 column)", () => {
  assert.deepStrictEqual(ids(packBannerRows([wide("w"), std("a")], 1)), [["w"], ["a"]]);
});

test("slot tag names the package a visitor is looking at", () => {
  assert.strictEqual(slotLabel("Wide Banner"), "Wide");
  assert.strictEqual(slotLabel("Standard Banner"), "Standard");
  // The operator's own homepage banner isn't sold inventory — plain "Ad".
  assert.strictEqual(slotLabel("Homepage Banner"), "");
  assert.strictEqual(slotLabel(""), "");
});
