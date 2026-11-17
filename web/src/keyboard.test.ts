import assert from "node:assert/strict";
import { test } from "node:test";
import { tabStep } from "./keyboard.ts";

test("tabStep 用方向键、Home、End 在标签间循环移动，其他键不处理", () => {
  assert.equal(tabStep("ArrowRight", 0, 3), 1);
  assert.equal(tabStep("ArrowRight", 2, 3), 0);
  assert.equal(tabStep("ArrowLeft", 0, 3), 2);
  assert.equal(tabStep("Home", 2, 3), 0);
  assert.equal(tabStep("End", 0, 3), 2);
  assert.equal(tabStep("Enter", 1, 3), undefined);
  assert.equal(tabStep("ArrowRight", 0, 0), undefined);
});
