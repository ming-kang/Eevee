import assert from "node:assert/strict";
import { test } from "node:test";
import { type Block, markdownParser, parseMarkdown } from "./markdown.ts";

const text = (value: string) => ({ type: "text" as const, text: value });
const ticket = (id: string, label = id) => ({ type: "ticket" as const, ticketId: id, label });

test("headings render as headings, not as paragraphs with hashes", () => {
  assert.deepEqual(parseMarkdown("# Model catalog overview\n\nBody text\n\n### Details"), [
    { type: "heading", level: 1, children: [text("Model catalog overview")] },
    { type: "paragraph", children: [text("Body text")] },
    { type: "heading", level: 3, children: [text("Details")] },
  ]);
});

test("ticket ids become references, except in code and links", () => {
  assert.deepEqual(
    parseMarkdown(
      "already arranged **t2** and ticket://t4; `t5` [t6](https://x.dev) [run the sim](ticket://t7)\nsecond line",
    ),
    [
      {
        type: "paragraph",
        children: [
          text("already arranged "),
          ticket("t2"),
          text(" and "),
          ticket("t4"),
          text("; "),
          { type: "code", text: "t5" },
          text(" "),
          { type: "link", href: "https://x.dev", children: [text("t6")] },
          text(" "),
          ticket("t7", "run the sim"),
          { type: "break" },
          text("second line"),
        ],
      },
    ],
  );
});

test("ids inside other addresses and words are left alone", () => {
  assert.deepEqual(
    parseMarkdown("Full report: report://t2#1, job job://j3, model gpt4, see t5 for details"),
    [
      {
        type: "paragraph",
        children: [
          text("Full report: report://t2#1, job job://j3, model gpt4, see "),
          ticket("t5"),
          text(" for details"),
        ],
      },
    ],
  );
});

test("only web links are kept; HTML shows as literal text", () => {
  assert.deepEqual(
    parseMarkdown("See https://a.dev and [local file](file:///etc/passwd) <b>x</b>"),
    [
      {
        type: "paragraph",
        children: [
          text("See "),
          { type: "link", href: "https://a.dev", children: [text("https://a.dev")] },
          text(" and local file <b>x</b>"),
        ],
      },
    ],
  );
});

test("lists, tasks, quotes, tables, rules and inline styles", () => {
  const blocks = parseMarkdown(
    [
      "- [ ] todo",
      "- [x] *done* ~~finished~~",
      "  1. subitem",
      "",
      "> quote",
      "",
      "3. step three",
      "",
      "| Name | Count |",
      "|:-|-:|",
      "| a | `2` |",
      "",
      "---",
      "Note **'A'**.",
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
        { checked: false, children: [{ type: "paragraph", children: [text("todo")] }] },
        {
          checked: true,
          children: [
            {
              type: "paragraph",
              children: [
                { type: "em", children: [text("done")] },
                text(" "),
                { type: "del", children: [text("finished")] },
              ],
            },
            {
              type: "list",
              ordered: true,
              items: [{ children: [{ type: "paragraph", children: [text("subitem")] }] }],
            },
          ],
        },
      ],
    },
    { type: "quote", children: [{ type: "paragraph", children: [text("quote")] }] },
    {
      type: "list",
      ordered: true,
      start: 3,
      items: [{ children: [{ type: "paragraph", children: [text("step three")] }] }],
    },
    {
      type: "table",
      head: [
        { align: "left", children: [text("Name")] },
        { align: "right", children: [text("Count")] },
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
      children: [text("Note "), { type: "strong", children: [text("'A'")] }, text(".")],
    },
    { type: "code", language: "ts", code: "const x = 1;" },
  ] satisfies Block[]);
});

test("streaming output completes unclosed syntax and shows a caret at the end", () => {
  const parse = markdownParser();
  const caret = { type: "caret" };
  assert.deepEqual(parse("Note **key", true), [
    {
      type: "paragraph",
      children: [text("Note "), { type: "strong", children: [text("key")] }, caret],
    },
  ]);
  assert.deepEqual(parse("Note **key**\n\n```ts\nconst a", true), [
    { type: "paragraph", children: [text("Note "), { type: "strong", children: [text("key")] }] },
    { type: "code", language: "ts", code: "const a" },
    { type: "paragraph", children: [caret] },
  ]);
  assert.deepEqual(parse("", true), [{ type: "paragraph", children: [caret] }]);
  assert.deepEqual(parse("Note **key"), [{ type: "paragraph", children: [text("Note **key")] }]);
});
