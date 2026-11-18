import assert from "node:assert/strict";
import { test } from "node:test";
import { type Block, markdownParser, parseMarkdown } from "./markdown.ts";

const text = (value: string) => ({ type: "text" as const, text: value });
const ticket = (id: string, label = id) => ({ type: "ticket" as const, ticketId: id, label });

test("标题按标题渲染，而不是带井号的段落", () => {
  assert.deepEqual(parseMarkdown("# 模型目录说明\n\n正文\n\n### 细节"), [
    { type: "heading", level: 1, children: [text("模型目录说明")] },
    { type: "paragraph", children: [text("正文")] },
    { type: "heading", level: 3, children: [text("细节")] },
  ]);
});

test("工单编号变成引用，代码和链接里的除外", () => {
  assert.deepEqual(
    parseMarkdown(
      "已经安排好 **t2** 和 ticket://t4：`t5` [t6](https://x.dev) [运行仿真](ticket://t7)\n第二行",
    ),
    [
      {
        type: "paragraph",
        children: [
          text("已经安排好 "),
          ticket("t2"),
          text(" 和 "),
          ticket("t4"),
          text("："),
          { type: "code", text: "t5" },
          text(" "),
          { type: "link", href: "https://x.dev", children: [text("t6")] },
          text(" "),
          ticket("t7", "运行仿真"),
          { type: "break" },
          text("第二行"),
        ],
      },
    ],
  );
});

test("其他地址和单词里的编号保持原样", () => {
  assert.deepEqual(parseMarkdown("完整报告：report://t2#1，作业 job://j3，模型 gpt4，见 t5。"), [
    {
      type: "paragraph",
      children: [
        text("完整报告：report://t2#1，作业 job://j3，模型 gpt4，见 "),
        ticket("t5"),
        text("。"),
      ],
    },
  ]);
});

test("只保留网页链接，HTML 原样显示为文字", () => {
  assert.deepEqual(parseMarkdown("见 https://a.dev 与 [本地](file:///etc/passwd) <b>x</b>"), [
    {
      type: "paragraph",
      children: [
        text("见 "),
        { type: "link", href: "https://a.dev", children: [text("https://a.dev")] },
        text(" 与 本地 <b>x</b>"),
      ],
    },
  ]);
});

test("列表、任务、引用、表格、分割线和行内样式", () => {
  const blocks = parseMarkdown(
    [
      "- [ ] 待办",
      "- [x] *已* ~~完成~~",
      "  1. 子项",
      "",
      "> 引用",
      "",
      "3. 第三步",
      "",
      "| 名称 | 数量 |",
      "|:-|-:|",
      "| a | `2` |",
      "",
      "---",
      "说明**「A」**。",
      "",
      "```ts",
      "const x = 1;",
      "```",
    ].join("\n"),
  );
  assert.deepEqual(blocks, [
    {
      type: "list",
      ordered: false,
      items: [
        { checked: false, children: [{ type: "paragraph", children: [text("待办")] }] },
        {
          checked: true,
          children: [
            {
              type: "paragraph",
              children: [
                { type: "em", children: [text("已")] },
                text(" "),
                { type: "del", children: [text("完成")] },
              ],
            },
            {
              type: "list",
              ordered: true,
              items: [{ children: [{ type: "paragraph", children: [text("子项")] }] }],
            },
          ],
        },
      ],
    },
    { type: "quote", children: [{ type: "paragraph", children: [text("引用")] }] },
    {
      type: "list",
      ordered: true,
      start: 3,
      items: [{ children: [{ type: "paragraph", children: [text("第三步")] }] }],
    },
    {
      type: "table",
      head: [
        { align: "left", children: [text("名称")] },
        { align: "right", children: [text("数量")] },
      ],
      rows: [
        [
          { align: "left", children: [text("a")] },
          { align: "right", children: [{ type: "code", text: "2" }] },
        ],
      ],
    },
    { type: "rule" },
    {
      type: "paragraph",
      children: [text("说明"), { type: "strong", children: [text("「A」")] }, text("。")],
    },
    { type: "code", language: "ts", code: "const x = 1;" },
  ] satisfies Block[]);
});

test("流式输出时补全未闭合的语法，并在末尾显示光标", () => {
  const parse = markdownParser();
  const caret = { type: "caret" };
  assert.deepEqual(parse("看 **重点", true), [
    {
      type: "paragraph",
      children: [text("看 "), { type: "strong", children: [text("重点")] }, caret],
    },
  ]);
  assert.deepEqual(parse("看 **重点**\n\n```ts\nconst a", true), [
    { type: "paragraph", children: [text("看 "), { type: "strong", children: [text("重点")] }] },
    { type: "code", language: "ts", code: "const a" },
    { type: "paragraph", children: [caret] },
  ]);
  assert.deepEqual(parse("", true), [{ type: "paragraph", children: [caret] }]);
  assert.deepEqual(parse("看 **重点"), [{ type: "paragraph", children: [text("看 **重点")] }]);
});
