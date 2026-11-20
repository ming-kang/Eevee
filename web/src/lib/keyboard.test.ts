import assert from "node:assert/strict";
import { test } from "node:test";
import { doublePressed, listStep, tabStep } from "./keyboard.ts";

test("tabStep moves between tabs with the arrow keys, Home and End; other keys are ignored", () => {
  assert.equal(tabStep("ArrowRight", 0, 3), 1);
  assert.equal(tabStep("ArrowRight", 2, 3), 0);
  assert.equal(tabStep("ArrowLeft", 0, 3), 2);
  assert.equal(tabStep("Home", 2, 3), 0);
  assert.equal(tabStep("End", 0, 3), 2);
  assert.equal(tabStep("Enter", 1, 3), undefined);
  assert.equal(tabStep("ArrowRight", 0, 0), undefined);
});

test("listStep moves between menu rows with the up and down arrows; Home and End jump to the ends", () => {
  assert.equal(listStep("ArrowDown", 0, 3), 1);
  assert.equal(listStep("ArrowDown", 2, 3), 0);
  assert.equal(listStep("ArrowUp", 0, 3), 2);
  assert.equal(listStep("Home", 2, 3), 0);
  assert.equal(listStep("End", 0, 3), 2);
  assert.equal(listStep("ArrowRight", 1, 3), undefined);
  assert.equal(listStep("ArrowDown", 0, 0), undefined);
});

test("doublePressed only fires within the window", () => {
  assert.equal(doublePressed(1000, 1400), true);
  assert.equal(doublePressed(1000, 1500), true);
  assert.equal(doublePressed(1000, 1501), false);
  assert.equal(doublePressed(undefined, 1000), false);
  assert.equal(doublePressed(1000, 1000), true);
});
