import assert from "node:assert/strict";
import { test } from "node:test";
import { deepEqualJson, isRecord } from "../src/lib/object.ts";

test("isRecord accepts plain objects and rejects null, arrays, and primitives", () => {
  assert.equal(isRecord({}), true);
  assert.equal(isRecord({ a: 1 }), true);
  assert.equal(isRecord(null), false);
  assert.equal(isRecord(undefined), false);
  assert.equal(isRecord([]), false);
  assert.equal(isRecord([1, 2]), false);
  assert.equal(isRecord("str"), false);
  assert.equal(isRecord(42), false);
  assert.equal(isRecord(true), false);
});

test("deepEqualJson compares nested JSON values and ignores undefined object keys", () => {
  assert.equal(deepEqualJson(1, 1), true);
  assert.equal(deepEqualJson("a", "b"), false);
  assert.equal(deepEqualJson(null, undefined), false);
  assert.equal(deepEqualJson([1, { a: "x" }], [1, { a: "x" }]), true);
  assert.equal(deepEqualJson([1, 2], [1, 2, 3]), false);
  assert.equal(deepEqualJson({ a: 1, b: undefined }, { a: 1 }), true);
  assert.equal(deepEqualJson({ a: 1 }, { a: 1, b: undefined }), true);
  assert.equal(deepEqualJson({ a: 1 }, { a: 1, b: 2 }), false);
  assert.equal(deepEqualJson({ a: undefined }, { b: undefined }), true);
  assert.equal(deepEqualJson({ 0: "a" }, ["a"]), false);
  assert.equal(
    deepEqualJson(
      { nested: [{ k: [true, null] }], flag: false },
      { flag: false, nested: [{ k: [true, null] }] },
    ),
    true,
  );
});
