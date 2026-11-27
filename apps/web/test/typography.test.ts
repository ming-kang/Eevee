import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CODE_SIZE_BOUNDS,
  clampSize,
  parseBoundedSize,
  readTypographySettings,
  UI_SIZE_BOUNDS,
} from "../src/lib/typography.ts";

test("parseBoundedSize and clampSize enforce typography bounds and defaults", () => {
  assert.equal(parseBoundedSize("14", UI_SIZE_BOUNDS), 14);
  assert.equal(parseBoundedSize("99", UI_SIZE_BOUNDS), UI_SIZE_BOUNDS.default);
  assert.equal(parseBoundedSize("abc", CODE_SIZE_BOUNDS), CODE_SIZE_BOUNDS.default);
  assert.equal(parseBoundedSize(null, CODE_SIZE_BOUNDS), CODE_SIZE_BOUNDS.default);

  assert.equal(clampSize(8, UI_SIZE_BOUNDS), UI_SIZE_BOUNDS.min);
  assert.equal(clampSize(30, UI_SIZE_BOUNDS), UI_SIZE_BOUNDS.max);
  assert.equal(clampSize(15.4, CODE_SIZE_BOUNDS), 15);
});

test("readTypographySettings reads stored sizes and falls back safely", () => {
  const map = new Map<string, string>([
    ["eevee-ui-size", "18"],
    ["eevee-code-size", "12"],
  ]);
  assert.deepEqual(readTypographySettings({ getItem: (key) => map.get(key) ?? null }), {
    uiSize: 18,
    codeSize: 12,
  });
});
