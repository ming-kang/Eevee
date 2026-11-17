import assert from "node:assert/strict";
import { test } from "node:test";
import { formatAnswer, initialDraft, initialOtherFlags, isComplete } from "./questions.ts";

const single = {
  items: [{ text: "用哪个数据库？", options: ["SQLite", "Postgres"], recommended: "SQLite" }],
};
const double = {
  items: [
    { text: "语言？", options: ["TS", "Go"] },
    { text: "部署？", options: [], recommended: "本机" },
  ],
};

test("推荐选项预先选中", () => {
  assert.deepEqual(initialDraft(single), ["SQLite"]);
  assert.deepEqual(initialDraft(double), ["", "本机"]);
});

test("初始“其他”状态在开放题或非预置选项时打开", () => {
  assert.deepEqual(initialOtherFlags(single, ["SQLite"]), [false]);
  assert.deepEqual(initialOtherFlags(single, ["DuckDB"]), [true]);
  assert.deepEqual(initialOtherFlags(double, ["TS", "本机"]), [false, true]);
});

test("每一问都有答案才算完成", () => {
  assert.equal(isComplete(initialDraft(double)), false);
  assert.equal(isComplete(["TS", "本机"]), true);
});

test("单问直接给答案，多问逐条编号", () => {
  assert.equal(formatAnswer(single, [" Postgres "]), "Postgres");
  assert.equal(formatAnswer(double, ["TS", "本机"]), "1. 语言？\n   TS\n2. 部署？\n   本机");
});
