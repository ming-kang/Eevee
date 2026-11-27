import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isRailDrawerViewport,
  isSideDrawerViewport,
  MAIN_MIN_WIDTH,
  RAIL_DRAWER_BP,
  resolveEffectivePanelWidths,
  SIDE_DRAWER_BP,
} from "../src/lib/layout.ts";

test("drawer viewport breakpoints match shell container queries", () => {
  assert.equal(isSideDrawerViewport(SIDE_DRAWER_BP), true);
  assert.equal(isSideDrawerViewport(SIDE_DRAWER_BP + 1), false);
  assert.equal(isRailDrawerViewport(RAIL_DRAWER_BP), true);
  assert.equal(isRailDrawerViewport(RAIL_DRAWER_BP + 1), false);
});

test("resolveEffectivePanelWidths preserves minimum main width when both panels are docked", () => {
  const viewportWidth = 1240;
  const resolved = resolveEffectivePanelWidths({
    sideWidth: 380,
    railWidth: 560,
    sideCollapsed: false,
    railCollapsed: false,
    withRail: true,
    viewportWidth,
  });
  assert.ok(
    viewportWidth - resolved.effectiveSideWidth - resolved.effectiveRailWidth >= MAIN_MIN_WIDTH,
  );
  assert.ok(resolved.effectiveSideWidth >= 210);
  assert.ok(resolved.effectiveRailWidth >= 300);
});

test("resolveEffectivePanelWidths restores full preferred widths on wide viewports", () => {
  const resolved = resolveEffectivePanelWidths({
    sideWidth: 320,
    railWidth: 460,
    sideCollapsed: false,
    railCollapsed: false,
    withRail: true,
    viewportWidth: 1920,
  });
  assert.equal(resolved.effectiveSideWidth, 320);
  assert.equal(resolved.effectiveRailWidth, 460);
});
