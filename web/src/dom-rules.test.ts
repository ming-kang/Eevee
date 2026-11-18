import assert from "node:assert/strict";
import { test } from "node:test";
import { isAtEnd, modalityOfKey, pillGeometry } from "./dom-rules.ts";

test("the pill stands over the chosen button", () => {
  const geometry = pillGeometry([
    { left: 2, width: 60, chosen: false },
    { left: 62, width: 48, chosen: true },
    { left: 110, width: 52, chosen: false },
  ]);
  assert.deepEqual(geometry, { x: 62, width: 48 });
});

test("no pill when nothing is chosen", () => {
  assert.equal(pillGeometry([{ left: 2, width: 60, chosen: false }]), undefined);
  assert.equal(pillGeometry([]), undefined);
});

test("a scroller at or near its bottom follows the end", () => {
  assert.equal(isAtEnd({ scrollTop: 760, scrollHeight: 1000, clientHeight: 240 }), true);
  assert.equal(isAtEnd({ scrollTop: 754, scrollHeight: 1000, clientHeight: 240 }), true);
  assert.equal(isAtEnd({ scrollTop: 400, scrollHeight: 1000, clientHeight: 240 }), false);
  assert.equal(isAtEnd({ scrollTop: 0, scrollHeight: 100, clientHeight: 240 }), true);
});

test("only keys that move focus switch rings on; typing, shortcuts and Enter say nothing", () => {
  const plain = { modifier: false, inTextEntry: false };
  assert.equal(modalityOfKey("Tab", plain), "keyboard");
  assert.equal(modalityOfKey("ArrowDown", plain), "keyboard");
  assert.equal(modalityOfKey("Enter", plain), undefined);
  assert.equal(modalityOfKey("Escape", plain), undefined);
  assert.equal(modalityOfKey("k", { modifier: true, inTextEntry: false }), undefined);
  assert.equal(modalityOfKey("Tab", { modifier: true, inTextEntry: false }), undefined);
  assert.equal(modalityOfKey("ArrowLeft", { modifier: false, inTextEntry: true }), undefined);
  assert.equal(modalityOfKey("Tab", { modifier: false, inTextEntry: true }), "keyboard");
});
