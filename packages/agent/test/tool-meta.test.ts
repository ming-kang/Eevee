import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { InlineCodemodeSandbox, loadQuickJSWasm } from "@earendil-works/pi-codemode";
import { defineTool } from "@earendil-works/pi-durable";
import { obj, str } from "@earendil-works/pi-schema";
import {
  createBaseExtension,
  createCodemodeExtension,
  createCodingToolsExtension,
  createReadonlyToolsExtension,
  createTasksExtension,
  createToolSearchExtension,
  getToolPromptMeta,
  renderRulesSection,
  renderToolsSection,
  resolveToolPromptMeta,
  withToolPromptMeta,
} from "../src/index.ts";
import { createTestHarness } from "./harness.ts";

function dummyTool(name: string) {
  return defineTool({
    name,
    description: `Run ${name}`,
    parameters: obj({ input: str() }),
    execute: async () => ({ output: [{ type: "text" as const, text: "ok" }] }),
  });
}

test("withToolPromptMeta attaches metadata via WeakMap without mutating tools and merges cleanly", () => {
  const frozen = Object.freeze(dummyTool("frozen_tool"));
  const ownKeysBefore = Reflect.ownKeys(frozen);

  const returned = withToolPromptMeta(frozen, {
    promptSnippet: "Original snippet",
    promptGuidelines: ["Rule one", "Rule two"],
  });
  assert.equal(returned, frozen);
  assert.deepEqual(Reflect.ownKeys(frozen), ownKeysBefore);
  assert.equal("promptSnippet" in frozen, false);
  assert.equal("promptGuidelines" in frozen, false);

  assert.deepEqual(getToolPromptMeta(frozen), {
    promptSnippet: "Original snippet",
    promptGuidelines: ["Rule one", "Rule two"],
  });

  withToolPromptMeta(frozen, {
    promptSnippet: "Updated snippet",
    promptGuidelines: ["Rule two", "Rule three"],
  });
  assert.deepEqual(getToolPromptMeta(frozen), {
    promptSnippet: "Updated snippet",
    promptGuidelines: ["Rule one", "Rule two", "Rule three"],
  });

  const wrapped = dummyTool("frozen_tool");
  withToolPromptMeta(wrapped, { promptGuidelines: ["Rule four"] }, frozen);
  assert.deepEqual(getToolPromptMeta(wrapped), {
    promptSnippet: "Updated snippet",
    promptGuidelines: ["Rule one", "Rule two", "Rule three", "Rule four"],
  });
});

test("Router readonly tools produce accurate tools/rules without false ls claims", () => {
  const readonly = createReadonlyToolsExtension();
  const tools = readonly.tools ?? [];

  const toolsText = renderToolsSection(tools);
  assert.ok(toolsText);
  assert.ok(toolsText.includes("- read:"));
  assert.ok(toolsText.includes("- ls:"));
  assert.ok(toolsText.includes("- find:"));
  assert.ok(toolsText.includes("- grep:"));

  const rulesText = renderRulesSection(tools);
  assert.ok(rulesText);
  assert.ok(rulesText.includes("'/' suffix for directories"));
  assert.equal(rulesText.toLowerCase().includes("shows sizes"), false);
  assert.equal(rulesText.toLowerCase().includes("entry kinds"), false);
  assert.ok(rulesText.includes("instead of cat or sed"));
  assert.ok(rulesText.includes("offset and limit"));
  assert.ok(rulesText.includes(".gitignore"));
  assert.equal(rulesText.includes("Use bash for file operations"), false);
});

test("Worker coding tools + tasks + PowerShell produce accurate wrapped bash, PowerShell, and tasks rules", async () => {
  const th = await createTestHarness({
    extensions: [
      createBaseExtension({ workspaces: [] }),
      createCodingToolsExtension({ powerShell: true }),
      createTasksExtension(),
      createToolSearchExtension(),
    ],
  });
  try {
    const conversation = await th.createConversation();
    const resolved = await conversation.agent(BACKGROUND_CONTEXT);

    const bash = resolved.tools.find((tool) => tool.name === "bash");
    assert.ok(bash);
    const bashMeta = resolveToolPromptMeta(bash, resolved.extensions);
    assert.equal(bashMeta?.promptSnippet, "Execute bash commands, foreground or background");

    const toolsText = renderToolsSection(resolved.tools, resolved.extensions);
    assert.ok(toolsText?.includes("- bash: Execute bash commands, foreground or background"));
    assert.ok(toolsText?.includes("- powershell: Execute PowerShell commands"));
    assert.ok(toolsText?.includes("- tasks: List, read, or stop background tasks"));
    assert.ok(toolsText?.includes("- tool_search:"));

    const rulesText = renderRulesSection(resolved.tools, undefined, resolved.extensions);
    assert.ok(rulesText);
    assert.ok(
      rulesText.includes(
        "Use bash or PowerShell for file operations like listing, searching, and finding files",
      ),
    );
    assert.ok(rulesText.includes("/dev/null"));
    assert.ok(rulesText.includes("background: true"));
    assert.ok(rulesText.includes("handoff timeout"));
    assert.ok(rulesText.includes("$null"));
    assert.ok(rulesText.includes("batch edits to one file in a single call"));
    assert.ok(rulesText.includes("write only for new files or complete rewrites"));
    assert.ok(rulesText.includes("tasks cannot start work"));
    assert.ok(rulesText.includes("Never poll tasks"));
    assert.ok(rulesText.includes("sinceBytes"));
    assert.ok(rulesText.includes("Be concise in your responses"));
    assert.ok(rulesText.includes("Show file paths clearly when working with files"));

    // Works directly on resolved.tools even without passing extensions
    const directRules = renderRulesSection(resolved.tools);
    assert.ok(directRules?.includes("/dev/null"));
    assert.ok(directRules?.includes("background: true"));
  } finally {
    await th.cleanup();
  }
});

test("codemode section propagates callable tool promptGuidelines without mutating original tools", async () => {
  const sandbox = new InlineCodemodeSandbox({ wasm: loadQuickJSWasm() });
  const readonly = createReadonlyToolsExtension();
  const codemode = createCodemodeExtension({ sandbox, models: false });
  const th = await createTestHarness({ extensions: [readonly, codemode] });
  try {
    const lsOriginal = readonly.tools?.find((tool) => tool.name === "ls");
    assert.ok(lsOriginal);
    const originalDescription = lsOriginal.description;

    const conversation = await th.createConversation();
    const resolved = await conversation.agent(BACKGROUND_CONTEXT);

    const codemodeTool = resolved.tools.find((tool) => tool.name === "codemode");
    assert.ok(codemodeTool);
    const codemodeRules = renderRulesSection([codemodeTool]);
    assert.ok(codemodeRules?.includes("Promise.allSettled"));

    const codemodeSection = resolved.sections.find((entry) => entry.key === "codemode");
    assert.ok(codemodeSection);
    const rendered = await codemodeSection.render(
      {
        conversationId: conversation.id,
        agent: resolved,
        env: undefined,
        shown: {},
        read: {} as never,
      },
      BACKGROUND_CONTEXT,
    );

    assert.ok(rendered);
    assert.ok(rendered.includes("Use read to inspect files before changing them"));
    assert.ok(rendered.includes("'/' suffix for directories"));
    assert.equal(lsOriginal.description, originalDescription);
  } finally {
    await th.cleanup();
    await sandbox.close();
  }
});
