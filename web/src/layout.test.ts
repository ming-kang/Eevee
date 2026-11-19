import assert from "node:assert/strict";
import { test } from "node:test";
import {
  collapsedSideW,
  dismissDrawer,
  drawerFade,
  fitRail,
  fitSidebar,
  MAIN_MIN,
  RAIL,
  readWidth,
  SIDE,
  scaledColumn,
} from "./layout.ts";

const VP = 1600;

test("a sidebar drag clamps to its own range and leaves the main its minimum", () => {
  assert.equal(fitSidebar(100, VP, 0), SIDE.min);
  assert.equal(fitSidebar(300, VP, 0), 300);
  assert.equal(fitSidebar(9999, VP, 0), SIDE.max);
  // A rail on the grid shrinks what the sidebar may take: 1600 - 24 - 336 - 420 = 820 > max.
  assert.equal(fitSidebar(9999, VP, 336), SIDE.max);
  const tight = 420 + 24 + SIDE.min + MAIN_MIN;
  assert.equal(fitSidebar(9999, tight, 420), SIDE.min);
});

test("a drag never collapses: under the minimum it lands on the floor", () => {
  assert.equal(fitSidebar(0, VP, 0), SIDE.min);
  assert.equal(fitSidebar(SIDE.min - 1, VP, 0), SIDE.min);
});

test("a rail drag clamps to its own range and leaves the main its minimum", () => {
  assert.equal(fitRail(100, VP, SIDE.default), RAIL.min);
  assert.equal(fitRail(400, VP, SIDE.default), 400);
  assert.equal(fitRail(9999, VP, SIDE.default), RAIL.max);
  // With a collapsed sidebar the rail gets those 204px of slack back.
  assert.equal(
    fitRail(9999, VP, SIDE.collapsedW),
    Math.min(RAIL.max, VP - 24 - SIDE.collapsedW - MAIN_MIN),
  );
  const tight = SIDE.min + 24 + RAIL.min + MAIN_MIN;
  assert.equal(fitRail(9999, tight, SIDE.min), RAIL.min);
  // An impossible viewport protects the main before the column minimum.
  assert.equal(fitRail(9999, 700, SIDE.min), 700 - 24 - SIDE.min - MAIN_MIN);
});

test("a stored width no longer fitting is re-clamped", () => {
  // 256 fit 1280 when stored; at a viewport that leaves under 200 it comes back at the floor
  // once the rail is a drawer, and under the cap while the rail still renders.
  assert.equal(fitSidebar(256, 800, 0), 256);
  assert.equal(
    fitRail(560, 1280, SIDE.default),
    Math.min(560, 1280 - 24 - SIDE.default - MAIN_MIN),
  );
});

test("readWidth parses defensively", () => {
  assert.equal(readWidth(null, SIDE), SIDE.default);
  assert.equal(readWidth("", SIDE), SIDE.default);
  assert.equal(readWidth("  ", SIDE), SIDE.default);
  assert.equal(readWidth("abc", SIDE), SIDE.default);
  assert.equal(readWidth("256px", SIDE), SIDE.default);
  assert.equal(readWidth("260", SIDE), 260);
  assert.equal(readWidth("3", SIDE), SIDE.min);
  assert.equal(readWidth("99999", SIDE), SIDE.max);
  assert.equal(readWidth("260.6", SIDE), 261);
});

test("a drawer dismisses past a third of its width or on a flick", () => {
  const w = 300;
  assert.equal(dismissDrawer(0.34 * w, w, 0), false);
  assert.equal(dismissDrawer(0.36 * w, w, 0), true);
  assert.equal(dismissDrawer(10, w, 0.6), true);
  assert.equal(dismissDrawer(10, w, 0.4), false);
  assert.equal(dismissDrawer(-5, w, 0), false);
});

test("the overlay fades out as a drawer is dragged away", () => {
  assert.equal(drawerFade(0, 300), 1);
  assert.equal(drawerFade(150, 300), 0.5);
  assert.equal(drawerFade(300, 300), 0);
  assert.equal(drawerFade(400, 300), 0);
  assert.equal(drawerFade(-10, 300), 1);
});

test("the interface scale grows the limits, the collapsed width and the main's minimum", () => {
  const s = 20 / 14;
  // Limits multiply by the scale; default means scale 1.
  assert.deepEqual(scaledColumn(SIDE, 1), { min: SIDE.min, max: SIDE.max, default: SIDE.default });
  assert.equal(collapsedSideW(1), SIDE.collapsedW);
  assert.equal(fitSidebar(100, VP, 0, s), Math.round(SIDE.min * s));
  assert.equal(fitSidebar(9999, VP, 0, s), Math.round(SIDE.max * s));
  // The main keeps its scaled minimum: rail + main + chrome eat the viewport first.
  const tight = SIDE.min * s + 24 + RAIL.min * s + MAIN_MIN * s;
  assert.equal(fitRail(9999, tight, SIDE.min * s, s), Math.round(RAIL.min * s));
});

test("a stored pixel width re-clamps against the scaled range", () => {
  const s = 20 / 14;
  // Below the scaled floor the stored width rises; inside the scaled range it survives.
  assert.equal(readWidth(String(SIDE.min), SIDE, s), Math.round(SIDE.min * s));
  assert.equal(readWidth("400", SIDE, s), 400);
  assert.equal(readWidth("99999", SIDE, s), Math.round(SIDE.max * s));
  // A garbage read falls back to the scaled default.
  assert.equal(readWidth("abc", SIDE, s), SIDE.default * s);
});
