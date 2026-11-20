import assert from "node:assert/strict";
import { test } from "node:test";
import {
  dismissDrawer,
  drawerFade,
  fitRail,
  fitSidebar,
  MAIN_MIN,
  RAIL,
  readWidth,
  SIDE,
  scaledColumn,
  WORKER_RAIL,
} from "./layout.ts";

const VP = 1600;

test("Worker rail uses a wider default and only caps at the remaining center minimum", () => {
  assert.equal(RAIL.default, 480);
  assert.equal(readWidth(null, RAIL), 480);
  assert.equal(WORKER_RAIL.default, 540);
  assert.equal(fitRail(0, VP, SIDE.default, 1, WORKER_RAIL), 360);
  assert.equal(fitRail(540, VP, SIDE.default, 1, WORKER_RAIL), 540);
  assert.equal(fitRail(9999, VP, SIDE.default, 1, WORKER_RAIL), VP - SIDE.default - MAIN_MIN);
  assert.equal(fitRail(9999, VP, 0, 1, WORKER_RAIL), VP - MAIN_MIN);
  assert.equal(fitRail(9999, 700, SIDE.default, 1, WORKER_RAIL), 700 - SIDE.default - MAIN_MIN);
  assert.equal(readWidth(null, WORKER_RAIL), 540);
  assert.equal(readWidth("invalid", WORKER_RAIL), 540);
  assert.equal(readWidth("200", WORKER_RAIL), 360);
  assert.equal(readWidth("800", WORKER_RAIL), 800);
  const scale = 20 / 14;
  assert.equal(fitRail(0, 2000, SIDE.default, scale, WORKER_RAIL), Math.round(360 * scale));
});

test("a sidebar drag clamps to its own range and leaves the main its minimum", () => {
  assert.equal(fitSidebar(100, VP, 0), SIDE.min);
  assert.equal(fitSidebar(300, VP, 0), 300);
  assert.equal(fitSidebar(9999, VP, 0), SIDE.max);
  assert.equal(fitSidebar(9999, VP, 340), SIDE.max);
  const tight = 420 + SIDE.min + MAIN_MIN;
  assert.equal(fitSidebar(9999, tight, 420), SIDE.min);
});

test("a drag never collapses: under the minimum it lands on the floor", () => {
  assert.equal(fitSidebar(0, VP, 0), SIDE.min);
  assert.equal(fitSidebar(SIDE.min - 1, VP, 0), SIDE.min);
});

test("a rail drag clamps to its own range and reclaims full width when sidebar is offcanvas", () => {
  assert.equal(fitRail(100, VP, SIDE.default), RAIL.min);
  assert.equal(fitRail(400, VP, SIDE.default), 400);
  assert.equal(fitRail(9999, VP, SIDE.default), RAIL.max);
  // With the sidebar collapsed offcanvas (0px), the rail reclaims all sidebar slack.
  assert.equal(fitRail(9999, 980, 0), Math.min(RAIL.max, 980 - MAIN_MIN));
  const tight = SIDE.min + RAIL.min + MAIN_MIN;
  assert.equal(fitRail(9999, tight, SIDE.min), RAIL.min);
  // An impossible viewport protects the main before the column minimum.
  assert.equal(fitRail(9999, 700, SIDE.min), 700 - SIDE.min - MAIN_MIN);
});

test("a stored width no longer fitting is re-clamped", () => {
  assert.equal(fitSidebar(264, 800, 0), 264);
  assert.equal(fitRail(560, 1200, SIDE.default), Math.min(560, 1200 - SIDE.default - MAIN_MIN));
});

test("readWidth parses defensively", () => {
  assert.equal(readWidth(null, SIDE), SIDE.default);
  assert.equal(readWidth("", SIDE), SIDE.default);
  assert.equal(readWidth("  ", SIDE), SIDE.default);
  assert.equal(readWidth("abc", SIDE), SIDE.default);
  assert.equal(readWidth("264px", SIDE), SIDE.default);
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

test("the interface scale grows the column limits and the main's minimum", () => {
  const s = 20 / 14;
  assert.deepEqual(scaledColumn(SIDE, 1), { min: SIDE.min, max: SIDE.max, default: SIDE.default });
  assert.equal(fitSidebar(100, VP, 0, s), Math.round(SIDE.min * s));
  assert.equal(fitSidebar(9999, VP, 0, s), Math.round(SIDE.max * s));
  const tight = SIDE.min * s + RAIL.min * s + MAIN_MIN * s;
  assert.equal(fitRail(9999, tight, SIDE.min * s, s), Math.round(RAIL.min * s));
});

test("a stored pixel width re-clamps against the scaled range", () => {
  const s = 20 / 14;
  assert.equal(readWidth(String(SIDE.min), SIDE, s), Math.round(SIDE.min * s));
  assert.equal(readWidth("400", SIDE, s), 400);
  assert.equal(readWidth("99999", SIDE, s), Math.round(SIDE.max * s));
  assert.equal(readWidth("abc", SIDE, s), SIDE.default * s);
});
