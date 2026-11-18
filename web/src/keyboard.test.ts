import assert from "node:assert/strict";
import { test } from "node:test";
import { listStep, tabStep } from "./keyboard.ts";

test("tabStep 用方向键、Home、End 在标签间循环移动，其他键不处理", () => {
  assert.equal(tabStep("ArrowRight", 0, 3), 1);
  assert.equal(tabStep("ArrowRight", 2, 3), 0);
  assert.equal(tabStep("ArrowLeft", 0, 3), 2);
  assert.equal(tabStep("Home", 2, 3), 0);
  assert.equal(tabStep("End", 0, 3), 2);
  assert.equal(tabStep("Enter", 1, 3), undefined);
  assert.equal(tabStep("ArrowRight", 0, 0), undefined);
});

test("listStep 用上下方向键在菜单行间循环移动，Home、End 到两头", () => {
  assert.equal(listStep("ArrowDown", 0, 3), 1);
  assert.equal(listStep("ArrowDown", 2, 3), 0);
  assert.equal(listStep("ArrowUp", 0, 3), 2);
  assert.equal(listStep("Home", 2, 3), 0);
  assert.equal(listStep("End", 0, 3), 2);
  assert.equal(listStep("ArrowRight", 1, 3), undefined);
  assert.equal(listStep("ArrowDown", 0, 0), undefined);
});
