import assert from "node:assert/strict";
import test from "node:test";
import { fontStack, readTextSize, resolveTheme, TEXT_SIZE } from "./typography.ts";

test("readTextSize accepts whole numbers from 12 to 20 and nothing else", () => {
  assert.deepEqual(TEXT_SIZE, { min: 12, max: 20, default: 14 });
  for (const size of [12, 14, 17, 20]) assert.equal(readTextSize(String(size)), size);
  assert.equal(readTextSize(" 15 "), 15);
  for (const value of [null, "", " ", "11", "21", "14.5", "abc", "1e1"]) {
    assert.equal(readTextSize(value), undefined, String(value));
  }
});

test("fontStack quotes each font name ahead of the built-in ones; empty uses the built-in", () => {
  assert.equal(fontStack(""), undefined);
  assert.equal(fontStack(" , "), undefined);
  assert.equal(fontStack("LXGW WenKai"), '"LXGW WenKai", var(--ev-font-base)');
  assert.equal(
    fontStack(" 'Source Han Sans SC' , \"HarmonyOS Sans\" "),
    '"Source Han Sans SC", "HarmonyOS Sans", var(--ev-font-base)',
  );
  // Generic families stay keywords; quoting would turn them into font names.
  assert.equal(fontStack("Georgia, Serif"), '"Georgia", serif, var(--ev-font-base)');
  // A quote or backslash in a name cannot end the string early.
  assert.equal(fontStack('A"B\\C'), '"A\\"B\\\\C", var(--ev-font-base)');
});

test("resolveTheme honors explicit preference and falls back to system for system", () => {
  assert.equal(resolveTheme("light", "dark"), "light");
  assert.equal(resolveTheme("dark", "light"), "dark");
  assert.equal(resolveTheme("system", "dark"), "dark");
  assert.equal(resolveTheme("system", "light"), "light");
});
