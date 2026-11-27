import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  classifyColumn,
  slugifyHeading,
  tableToCsv,
  tableToMarkdown,
} from "../src/lib/markdown-utils.ts";
import { buildDisplayItems, type LiveDocView } from "../src/lib/transcript.ts";

const IDLE_LIVE: LiveDocView = {
  busy: false,
  turns: 0,
  partialText: "",
  partialThinking: "",
  partialTools: [],
  activeTools: [],
  compacting: false,
};

describe("markdown-utils", () => {
  it("classifies numeric, code, short, and prose columns", () => {
    assert.equal(classifyColumn(["12", "34.5%", "$0.04", "120ms", "—"]), "number");
    assert.equal(classifyColumn(["src/app.ts", "`foo_bar`", "GET/api"]), "code");
    assert.equal(classifyColumn(["Yes", "No", "Pending"]), "short");
    assert.equal(
      classifyColumn(["A longer descriptive sentence about architecture and layout"]),
      "text",
    );
  });

  it("serializes tables to escaped CSV and Markdown", () => {
    const csv = tableToCsv(["Name", "Note"], [["Alice", 'a, "b"\nc']]);
    assert.equal(csv, 'Name,Note\nAlice,"a, ""b""\nc"');

    const md = tableToMarkdown(["Key", "Val"], [["a|b", "42"]], ["left", "right"]);
    assert.equal(md, "| Key | Val |\n| --- | ---: |\n| a\\|b | 42 |");
  });

  it("creates deterministic slugs for headings including CJK", () => {
    assert.equal(slugifyHeading("Hello World!", 0), "h-0-hello-world");
    assert.equal(slugifyHeading("核心设计与架构", 2), "h-2-核心设计与架构");
    assert.equal(slugifyHeading("!!!", 3), "h-3-section");
  });
});

describe("assistant metadata extraction", () => {
  it("extracts model, usage, cost, and turn duration onto assistant display items", () => {
    const items = buildDisplayItems(
      [
        {
          id: 1,
          kind: "pi.user",
          model: [{ role: "user", content: "hello", timestamp: 1_000 }],
        },
        {
          id: 2,
          kind: "pi.assistant",
          model: [
            {
              role: "assistant",
              content: [{ type: "text", text: "world" }],
              timestamp: 4_500,
              provider: "anthropic",
              model: "claude-sonnet-4-5",
              usage: {
                input: 1200,
                output: 300,
                cacheRead: 800,
                cacheWrite: 100,
                totalTokens: 2400,
                cost: { total: 0.0123 },
              },
            },
          ],
        },
      ],
      IDLE_LIVE,
    );

    const assistant = items.find((i) => i.kind === "assistant");
    assert.ok(assistant && assistant.kind === "assistant");
    assert.equal(assistant.meta?.provider, "anthropic");
    assert.equal(assistant.meta?.model, "claude-sonnet-4-5");
    assert.equal(assistant.meta?.input, 1200);
    assert.equal(assistant.meta?.output, 300);
    assert.equal(assistant.meta?.cacheRead, 800);
    assert.equal(assistant.meta?.costTotal, 0.0123);
    assert.equal(assistant.meta?.durationMs, 3_500);
  });
});
