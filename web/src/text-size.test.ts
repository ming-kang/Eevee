import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_TEXT_SIZE, parseTextSize, TEXT_SIZES } from "./text-size.ts";

test("parseTextSize 接受可选的字号，缺省或无效时回到默认 14", () => {
  assert.equal(DEFAULT_TEXT_SIZE, 14);
  for (const size of TEXT_SIZES) assert.equal(parseTextSize(String(size)), size);
  for (const stored of [null, "", "12", "17", "14.5", "abc"]) {
    assert.equal(parseTextSize(stored), DEFAULT_TEXT_SIZE);
  }
});
