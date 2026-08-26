import test from "node:test";
import assert from "node:assert/strict";
import { AUTO, clampAdjust, isAdjusted, panByDrag, priceScale, zoomByDrag } from "./chartScale.ts";

const PLOT = { top: 14, height: 300 };
/** The window that produced the report: $BREAKING, 0.000803 → 0.0281 in two
 *  days. On a linear axis its whole history sits on the floor. */
const BREAKING = { lo: 0.000803, hi: 0.0281 };
const near = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) <= eps * Math.max(1, Math.abs(b));

test("auto: the data fills the panel, with headroom at both ends", () => {
  const s = priceScale(BREAKING, "lin", AUTO, PLOT);
  assert.ok(s.lo < BREAKING.lo && s.hi > BREAKING.hi, "a wick never touches the frame");
  // The highest high sits near the top and the lowest low near the bottom.
  assert.ok(s.yOf(BREAKING.hi) > PLOT.top);
  assert.ok(s.yOf(BREAKING.lo) < PLOT.top + PLOT.height);
  assert.ok(s.yOf(BREAKING.hi) < s.yOf(BREAKING.lo), "a higher price is higher up the panel");
});

test("THE BUG: on a linear axis a 30x move flattens its own history", () => {
  // Not an assertion about taste — this is the picture that was reported. The
  // MIDDLE of the move (the geometric mean, $0.00475: the price at which the
  // token had done half its multiple) belongs somewhere near the middle of a
  // chart of that move. On a linear axis it is in the bottom sixth, and
  // everything below it — most of the two days — is a line on the floor.
  const mid = Math.sqrt(BREAKING.lo * BREAKING.hi);
  const lin = priceScale(BREAKING, "lin", AUTO, PLOT);
  const upFrom = (s: { yOf: (p: number) => number }, p: number) =>
    (PLOT.top + PLOT.height - s.yOf(p)) / PLOT.height;
  assert.ok(upFrom(lin, mid) < 0.2, `half the move sat ${(upFrom(lin, mid) * 100).toFixed(0)}% up the panel`);
});

test("…and on a log axis it is readable across the whole panel", () => {
  const mid = Math.sqrt(BREAKING.lo * BREAKING.hi);
  const log = priceScale(BREAKING, "log", AUTO, PLOT);
  const upFrom = (s: { yOf: (p: number) => number }, p: number) =>
    (PLOT.top + PLOT.height - s.yOf(p)) / PLOT.height;
  const at = upFrom(log, mid);
  assert.ok(at > 0.4 && at < 0.6, `half the move sits at ${(at * 100).toFixed(0)}% up the panel`);
  // A doubling is the same distance wherever it happens — the property that
  // makes a log axis worth having.
  const d1 = log.yOf(0.001) - log.yOf(0.002);
  const d2 = log.yOf(0.01) - log.yOf(0.02);
  assert.ok(near(d1, d2, 1e-6), "equal ratios are equal distances");
});

test("⚠️ the LINEAR auto range never bottoms out at zero on a big move", () => {
  // The six lines this module replaced floored the padded low at `lo * 0.5` —
  // "never more than one halving below the lowest price" — and the first cut
  // dropped it. On a 35x, 6% of the RANGE is bigger than the whole bottom of
  // it, so the axis bottomed at $0: a third of the panel given to prices that
  // never existed, squashing the early history further onto the floor, on the
  // exact chart this module exists for.
  const s = priceScale(BREAKING, "lin", AUTO, PLOT);
  assert.ok(s.lo >= BREAKING.lo * 0.5 - 1e-12, `lo was ${s.lo}, expected no lower than ${BREAKING.lo * 0.5}`);
  assert.ok(s.lo > 0, "and certainly not zero");
  // …and it still pads normally when the range is not extreme.
  const ordinary = priceScale({ lo: 100, hi: 110 }, "lin", AUTO, PLOT);
  assert.ok(ordinary.lo < 100 && ordinary.lo > 99, `padded to ${ordinary.lo}, not floored`);
});

test("…but the floor is a LINEAR rule and does not bind a log axis", () => {
  // Log padding is symmetric in RATIO and behaves by itself; applying a linear
  // floor there would refuse the reader the bottom of their own chart.
  const s = priceScale(BREAKING, "log", AUTO, PLOT);
  assert.ok(s.lo < BREAKING.lo && s.lo > 0);
});

test("a log axis never asks for the log of a non-positive price", () => {
  // Math.log10(0) is -Infinity and one of those turns the whole axis into NaN,
  // which renders as an empty panel that reads exactly like a chart loading.
  const s = priceScale({ lo: 0, hi: 0 }, "log", AUTO, PLOT);
  assert.ok(Number.isFinite(s.yOf(0)), "still a number");
  assert.ok(Number.isFinite(s.lo) && Number.isFinite(s.hi));
});

test("a window in which nothing moved is still drawable", () => {
  for (const mode of ["lin", "log"] as const) {
    const s = priceScale({ lo: 1, hi: 1 }, mode, AUTO, PLOT);
    assert.ok(Number.isFinite(s.yOf(1)) && s.hi > s.lo, `${mode}: no division by zero`);
  }
});

// ── the reader's vertical ───────────────────────────────────────────────────

test("dragging the axis UP stretches the chart; DOWN squashes it", () => {
  const up = zoomByDrag(AUTO, -PLOT.height, PLOT.height);
  const down = zoomByDrag(AUTO, PLOT.height, PLOT.height);
  assert.ok(up.zoom > 1, "up = stretch");
  assert.ok(down.zoom < 1, "down = squash");
  const stretched = priceScale(BREAKING, "lin", up, PLOT);
  const squashed = priceScale(BREAKING, "lin", down, PLOT);
  assert.ok(stretched.hi - stretched.lo < BREAKING.hi - BREAKING.lo, "fewer dollars across the panel");
  assert.ok(squashed.hi - squashed.lo > BREAKING.hi - BREAKING.lo);
});

test("a stretch keeps the middle of the view where it was", () => {
  // Zooming that also slid the chart up the axis would be a control nobody can
  // aim: you would lose the candle you were looking at.
  const auto = priceScale(BREAKING, "log", AUTO, PLOT);
  const zoomed = priceScale(BREAKING, "log", zoomByDrag(AUTO, -80, PLOT.height), PLOT);
  const midAuto = auto.priceAt(0.5);
  const midZoom = zoomed.priceAt(0.5);
  assert.ok(near(midAuto, midZoom, 1e-6), "same price at the centre line");
});

test("dragging the chart DOWN moves the candles down — content follows the finger", () => {
  const s0 = priceScale(BREAKING, "lin", AUTO, PLOT);
  const s1 = priceScale(BREAKING, "lin", panByDrag(AUTO, 40, PLOT.height), PLOT);
  assert.ok(s1.yOf(BREAKING.hi) > s0.yOf(BREAKING.hi), "the same price is lower on the panel");
  const s2 = priceScale(BREAKING, "lin", panByDrag(AUTO, -40, PLOT.height), PLOT);
  assert.ok(s2.yOf(BREAKING.hi) < s0.yOf(BREAKING.hi), "and higher when dragged up");
});

test("⚠️ a pan moves by what is ON SCREEN, not by the auto span", () => {
  // `shift` is in auto spans and the drag is against the VISIBLE one. Without
  // dividing by the zoom, panning a chart stretched 10x flings it off in a few
  // pixels — the same drag has to travel the same distance on screen.
  const stretched = { zoom: 10, shift: 0 };
  const panned = panByDrag(stretched, 30, PLOT.height);
  const before = priceScale(BREAKING, "lin", stretched, PLOT);
  const after = priceScale(BREAKING, "lin", panned, PLOT);
  const moved = after.yOf(before.priceAt(0.5)) - PLOT.top - PLOT.height / 2;
  assert.ok(Math.abs(moved - 30) < 1, `a 30px drag moved the content 30px, not ${moved.toFixed(1)}px`);
});

test("zoom and shift are bounded, so no drag can produce an empty panel", () => {
  const far = zoomByDrag({ zoom: 1, shift: 0 }, -100_000, PLOT.height);
  assert.ok(Number.isFinite(far.zoom) && far.zoom <= 60);
  const tiny = zoomByDrag({ zoom: 1, shift: 0 }, 100_000, PLOT.height);
  assert.ok(tiny.zoom >= 0.02);
  const away = panByDrag({ zoom: 1, shift: 0 }, 1e9, PLOT.height);
  assert.ok(Math.abs(away.shift) <= 8);
});

test("a non-finite adjust falls back to auto rather than to NaN", () => {
  assert.deepEqual(clampAdjust({ zoom: NaN, shift: NaN }), AUTO);
  assert.deepEqual(clampAdjust(null), AUTO);
  const s = priceScale(BREAKING, "lin", { zoom: NaN, shift: 0 }, PLOT);
  assert.ok(Number.isFinite(s.yOf(BREAKING.hi)));
});

test("⚠️ a linear axis never prints a negative price", () => {
  // Squash far enough and the padded range walks past the origin, and the
  // gutter starts labelling dollars that cannot exist — on the panel somebody
  // is reading to decide whether to buy.
  const squashed = { zoom: 0.02, shift: -8 };
  const s = priceScale(BREAKING, "lin", squashed, PLOT);
  assert.ok(s.lo >= 0, `lo was ${s.lo}`);
  for (let i = 0; i <= 10; i++) assert.ok(s.priceAt(i / 10) >= 0);
});

test("…and a log axis is not floored at zero, because 10^-9 is a price", () => {
  const s = priceScale(BREAKING, "log", { zoom: 0.05, shift: -2 }, PLOT);
  assert.ok(s.lo > 0 && s.lo < BREAKING.lo, "small, and still a positive price");
});

test("the grid's ticks are evenly spaced in the AXIS's space, not in dollars", () => {
  const s = priceScale(BREAKING, "log", AUTO, PLOT);
  const ys = [0, 0.25, 0.5, 0.75, 1].map((f) => s.yOf(s.priceAt(f)));
  for (let i = 1; i < ys.length; i++)
    assert.ok(near(ys[i - 1] - ys[i], ys[0] - ys[1], 1e-6), "the lines are evenly spaced on the panel");
});

test("isAdjusted answers the question the panel prints", () => {
  assert.equal(isAdjusted(AUTO), false);
  assert.equal(isAdjusted({ zoom: 1.2, shift: 0 }), true);
  assert.equal(isAdjusted({ zoom: 1, shift: -0.3 }), true);
});

test("the scale describes a RELATIONSHIP, so new candles do not strand it", () => {
  // Storing a {lo,hi} pair instead would go on describing a range the market
  // has left, and a chart left alone for an hour would drift off its own
  // candles while the reader watched.
  const adj = zoomByDrag(AUTO, -60, PLOT.height);
  const before = priceScale(BREAKING, "log", adj, PLOT);
  const after = priceScale({ lo: BREAKING.lo, hi: BREAKING.hi * 1.5 }, "log", adj, PLOT);
  assert.ok(after.hi > before.hi, "the view followed the data");
  assert.ok(after.hi - after.lo > 0);
});
