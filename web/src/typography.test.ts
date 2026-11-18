import assert from "node:assert/strict";
import test from "node:test";
import { fontStack, readTextSize, TEXT_SIZE } from "./typography.ts";

test("readTextSize 接受 12 到 20 的整数，其余都不算", () => {
  assert.deepEqual(TEXT_SIZE, { min: 12, max: 20, default: 14 });
  for (const size of [12, 14, 17, 20]) assert.equal(readTextSize(String(size)), size);
  assert.equal(readTextSize(" 15 "), 15);
  for (const value of [null, "", " ", "11", "21", "14.5", "abc", "1e1"]) {
    assert.equal(readTextSize(value), undefined, String(value));
  }
});

test("fontStack 给每个字体名加引号，排在自带字体前面；留空用自带字体", () => {
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
