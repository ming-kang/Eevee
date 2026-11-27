import assert from "node:assert/strict";
import { test } from "node:test";
import { computePopoverPosition } from "../src/lib/floating.ts";

test("computePopoverPosition keeps preferred placement when viewport has enough room", () => {
  const down = computePopoverPosition({
    anchor: { top: 120, bottom: 156, left: 200, right: 420, width: 220, height: 36 },
    viewport: { width: 1280, height: 800 },
    preferredPlacement: "down",
    preferredAlign: "start",
    popoverWidth: 380,
    estimatedHeight: 260,
  });
  assert.equal(down.placement, "down");
  assert.equal(down.top, 162);
  assert.equal(down.left, 200);
  assert.equal(down.width, 380);
  assert.ok(down.maxHeight >= 600);

  const up = computePopoverPosition({
    anchor: { top: 720, bottom: 752, left: 300, right: 480, width: 180, height: 32 },
    viewport: { width: 1280, height: 800 },
    preferredPlacement: "up",
    preferredAlign: "start",
    popoverWidth: 380,
    estimatedHeight: 260,
  });
  assert.equal(up.placement, "up");
  assert.equal(up.bottom, 86);
  assert.equal(up.left, 300);
  assert.ok(up.maxHeight >= 600);
});

test("computePopoverPosition flips vertically when preferred direction lacks space", () => {
  const flippedUp = computePopoverPosition({
    anchor: { top: 680, bottom: 716, left: 100, right: 320, width: 220, height: 36 },
    viewport: { width: 1280, height: 760 },
    preferredPlacement: "down",
    preferredAlign: "start",
    popoverWidth: 380,
    estimatedHeight: 260,
  });
  assert.equal(flippedUp.placement, "up");
  assert.equal(flippedUp.bottom, 86);
  assert.ok(flippedUp.maxHeight >= 600);

  const flippedDown = computePopoverPosition({
    anchor: { top: 48, bottom: 80, left: 100, right: 300, width: 200, height: 32 },
    viewport: { width: 1280, height: 760 },
    preferredPlacement: "up",
    preferredAlign: "start",
    popoverWidth: 380,
    estimatedHeight: 260,
  });
  assert.equal(flippedDown.placement, "down");
  assert.equal(flippedDown.top, 86);
  assert.ok(flippedDown.maxHeight >= 600);
});

test("computePopoverPosition clamps horizontally within narrow and edge-aligned viewports", () => {
  const clampedRight = computePopoverPosition({
    anchor: { top: 100, bottom: 136, left: 1050, right: 1240, width: 190, height: 36 },
    viewport: { width: 1280, height: 800 },
    preferredPlacement: "down",
    preferredAlign: "start",
    popoverWidth: 380,
    estimatedHeight: 260,
  });
  assert.equal(clampedRight.left + clampedRight.width, 1280 - 12);

  const clampedLeft = computePopoverPosition({
    anchor: { top: 100, bottom: 136, left: 20, right: 140, width: 120, height: 36 },
    viewport: { width: 1280, height: 800 },
    preferredPlacement: "down",
    preferredAlign: "end",
    popoverWidth: 380,
    estimatedHeight: 260,
  });
  assert.equal(clampedLeft.left, 12);

  const narrowMobile = computePopoverPosition({
    anchor: { top: 200, bottom: 236, left: 16, right: 344, width: 328, height: 36 },
    viewport: { width: 360, height: 640 },
    preferredPlacement: "down",
    preferredAlign: "start",
    popoverWidth: 380,
    estimatedHeight: 260,
  });
  assert.equal(narrowMobile.width, 336);
  assert.equal(narrowMobile.left, 12);
});
