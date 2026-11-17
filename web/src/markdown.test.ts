import assert from "node:assert/strict";
import { test } from "node:test";
import { parseMarkdown } from "./markdown.ts";

test("解析段落、列表、代码块、加粗与工单编号引用", () => {
  const blocks = parseMarkdown(
    [
      "已经安排好 **t2** 和 ticket://t4：",
      "",
      "- **t2** 运行 `sim/run.mjs`",
      "- 查看 **重点** 说明",
      "",
      "```ts",
      "const x = 1;",
      "```",
    ].join("\n"),
  );

  assert.equal(blocks.length, 3);
  assert.equal(blocks[0]?.kind, "paragraph");
  if (blocks[0]?.kind === "paragraph") {
    assert.deepEqual(blocks[0].inlines, [
      { kind: "text", text: "已经安排好 " },
      { kind: "tref", ticketId: "t2", label: "t2" },
      { kind: "text", text: " 和 " },
      { kind: "tref", ticketId: "t4", label: "ticket://t4" },
      { kind: "text", text: "：" },
    ]);
  }
  assert.equal(blocks[1]?.kind, "list");
  if (blocks[1]?.kind === "list") {
    assert.equal(blocks[1].ordered, false);
    assert.equal(blocks[1].items.length, 2);
  }
  assert.deepEqual(blocks[2], { kind: "code", lang: "ts", text: "const x = 1;" });
});
