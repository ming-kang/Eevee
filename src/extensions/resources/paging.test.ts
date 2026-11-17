import assert from "node:assert/strict";
import { test } from "node:test";
import { continuation, pageList, pageText, TEXT_PAGE } from "./paging.ts";

test("文本分页给出下一页起点，最后一页没有", () => {
  const first = pageText("abcdef", 0, 4);
  assert.deepEqual(first, { text: "abcd", total: 6, nextOffset: 4 });
  assert.deepEqual(pageText("abcdef", 4, 4), { text: "ef", total: 6 });
});

test("单页长度不超过上限", () => {
  const page = pageText("x".repeat(20_000), 0, 100_000);
  assert.equal(page.text.length, TEXT_PAGE.max);
});

test("列表分页与续读提示", () => {
  const page = pageList([1, 2, 3], 0, 2);
  assert.deepEqual(page, { items: [1, 2], total: 3, nextOffset: 2 });
  assert.match(continuation("ticket://", page), /offset: 2/);
  assert.equal(continuation("ticket://", pageList([1], 0, 2)), "");
});
